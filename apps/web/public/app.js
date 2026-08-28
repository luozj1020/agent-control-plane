import {
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  planSkillActivation,
  resolveEffectiveSkill,
} from "/contracts/index.js";

const MODE_COPY = {
  overnight: "适合放置运行：持久委派下游实现，完成后回到主 Agent 审阅。",
  balanced: "按产品调优窗口运行，每轮结束都回到主 Agent 检查方向。",
  interactive: "主 Agent 保持前台，使用自身原生 subagent 并行协作。",
};

const elements = {
  activateButton: document.querySelector("#activate-button"),
  activationNote: document.querySelector("#activation-note"),
  builderAgent: document.querySelector("#builder-agent"),
  builderField: document.querySelector("#builder-field"),
  builderHelp: document.querySelector("#builder-help"),
  compatibilityBadge: document.querySelector("#compatibility-badge"),
  copyButton: document.querySelector("#copy-button"),
  exportButton: document.querySelector("#export-button"),
  includedAgents: document.querySelector("#included-agents"),
  includedModes: document.querySelector("#included-modes"),
  issueList: document.querySelector("#issue-list"),
  mainAgent: document.querySelector("#main-agent"),
  modeGrid: document.querySelector("#mode-grid"),
  operationList: document.querySelector("#operation-list"),
  restartBadge: document.querySelector("#restart-badge"),
  rollbackButton: document.querySelector("#rollback-button"),
  skillPath: document.querySelector("#skill-path"),
  skillPreview: document.querySelector("#skill-preview"),
  storeStatusDetail: document.querySelector("#store-status-detail"),
  storeStatusTitle: document.querySelector("#store-status-title"),
  toast: document.querySelector("#toast"),
  tokenEstimate: document.querySelector("#token-estimate"),
  variantName: document.querySelector("#variant-name"),
};

let selectedModeId = "overnight";
let currentResolution = null;
let serverStatus = {
  writeEnabled: false,
  health: "loading",
  active: null,
  backups: [],
};
let toastTimer;

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function initializeAgentSelectors() {
  const mains = EXAMPLE_AGENTS.filter((agent) =>
    agent.capabilities.includes("semantic-review") || agent.capabilities.includes("native-subagents"),
  );
  const builders = EXAMPLE_AGENTS.filter((agent) =>
    agent.capabilities.includes("durable-resume") ||
    agent.capabilities.includes("bounded-execution"),
  );
  for (const agent of mains) elements.mainAgent.append(option(agent.id, agent.displayName));
  for (const agent of builders) elements.builderAgent.append(option(agent.id, agent.displayName));
}

