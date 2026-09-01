import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { EMBEDDED_RUNTIME_PROTOCOLS } from "./workflow-runtime-protocol.mjs";

const CONTRACT_RELATIVE_PATH = "contracts/workflow-contract-v1.json";
const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_CONTRACT_MAJOR = 1;
const MINIMUM_CONTRACT_MINOR = 1;
const EMBEDDED_SOURCE_ROOT = fileURLToPath(new URL("../../packages/workflow-core/", import.meta.url));
const WORKFLOW_SOURCE_ID = "agent-control-plane/workflow-core";

const LOCAL_COMPATIBILITY_SURFACE = Object.freeze({
  modeIds: Object.freeze(["overnight", "balanced", "interactive"]),
  overnightStrategyIds: Object.freeze(["convergent", "continuous-improvement"]),
  balancedDecisions: Object.freeze(["accept", "revise", "stop"]),
  runtimeProtocols: EMBEDDED_RUNTIME_PROTOCOLS,
});

export class WorkflowCoreAdapterError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "WorkflowCoreAdapterError";
    this.code = code;
    this.status = status;
  }
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ""));
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

function equalStringSets(left, right) {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

function safeSchemaPath(root, relativePath) {
  if (typeof relativePath !== "string" || isAbsolute(relativePath)) return null;
  const target = resolve(root, relativePath);
  return target.startsWith(`${resolve(root)}${sep}`) ? target : null;
}

async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function validateContractShape(contract) {
  const errors = [];
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return ["Workflow Contract 必须是 JSON object。"];
  }
  if (contract.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    errors.push(`schema_version 必须为 ${SUPPORTED_SCHEMA_VERSION}。`);
  }
  if (contract.contract_id !== "ai-coding-workflow") {
    errors.push("contract_id 必须为 ai-coding-workflow。 ");
  }
  if (parseVersion(contract.contract_version) === null) {
    errors.push("contract_version 必须使用 semver。 ");
  }
  if (!Array.isArray(contract.modes) || contract.modes.some((mode) => typeof mode?.id !== "string")) {
    errors.push("modes 声明无效。 ");
  }
  if (!Array.isArray(contract.overnight_strategies)) {
    errors.push("overnight_strategies 声明无效。 ");
  }
  if (!Array.isArray(contract.schema_bindings)) {
    errors.push("schema_bindings 声明无效。 ");
  }
  if (!contract.projections?.task_card || !contract.projections?.control_plane_runtime) {
    errors.push("缺少 Task Card 或 Control Plane Runtime 投影。 ");
  }
  return errors.map((value) => value.trim());
}

function projectionValid(projection) {
  const overnight = projection?.overnight;
  const balanced = projection?.balanced;
  return Boolean(
    overnight && balanced &&
    Array.isArray(overnight.states) && Array.isArray(overnight.wake_states) &&
    Array.isArray(overnight.terminal_states) && overnight.review_decisions &&
    overnight.outcome_states && overnight.decision_states &&
    Array.isArray(balanced.states) && Array.isArray(balanced.evidence_statuses) &&
    Array.isArray(balanced.review_decisions) && typeof balanced.review_state === "string" &&
    balanced.outcome_states && balanced.decision_states,
  );
}

