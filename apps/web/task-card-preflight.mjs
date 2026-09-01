import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { delimiter, join } from "node:path";

import {
  BALANCED_BUDGET_LIMITS,
  BALANCED_TIMING_LIMITS,
} from "../../packages/contracts/dist/index.js";
import {
  resolveRuntimeEnvironment,
  runtimeEnvironmentOptions,
} from "./runtime-environment.mjs";
import { normalizeAdapterContainment } from "./adapter-containment.mjs";
import { normalizeTaskCard } from "./task-card.mjs";

const WORKFLOW_MODES = new Set(["overnight", "balanced"]);
const OVERNIGHT_STRATEGIES = new Set(["convergent", "continuous-improvement"]);

function issue(severity, code, message, path = null) {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

function stableTaskText(task) {
  return `${JSON.stringify(task)}\n`;
}

async function findExecutable(command, environment) {
  if (!command) return null;
  const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
    ? [command]
    : String(environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking PATH without invoking a shell or exposing environment values.
    }
  }
  return null;
}

function validateBalancedRecord(value, limits, path, issues) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(issue("error", "preflight.balanced_config", `${path} must be an object.`, path));
    return false;
  }
  let valid = true;
  for (const [key, range] of Object.entries(limits)) {
    const candidate = value[key];
    if (!Number.isSafeInteger(candidate) || candidate < range.min || candidate > range.max) {
      issues.push(issue(
        "error",
        "preflight.balanced_config",
        `${path}.${key} must be an integer from ${range.min} to ${range.max}.`,
        `${path}.${key}`,
      ));
      valid = false;
    }
  }
  return valid;
}