function renderModeCards() {
  elements.modeGrid.replaceChildren();
  for (const mode of BUILTIN_MODE_CATALOG.modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mode-card${mode.id === selectedModeId ? " selected" : ""}`;
    button.dataset.mode = mode.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(mode.id === selectedModeId));

    const top = document.createElement("div");
    top.className = "mode-top";
    const name = document.createElement("strong");
    name.textContent = mode.displayName;
    const radio = document.createElement("span");
    radio.className = "radio";
    top.append(name, radio);

    const description = document.createElement("p");
    description.textContent = MODE_COPY[mode.id] ?? mode.description;
    const version = document.createElement("code");
    version.textContent = `${mode.id}@${mode.version}`;
    button.append(top, description, version);
    button.addEventListener("click", () => {
      selectedModeId = mode.id;
      renderModeCards();
      refresh();
    });
    elements.modeGrid.append(button);
  }
}

function getInstalledState() {
  if (serverStatus.writeEnabled) {
    return serverStatus.active ? [{ ...serverStatus.active, active: true }] : [];
  }
  try {
    const stored = localStorage.getItem("agent-workflow-active-skill");
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (
      parsed &&
      typeof parsed.variantId === "string" &&
      typeof parsed.relativeSkillPath === "string" &&
      typeof parsed.contentFingerprint === "string"
    ) {
      return [{ ...parsed, active: true }];
    }
  } catch {
    localStorage.removeItem("agent-workflow-active-skill");
  }
  return [];
}

function createProfile() {
  const mode = BUILTIN_MODE_CATALOG.modes.find((entry) => entry.id === selectedModeId);
  if (!mode) throw new Error("Selected mode disappeared from the catalog.");
  const interactive = mode.kind === "interactive";
  return {
    ...CODEX_OVERNIGHT_CLAUDE_PROFILE,
    id: `${elements.mainAgent.value}-${mode.id}-${interactive ? "native" : elements.builderAgent.value}`,
    displayName: `${elements.mainAgent.selectedOptions[0]?.textContent ?? elements.mainAgent.value} ${mode.displayName}`,
    mainAgentId: elements.mainAgent.value,
    mode: { id: mode.id, version: mode.version },
    roleBindings: interactive
      ? [{ role: "subagent", target: { kind: "main-native" } }]
      : [
          { role: "builder", target: { kind: "agent", agentId: elements.builderAgent.value } },
          { role: "reviewer", target: { kind: "main" } },
        ],
  };
}

function operationText(operation) {
  switch (operation.kind) {
    case "deactivate":
      return `停用 ${operation.variantId}`;
    case "backup":
      return `备份 ${operation.relativeSkillPath}`;
    case "write":
      return `写入 ${operation.relativeSkillPath}`;
    case "activate":
      return `激活 ${operation.variantId}`;
    default:
      return "未知操作";
  }
}

function renderOperations(plan) {
  elements.operationList.replaceChildren();
  const operations = plan.ok ? plan.value.operations : [];
  const rows = operations.length > 0 ? operations : [{ kind: "noop" }];
  rows.forEach((operation, index) => {
    const item = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "operation-index";
    badge.textContent = String(index + 1).padStart(2, "0");
    const text = document.createElement("span");
    text.textContent = operation.kind === "noop" ? "当前 Skill 已是目标版本，无需写入" : operationText(operation);
    item.append(badge, text);
    elements.operationList.append(item);
  });

  const restartRequired = plan.ok && plan.value.restartRequired;
  elements.restartBadge.textContent = restartRequired ? "需要重启 Codex" : "无需重启";
  elements.restartBadge.classList.toggle("required", restartRequired);
}

function renderIssues(issues) {
  elements.issueList.replaceChildren();
  if (issues.length === 0) {
    elements.issueList.hidden = true;
    return;
  }
  elements.issueList.hidden = false;
  for (const issue of issues) {
    const row = document.createElement("div");
    row.textContent = `${issue.path || "/"} · ${issue.message}`;
    elements.issueList.append(row);
  }
}

function renderFailure(issues) {
  currentResolution = null;
  elements.compatibilityBadge.textContent = "配置不兼容";
  elements.compatibilityBadge.classList.add("error");
  elements.variantName.textContent = "无法生成";
  elements.tokenEstimate.textContent = "—";
  elements.includedModes.textContent = "—";
  elements.includedAgents.textContent = "—";
  elements.skillPath.textContent = "SKILL.md";
  elements.skillPreview.textContent = "修复左侧配置后将在此生成最小 Skill。";
  elements.activateButton.disabled = true;
  elements.copyButton.disabled = true;
  elements.exportButton.disabled = true;
  renderIssues(issues);
  renderOperations({ ok: false, issues });
}

function storeIsHealthy() {
  return serverStatus.health === "ready" || serverStatus.health === "active";
}

function renderStoreStatus() {
  if (serverStatus.writeEnabled) {
    if (storeIsHealthy()) {
      elements.storeStatusTitle.textContent = "文件写入已启用";
      elements.storeStatusDetail.textContent = serverStatus.active
        ? `当前：${serverStatus.active.variantId}`
        : serverStatus.skillsDir;
    } else {
      elements.storeStatusTitle.textContent = "Skill 目录被阻止";
      elements.storeStatusDetail.textContent = serverStatus.error ?? serverStatus.health;
    }
  } else {
    elements.storeStatusTitle.textContent = "本地预览";
    elements.storeStatusDetail.textContent = "不会修改 Codex 配置";
  }
  elements.rollbackButton.hidden = !(
    serverStatus.writeEnabled &&
    storeIsHealthy() &&
    serverStatus.backups.length > 0
  );
}

function refresh() {
  const interactive = selectedModeId === "interactive";
  elements.builderAgent.disabled = interactive;
  elements.builderField.classList.toggle("native-mode", interactive);
  elements.builderHelp.textContent = interactive
    ? "Interactive 使用主 Agent 原生 subagent"
    : "接收实现任务的外部 Agent";

  const result = resolveEffectiveSkill({
    profile: createProfile(),
    agents: EXAMPLE_AGENTS,
    catalog: BUILTIN_MODE_CATALOG,
  });
  if (!result.ok) {
    renderFailure(result.issues);
    return;
  }

  currentResolution = result.value;
  const plan = planSkillActivation(result.value, getInstalledState());
  if (!plan.ok) {
    renderFailure(plan.issues);
    return;
  }

  elements.compatibilityBadge.textContent = "兼容性通过";
  elements.compatibilityBadge.classList.remove("error");
  elements.variantName.textContent = result.value.id;
  elements.tokenEstimate.textContent = `≈ ${result.value.estimatedTokens} tokens`;
  elements.includedModes.textContent = result.value.includedModeIds.join(", ");
  elements.includedAgents.textContent = result.value.includedAgentIds.join(", ");
  elements.skillPath.textContent = result.value.relativeSkillPath;
  elements.skillPreview.textContent = result.value.content;
  elements.activateButton.disabled = false;
  elements.copyButton.disabled = false;
  elements.exportButton.disabled = false;
  const storeBlocked = serverStatus.writeEnabled && !storeIsHealthy();
  if (storeBlocked) {
    elements.compatibilityBadge.textContent = "目录写入被阻止";
    elements.compatibilityBadge.classList.add("error");
    elements.activateButton.disabled = true;
    renderIssues([
      {
        path: "/skill-store",
        message: serverStatus.error ?? `Skill store health: ${serverStatus.health}`,
      },
    ]);
  } else {
    renderIssues([]);
  }
  renderOperations(plan);

  const installed = getInstalledState()[0];
  if (serverStatus.writeEnabled) {
    elements.activateButton.textContent = "激活到 Codex Skill 目录";
    elements.activationNote.textContent = installed
      ? `文件系统当前激活：${installed.variantId}`
      : `目标目录：${serverStatus.skillsDir}`;
  } else {
    elements.activateButton.textContent = "设为当前预览 Skill";
    elements.activationNote.textContent = installed
      ? `浏览器当前记录：${installed.variantId}`
      : "保存只影响浏览器中的预览状态。";
  }
  renderStoreStatus();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2200);
}

elements.mainAgent.addEventListener("change", refresh);
elements.builderAgent.addEventListener("change", refresh);
async function requestJson(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `Request failed: ${response.status}`);
  }
  return body;
}

async function loadServerStatus() {
  try {
    serverStatus = await requestJson("/api/status");
  } catch (error) {
    serverStatus = {
      writeEnabled: false,
      health: "status-unavailable",
      active: null,
      backups: [],
      error: error.message,
    };
  }
  refresh();
}

elements.activateButton.addEventListener("click", async () => {
  if (!currentResolution) return;
  if (serverStatus.writeEnabled) {
    elements.activateButton.disabled = true;
    try {
      const result = await requestJson("/api/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: createProfile() }),
      });
      serverStatus = result.status;
      showToast(result.changed ? "Skill 已原子激活；重启 Codex 后生效。" : "当前已经是该 Skill。");
    } catch (error) {
      showToast(`激活失败：${error.message}`);
    }
    refresh();
    return;
  }
  localStorage.setItem(
    "agent-workflow-active-skill",
    JSON.stringify({
      variantId: currentResolution.id,
      relativeSkillPath: currentResolution.relativeSkillPath,
      contentFingerprint: currentResolution.contentFingerprint,
    }),
  );
  showToast("已保存为当前预览 Skill；尚未写入 Codex。");
  refresh();
});
elements.rollbackButton.addEventListener("click", async () => {
  const latest = serverStatus.backups[0];
  if (!latest) return;
  if (!window.confirm(`回滚到 ${latest.variantId}？当前 Skill 会先自动备份。`)) return;
  elements.rollbackButton.disabled = true;
  try {
    const result = await requestJson("/api/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ backupId: latest.backupId }),
    });
    serverStatus = result.status;
    showToast(`已回滚到 ${result.status.active.variantId}；重启 Codex 后生效。`);
  } catch (error) {
    showToast(`回滚失败：${error.message}`);
  } finally {
    elements.rollbackButton.disabled = false;
    refresh();
  }
});
elements.copyButton.addEventListener("click", async () => {
  if (!currentResolution) return;
  try {
    await navigator.clipboard.writeText(currentResolution.content);
    showToast("Skill 内容已复制。");
  } catch {
    showToast("浏览器拒绝剪贴板访问，请使用导出。");
  }
});
elements.exportButton.addEventListener("click", () => {
  if (!currentResolution) return;
  const url = URL.createObjectURL(new Blob([currentResolution.content], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "SKILL.md";
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("已导出 SKILL.md。");
});

initializeAgentSelectors();
renderModeCards();
refresh();
loadServerStatus();