export function createWorkflowCoreAdapter(options = {}) {
  const local = options.localCompatibilitySurface ?? LOCAL_COMPATIBILITY_SURFACE;
  const configuredRoot = resolve(options.sourceRoot ?? EMBEDDED_SOURCE_ROOT);

  async function locateRoot() {
    return {
      root: await directoryExists(configuredRoot) ? configuredRoot : null,
      requestedRoot: configuredRoot,
      source: options.sourceRoot ? "test-fixture" : "embedded",
    };
  }

  async function status() {
    const located = await locateRoot();
    const base = {
      schemaVersion: 1,
      sourceId: WORKFLOW_SOURCE_ID,
      authority: {
        workflowSemantics: WORKFLOW_SOURCE_ID,
        selectionAndActivation: "agent-control-plane",
        localRuntime: "embedded-projection",
      },
      supported: {
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        contractMajor: SUPPORTED_CONTRACT_MAJOR,
        minimumContractMinor: MINIMUM_CONTRACT_MINOR,
      },
      source: { kind: located.source, root: located.requestedRoot, contractPath: null },
      available: false,
      compatible: false,
      health: "unavailable",
      contractVersion: null,
      contractSha256: null,
      drift: [],
      checks: [],
    };
    if (!located.root) {
      base.checks.push(check("source-root", "Workflow Core", "failed", "产品内置 workflow-core 缺失"));
      return base;
    }

    const contractPath = resolve(located.root, CONTRACT_RELATIVE_PATH);
    base.source.contractPath = contractPath;
    let raw;
    let contract;
    try {
      raw = await readFile(contractPath);
      contract = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      base.checks.push(check("contract-read", "契约文件", "failed", error?.code === "ENOENT" ? "缺少 workflow-contract-v1.json" : "契约无法读取或解析"));
      return base;
    }
    base.available = true;
    base.contractSha256 = sha256(raw);
    base.contractVersion = typeof contract.contract_version === "string" ? contract.contract_version : null;
    base.checks.push(check("source-root", "内置 Workflow Core", "passed", located.root));

    const shapeErrors = validateContractShape(contract);
    base.checks.push(check(
      "contract-shape",
      "契约结构",
      shapeErrors.length === 0 ? "passed" : "failed",
      shapeErrors.length === 0 ? `v${contract.contract_version}` : shapeErrors.join("；"),
    ));
    if (shapeErrors.length > 0) {
      base.health = "incompatible";
      return base;
    }

    const parsedVersion = parseVersion(contract.contract_version);
    const versionCompatible = parsedVersion?.major === SUPPORTED_CONTRACT_MAJOR
      && parsedVersion.minor >= MINIMUM_CONTRACT_MINOR;
    base.checks.push(check(
      "contract-version",
      "版本兼容",
      versionCompatible ? "passed" : "failed",
      versionCompatible
        ? `支持 1.${MINIMUM_CONTRACT_MINOR}+，当前 ${contract.contract_version}`
        : `要求 1.${MINIMUM_CONTRACT_MINOR}+，当前 ${contract.contract_version}`,
    ));

    let bindingFailure = false;
    for (const binding of contract.schema_bindings) {
      const schemaPath = safeSchemaPath(located.root, binding?.path);
      let matches = false;
      if (schemaPath && /^sha256:[0-9a-f]{64}$/.test(String(binding?.sha256 ?? ""))) {
        try {
          matches = sha256(await readFile(schemaPath)) === binding.sha256;
        } catch {
          matches = false;
        }
      }
      if (!matches) bindingFailure = true;
    }
    base.checks.push(check(
      "schema-bindings",
      "Schema 哈希绑定",
      bindingFailure ? "failed" : "passed",
      bindingFailure ? "至少一个上游 Schema 缺失或哈希不匹配" : `${contract.schema_bindings.length} 个绑定有效`,
    ));

    const upstreamModes = contract.modes.map((mode) => mode.id);
    const upstreamStrategies = contract.overnight_strategies.map((strategy) => strategy.id);
    const upstreamBalancedDecisions = contract.review?.balanced_decisions ?? [];
    const projectedRuntime = contract.projections?.control_plane_runtime;
    const protocolMatches = equalStringSets(upstreamModes, local.modeIds)
      && equalStringSets(upstreamStrategies, local.overnightStrategyIds)
      && equalStringSets(upstreamBalancedDecisions, local.balancedDecisions)
      && projectionValid(projectedRuntime)
      && (!local.runtimeProtocols || isDeepStrictEqual(projectedRuntime, local.runtimeProtocols));
    base.checks.push(check(
      "control-plane-projection",
      "ACP 协议投影",
      protocolMatches ? "passed" : "failed",
      protocolMatches ? "模式、策略、审阅决策和 Runner 状态投影一致" : "ACP 所需协议投影缺失或不一致",
    ));

    base.compatible = versionCompatible && !bindingFailure && protocolMatches;
    base.health = base.compatible
      ? base.drift.some((entry) => entry.severity === "warning") ? "drift-detected" : "compatible"
      : "incompatible";
    return base;
  }

  async function loadProjectionSource() {
    const located = await locateRoot();
    if (!located.root) {
      throw new WorkflowCoreAdapterError(
        "workflow_core.unavailable",
        "Embedded Workflow Core is unavailable.",
        503,
      );
    }
    const contractPath = resolve(located.root, CONTRACT_RELATIVE_PATH);
    let raw;
    let contract;
    try {
      raw = await readFile(contractPath);
      contract = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new WorkflowCoreAdapterError(
        "workflow_core.contract_unavailable",
        "Embedded Workflow Contract cannot be read.",
        503,
      );
    }
    const errors = validateContractShape(contract);
    const version = parseVersion(contract.contract_version);
    if (
      errors.length > 0 || version?.major !== SUPPORTED_CONTRACT_MAJOR ||
      version.minor < MINIMUM_CONTRACT_MINOR ||
      !projectionValid(contract.projections?.control_plane_runtime)
    ) {
      throw new WorkflowCoreAdapterError(
        "workflow_core.incompatible",
        "Embedded Workflow Contract is incompatible with this control plane.",
        409,
      );
    }
    return { located, contractPath, raw, contract };
  }

  async function schema(bindingId) {
    const loaded = await loadProjectionSource();
    const binding = loaded.contract.schema_bindings.find((entry) => entry.id === bindingId);
    const schemaPath = binding ? safeSchemaPath(loaded.located.root, binding.path) : null;
    if (!schemaPath || !/^sha256:[0-9a-f]{64}$/.test(String(binding?.sha256 ?? ""))) {
      throw new WorkflowCoreAdapterError("workflow_core.schema_unknown", `Unknown schema binding '${bindingId}'.`, 404);
    }
    let raw;
    try {
      raw = await readFile(schemaPath);
    } catch {
      throw new WorkflowCoreAdapterError("workflow_core.schema_unavailable", `Schema '${bindingId}' is unavailable.`, 503);
    }
    if (sha256(raw) !== binding.sha256) {
      throw new WorkflowCoreAdapterError("workflow_core.schema_drift", `Schema '${bindingId}' failed its hash binding.`, 409);
    }
    return Object.freeze({
      binding: Object.freeze({ ...binding }),
      schema: Object.freeze(JSON.parse(raw.toString("utf8"))),
      source: Object.freeze({ root: loaded.located.root, path: schemaPath }),
    });
  }

  async function runtimeProtocol(mode) {
    if (!new Set(["overnight", "balanced"]).has(mode)) {
      throw new WorkflowCoreAdapterError("workflow_core.runtime_unknown", `Unknown runtime projection '${mode}'.`, 404);
    }
    const loaded = await loadProjectionSource();
    return {
      schemaVersion: 1,
      sourceId: WORKFLOW_SOURCE_ID,
      contractVersion: loaded.contract.contract_version,
      contractSha256: sha256(loaded.raw),
      mode,
      strategies: mode === "overnight"
        ? loaded.contract.overnight_strategies.map((strategy) => strategy.id)
        : [],
      protocol: structuredClone(loaded.contract.projections.control_plane_runtime[mode]),
    };
  }

  return Object.freeze({ status, diagnose: status, schema, runtimeProtocol });
}

export const WORKFLOW_CORE_COMPATIBILITY = Object.freeze({
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  contractMajor: SUPPORTED_CONTRACT_MAJOR,
  minimumContractMinor: MINIMUM_CONTRACT_MINOR,
  contractRelativePath: CONTRACT_RELATIVE_PATH,
  embeddedSourceRoot: EMBEDDED_SOURCE_ROOT,
  localRuntimeAuthority: "embedded-projection",
});