export async function preflightTaskCard(input, options = {}) {
  const issues = [];
  const checks = [];
  let normalized = null;

  const workflowContract = options.workflowContract;
  if (workflowContract) {
    if (!workflowContract.available) {
      issues.push(issue(
        "error",
        "preflight.workflow_contract_unavailable",
        "Embedded Workflow Core is unavailable; delegated execution cannot start.",
        "workflowContract",
      ));
      checks.push(check("workflow-contract", "Workflow Contract", "failed", "内置核心缺失"));
    } else if (!workflowContract.compatible) {
      issues.push(issue(
        "error",
        "preflight.workflow_contract_incompatible",
        `AI Coding Workflow Contract ${workflowContract.contractVersion ?? "unknown"} is incompatible.`,
        "workflowContract",
      ));
      checks.push(check("workflow-contract", "Workflow Contract", "failed", "版本、Schema 或协议投影不兼容"));
    } else {
      const drifted = workflowContract.health === "drift-detected";
      if (drifted) {
        issues.push(issue(
          "warning",
          "preflight.workflow_contract_drift",
          "Embedded Workflow Contract is compatible, but the runtime safety projection has drifted.",
          "workflowContract",
        ));
      }
      checks.push(check(
        "workflow-contract",
        "Workflow Contract",
        drifted ? "warning" : "passed",
        `v${workflowContract.contractVersion} · ${drifted ? "存在运行投影漂移" : "协议一致"}`,
      ));
    }
  }

  try {
    normalized = normalizeTaskCard(input?.task);
    checks.push(check(
      "task-card",
      "Task Card",
      "passed",
      `${normalized.task.id} · task-card-v1`,
    ));
  } catch (error) {
    issues.push(issue(
      "error",
      error?.code ?? "task.invalid",
      error?.message ?? "Task Card is invalid.",
      error?.path,
    ));
    checks.push(check("task-card", "Task Card", "failed", error?.message ?? "Invalid task."));
  }

  const workflowMode = typeof input?.workflowMode === "string" ? input.workflowMode : "";
  if (!WORKFLOW_MODES.has(workflowMode)) {
    issues.push(issue(
      "error",
      "preflight.workflow_mode",
      "Workflow mode must be Overnight or Balanced.",
      "workflowMode",
    ));
    checks.push(check("workflow-mode", "工作流模式", "failed", "请选择 Overnight 或 Balanced。"));
  } else {
    checks.push(check(
      "workflow-mode",
      "工作流模式",
      "passed",
      workflowMode === "overnight" ? "Overnight 外部监控" : "Balanced 调优时间窗口",
    ));
  }

  const configuredAdapters = options.adapters ?? [];
  const adapterId = typeof input?.adapterId === "string" ? input.adapterId.trim() : "";
  const adapter = configuredAdapters.find((candidate) => candidate.id === adapterId);
  if (!adapter) {
    issues.push(issue(
      "error",
      "preflight.adapter",
      adapterId ? `Adapter '${adapterId}' is not available.` : "A downstream adapter is required.",
      "adapterId",
    ));
    checks.push(check("adapter", "下游 Adapter", "failed", adapterId || "尚未选择"));
  } else {
    checks.push(check("adapter", "下游 Adapter", "passed", adapter.displayName ?? adapter.id));
    if (adapter.command) {
      const executable = await findExecutable(adapter.command, options.environment ?? process.env);
      if (!executable) {
        issues.push(issue(
          "error",
          "preflight.adapter_command_missing",
          `Downstream command '${adapter.command}' is not executable in the control-plane PATH.`,
          "adapterId",
        ));
        checks.push(check("adapter-command", "下游 CLI", "failed", `${adapter.command} 不可执行`));
      } else {
        checks.push(check("adapter-command", "下游 CLI", "passed", adapter.command));
      }
    }
  }

  let runtimeEnvironment = null;
  try {
    runtimeEnvironment = resolveRuntimeEnvironment(input?.runtimeEnvironment, {
      environment: options.environment ?? process.env,
      providerEnvironmentPrefixes: adapter?.providerEnvironmentPrefixes ?? [],
      requiresNetwork: adapter?.requiresNetwork !== false,
    });
    if (runtimeEnvironment.evidence.hostHandoffRequired) {
      issues.push(issue(
        "error",
        "preflight.host_handoff_required",
        "Current process is network-restricted; run the control plane from an authorized host terminal before downstream dispatch.",
        "runtimeEnvironment.executionEnvironment",
      ));
      checks.push(check(
        "execution-environment",
        "执行环境",
        "failed",
        "受限沙箱无法证明下游不可用，需要宿主机接管",
      ));
    } else {
      checks.push(check(
        "execution-environment",
        "执行环境",
        "passed",
        `${runtimeEnvironment.evidence.executionEnvironmentResolved} · network available`,
      ));
    }
    checks.push(check(
      "proxy",
      "网络代理",
      "passed",
      runtimeEnvironment.evidence.proxyMode === "direct"
        ? "直连；下游进程不会继承代理变量"
        : `继承代理；检测到 ${runtimeEnvironment.evidence.effectiveProxyVariables.length} 个代理变量`,
    ));
    checks.push(check(
      "environment-isolation",
      "进程环境隔离",
      "passed",
      runtimeEnvironment.evidence.isolationMode === "provider-scoped"
        ? "仅传递基础环境与供应商范围变量"
        : "兼容模式：继承全部环境变量",
    ));
    const containment = normalizeAdapterContainment(adapter ?? {}, { requireExtractor: false });
    if (containment.write !== "exact-paths") {
      issues.push(issue(
        "warning",
        "preflight.filesystem_isolation_advisory",
        "This adapter does not yet enforce exact write paths with an OS filesystem sandbox; scope is still verified after execution.",
        "runtimeEnvironment",
      ));
      checks.push(check(
        "write-containment",
        "写入隔离",
        "warning",
        containment.write === "post-run-audit"
          ? "运行后审计；尚未强制 exact write paths"
          : "未提供写入隔离或运行后审计",
      ));
    } else {
      checks.push(check("write-containment", "写入隔离", "passed", "exact-paths"));
    }
    if (containment.read === "exact-paths") {
      checks.push(check("read-containment", "读取隔离", "passed", "exact-paths"));
    } else {
      const partial = containment.read === "partial-event-audit";
      issues.push(issue(
        "warning",
        partial ? "preflight.read_containment_partial" : "preflight.read_containment_unsupported",
        partial
          ? "Only explicit adapter read events are audited; Bash, MCP, language-server, and other reads may remain invisible."
          : "This adapter does not enforce or audit read paths.",
        "runtimeEnvironment",
      ));
      checks.push(check(
        "read-containment",
        "读取隔离",
        "warning",
        partial ? "部分事件审计；不能证明完整读取边界" : "不支持；不会将缺失审计显示为 0",
      ));
    }
  } catch (error) {
    issues.push(issue(
      "error",
      error?.code ?? "preflight.runtime_environment",
      error?.message ?? "Runtime environment configuration is invalid.",
      error?.details?.path ?? "runtimeEnvironment",
    ));
    checks.push(check("execution-environment", "执行环境", "failed", error.message));
  }

  const rawWorktree = typeof input?.worktree === "string" ? input.worktree.trim() : "";
  let worktree = rawWorktree;
  if (!rawWorktree || !isAbsolute(rawWorktree)) {
    issues.push(issue(
      "error",
      "preflight.worktree",
      "Worktree must be an absolute path.",
      "worktree",
    ));
    checks.push(check("worktree", "工作树", "failed", rawWorktree || "尚未填写"));
  } else {
    worktree = resolve(rawWorktree);
    try {
      const metadata = await stat(worktree);
      if (!metadata.isDirectory()) throw new Error("Path is not a directory.");
      checks.push(check("worktree", "工作树", "passed", worktree));
    } catch (error) {
      issues.push(issue(
        "error",
        "preflight.worktree_missing",
        `Worktree is not an accessible directory: ${error.message}`,
        "worktree",
      ));
      checks.push(check("worktree", "工作树", "failed", `${worktree} · 不可访问`));
    }
  }

  let strategy = null;
  if (workflowMode === "overnight") {
    strategy = typeof input?.strategy === "string" ? input.strategy : "";
    if (!OVERNIGHT_STRATEGIES.has(strategy)) {
      issues.push(issue(
        "error",
        "preflight.strategy",
        "Overnight strategy must be convergent or continuous-improvement.",
        "strategy",
      ));
      checks.push(check("strategy", "Overnight 策略", "failed", "策略无效"));
    } else {
      checks.push(check(
        "strategy",
        "Overnight 策略",
        "passed",
        strategy === "convergent" ? "收缩式修改" : "持续扩张改进",
      ));
    }
  } else if (workflowMode === "balanced") {
    checks.push(check("strategy", "轮次策略", "passed", "沿用当前调优时间窗口与调用预算"));
    const issueStart = issues.length;
    const timingValid = validateBalancedRecord(
      input?.timing,
      BALANCED_TIMING_LIMITS,
      "timing",
      issues,
    );
    const budgetValid = validateBalancedRecord(
      input?.budget,
      BALANCED_BUDGET_LIMITS,
      "budget",
      issues,
    );
    if (timingValid) {
      const longestWindow = Math.max(
        input.timing.contextAcquisitionSeconds,
        input.timing.firstProgressSeconds,
        input.timing.activeWindowSeconds,
        input.timing.progressExtensionSeconds,
        input.timing.growingProgressExtensionSeconds,
      );
      if (input.timing.hardCapSeconds < longestWindow) {
        issues.push(issue(
          "error",
          "preflight.balanced_config",
          "timing.hardCapSeconds cannot be shorter than any wait or extension window.",
          "timing.hardCapSeconds",
        ));
      }
    }
    if (
      budgetValid &&
      input.budget.reservedFinalReviewCalls > input.budget.mainReviewCalls
    ) {
      issues.push(issue(
        "error",
        "preflight.balanced_config",
        "budget.reservedFinalReviewCalls cannot exceed budget.mainReviewCalls.",
        "budget.reservedFinalReviewCalls",
      ));
    }
    const configErrors = issues.slice(issueStart);
    checks.push(check(
      "balanced-config",
      "Balanced 时间与预算",
      configErrors.length === 0 ? "passed" : "failed",
      configErrors[0]?.message ?? `hard cap ${input.timing.hardCapSeconds}s · downstream ${input.budget.downstreamCalls} calls`,
    ));
  }

  if (normalized) {
    if (normalized.task.validation.length === 0) {
      issues.push(issue(
        "warning",
        "preflight.validation_empty",
        "No deterministic validation command is declared.",
        "validation",
      ));
      checks.push(check("validation", "验证证据", "warning", "未声明可执行验证命令"));
    } else {
      checks.push(check(
        "validation",
        "验证证据",
        "passed",
        `${normalized.task.validation.length} 条 argv 命令`,
      ));
    }

    const taskShape = normalized.task.extensions.task_shape ?? {};
    const participants = taskShape.participants ?? [];
    const interfaces = taskShape.interfaces ?? [];
    if (participants.length <= 1 && interfaces.length === 0) {
      checks.push(check(
        "interface-ownership",
        "接口所有权",
        "passed",
        participants.length === 1 ? "单一结构化参与者，无跨参与者边界" : "未声明任务分解边界",
      ));
    } else if (participants.length > 1 && interfaces.length === 0) {
      issues.push(issue(
        "warning",
        "preflight.interfaces_undeclared",
        "Multiple participants are declared, but no interface contracts identify their boundaries.",
        "extensions.task_shape.interfaces",
      ));
      checks.push(check(
        "interface-ownership",
        "接口所有权",
        "warning",
        `${participants.length} 个参与者，但未声明接口边界`,
      ));
    } else {
      const validatedInterfaces = interfaces.filter((item) => item.validation_id).length;
      if (validatedInterfaces < interfaces.length) {
        issues.push(issue(
          "warning",
          "preflight.interface_validation_partial",
          `${interfaces.length - validatedInterfaces} interface contract(s) have no deterministic validation reference.`,
          "extensions.task_shape.interfaces",
        ));
      }
      checks.push(check(
        "interface-ownership",
        "接口所有权",
        validatedInterfaces < interfaces.length ? "warning" : "passed",
        `${interfaces.length} 个接口均有负责人 · ${validatedInterfaces}/${interfaces.length} 有确定性验证`,
      ));
    }

    const elevatedRisks = Object.entries(normalized.task.risk)
      .filter(([, value]) => value === "yes")
      .map(([key]) => key);
    if (elevatedRisks.length > 0) {
      issues.push(issue(
        "warning",
        "preflight.human_authority",
        `Human authority may be required for: ${elevatedRisks.join(", ")}.`,
        "risk",
      ));
      checks.push(check("risk", "风险与权限", "warning", elevatedRisks.join(", ")));
    } else {
      checks.push(check("risk", "风险与权限", "passed", "未声明需要人工授权的 yes 风险"));
    }
  }

  const taskText = normalized ? stableTaskText(normalized.task) : null;
  const taskSha256 = taskText
    ? createHash("sha256").update(taskText).digest("hex")
    : null;
  const ready = !issues.some((entry) => entry.severity === "error");

  return {
    ready,
    task: normalized?.task ?? null,
    migrated: normalized?.migrated ?? false,
    taskSha256,
    checks,
    issues,
    envelope: normalized ? {
      schemaVersion: 1,
      workflowMode,
      taskId: normalized.task.id,
      taskSha256,
      worktree: worktree || null,
      adapterId: adapter?.id ?? (adapterId || null),
      runtimeEnvironment: runtimeEnvironment?.profile ?? null,
      ...(workflowContract ? {
        workflowContract: {
          sourceId: workflowContract.sourceId ?? "ai-coding-workflow",
          version: workflowContract.contractVersion ?? null,
          sha256: workflowContract.contractSha256 ?? null,
          compatible: workflowContract.compatible === true,
        },
      } : {}),
      ...(workflowMode === "overnight" ? { strategy: strategy || null } : {}),
      ...(workflowMode === "balanced" ? {
        timing: input?.timing ?? null,
        budget: input?.budget ?? null,
      } : {}),
    } : null,
  };
}

export const TASK_CARD_PREFLIGHT_OPTIONS = Object.freeze({
  workflowModes: Object.freeze([
    Object.freeze({ id: "overnight", displayName: "Overnight" }),
    Object.freeze({ id: "balanced", displayName: "Balanced" }),
  ]),
  overnightStrategies: Object.freeze([
    Object.freeze({ id: "convergent", displayName: "收缩式修改" }),
    Object.freeze({ id: "continuous-improvement", displayName: "持续扩张改进" }),
  ]),
  runtimeEnvironment: Object.freeze(runtimeEnvironmentOptions()),
});
