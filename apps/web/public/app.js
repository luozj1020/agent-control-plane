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
  runtimeCacheRate: document.querySelector("#runtime-cache-rate"),
  runtimeCached: document.querySelector("#runtime-cached"),
  runtimeChart: document.querySelector("#runtime-chart"),
  runtimeDiagnostics: document.querySelector("#runtime-diagnostics"),
  runtimeEmpty: document.querySelector("#runtime-empty"),
  runtimeInput: document.querySelector("#runtime-input"),
  runtimeLive: document.querySelector("#runtime-live"),
  runtimeLiveText: document.querySelector("#runtime-live-text"),
  runtimeModels: document.querySelector("#runtime-models"),
  runtimeOutput: document.querySelector("#runtime-output"),
  runtimeRange: document.querySelector("#runtime-range"),
  runtimeReasoning: document.querySelector("#runtime-reasoning"),
  runtimeRequests: document.querySelector("#runtime-requests"),
  runtimeSessions: document.querySelector("#runtime-sessions"),
  runtimeTotal: document.querySelector("#runtime-total"),
  runtimeUncached: document.querySelector("#runtime-uncached"),
  runtimeUpdated: document.querySelector("#runtime-updated"),
  runtimeWindow: document.querySelector("#runtime-window"),
  skillPath: document.querySelector("#skill-path"),
  skillPreview: document.querySelector("#skill-preview"),
  storeStatusDetail: document.querySelector("#store-status-detail"),
  storeStatusTitle: document.querySelector("#store-status-title"),
  toast: document.querySelector("#toast"),
  tokenEstimate: document.querySelector("#token-estimate"),
  tokenChart: document.querySelector("#token-chart"),
  tokenChartSummary: document.querySelector("#token-chart-summary"),
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
let runtimeRange = "24h";
let usageLoading = false;
let usageRefreshQueued = false;

const RANGE_LABELS = Object.freeze({
  "1h": "最近 1 小时",
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
});

const compactNumber = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactNumber = new Intl.NumberFormat("zh-CN");

function formatTokens(value) {
  return Number.isFinite(value) ? compactNumber.format(value) : "—";
}

function formatAxis(value) {
  if (value === 0) return "0";
  return compactNumber.format(value);
}

function niceMaximum(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const ceiling = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return ceiling * magnitude;
}

function formatBucketLabel(timestamp, range) {
  const date = new Date(timestamp);
  if (range === "1h" || range === "24h") {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function svgNode(name, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function setRuntimeMetrics(totals = {}) {
  elements.runtimeTotal.textContent = formatTokens(totals.totalTokens);
  elements.runtimeTotal.title = exactNumber.format(totals.totalTokens ?? 0);
  elements.runtimeInput.textContent = formatTokens(totals.inputTokens);
  elements.runtimeCached.textContent = formatTokens(totals.cachedInputTokens);
  elements.runtimeOutput.textContent = formatTokens(totals.outputTokens);
  elements.runtimeRequests.textContent = formatTokens(totals.requests);
  elements.runtimeUncached.textContent = `未缓存 ${formatTokens(totals.uncachedInputTokens)}`;
  elements.runtimeCacheRate.textContent = `缓存率 ${((totals.cacheRate ?? 0) * 100).toFixed(1)}%`;
  elements.runtimeReasoning.textContent = `含 reasoning ${formatTokens(totals.reasoningOutputTokens)}`;
  elements.runtimeSessions.textContent = `会话 ${formatTokens(totals.sessions)}`;
  elements.runtimeWindow.textContent = RANGE_LABELS[runtimeRange];
}

function renderRuntimeChart(usage) {
  elements.runtimeChart.replaceChildren();
  const buckets = usage.buckets ?? [];
  const hasUsage = buckets.some((bucket) => bucket.totalTokens > 0);
  elements.runtimeEmpty.hidden = hasUsage;
  if (!hasUsage) {
    elements.runtimeEmpty.textContent = "所选时间范围内暂无 token 用量";
    return;
  }

  const width = 1120;
  const height = 270;
  const margin = { top: 16, right: 16, bottom: 38, left: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximum = niceMaximum(Math.max(...buckets.map((bucket) => bucket.totalTokens)));
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${RANGE_LABELS[runtimeRange]} Codex token 用量时序图`,
  });

  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = tick / 4;
    const y = margin.top + plotHeight - ratio * plotHeight;
    svg.append(
      svgNode("line", {
        class: "runtime-grid-line",
        x1: margin.left,
        x2: width - margin.right,
        y1: y,
        y2: y,
      }),
    );
    const label = svgNode("text", {
      class: "runtime-axis-label",
      x: margin.left - 10,
      y: y + 3,
      "text-anchor": "end",
    });
    label.textContent = formatAxis((maximum * tick) / 4);
    svg.append(label);
  }

  const slotWidth = plotWidth / buckets.length;
  const barWidth = Math.max(3, Math.min(22, slotWidth * 0.66));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
  buckets.forEach((bucket, index) => {
    const x = margin.left + index * slotWidth + (slotWidth - barWidth) / 2;
    let baseline = margin.top + plotHeight;
    const segments = [
      ["uncached", bucket.uncachedInputTokens ?? 0],
      ["cached", bucket.cachedInputTokens ?? 0],
      ["output", bucket.outputTokens ?? 0],
    ];
    const group = svgNode("g", { class: "runtime-bar-group" });
    for (const [kind, value] of segments) {
      const segmentHeight = (value / maximum) * plotHeight;
      baseline -= segmentHeight;
      group.append(
        svgNode("rect", {
          class: `runtime-bar ${kind}`,
          x,
          y: baseline,
          width: barWidth,
          height: Math.max(0, segmentHeight),
        }),
      );
    }
    const title = svgNode("title");
    title.textContent = `${formatBucketLabel(bucket.start, runtimeRange)} · 总计 ${exactNumber.format(bucket.totalTokens)} · 未缓存输入 ${exactNumber.format(bucket.uncachedInputTokens)} · 缓存输入 ${exactNumber.format(bucket.cachedInputTokens)} · 输出 ${exactNumber.format(bucket.outputTokens)}`;
    group.append(title);
    svg.append(group);

    if (index % labelEvery === 0 || index === buckets.length - 1) {
      const label = svgNode("text", {
        class: "runtime-axis-label",
        x: x + barWidth / 2,
        y: height - 13,
        "text-anchor": "middle",
      });
      label.textContent = formatBucketLabel(bucket.start, runtimeRange);
      svg.append(label);
    }
  });
  elements.runtimeChart.append(svg);
}

function renderRuntimeModels(models = []) {
  elements.runtimeModels.replaceChildren();
  if (models.length === 0) {
    const empty = document.createElement("span");
    empty.className = "model-empty";
    empty.textContent = "暂无模型用量";
    elements.runtimeModels.append(empty);
    return;
  }
  for (const entry of models.slice(0, 4)) {
    const chip = document.createElement("span");
    chip.className = "model-chip";
    const model = document.createElement("b");
    model.textContent = entry.model;
    const usage = document.createElement("em");
    usage.textContent = formatTokens(entry.totalTokens);
    usage.title = `${exactNumber.format(entry.totalTokens)} tokens`;
    chip.append(model, usage);
    elements.runtimeModels.append(chip);
  }
}

function renderRuntimeUsage(usage) {
  if (!usage.available) {
    elements.runtimeLive.className = "runtime-live unavailable";
    elements.runtimeLiveText.textContent = "不可用";
    setRuntimeMetrics();
    elements.runtimeChart.replaceChildren();
    elements.runtimeEmpty.hidden = false;
    elements.runtimeEmpty.textContent =
      usage.reason === "sessions-directory-missing"
        ? "未找到 Codex 本地会话目录"
        : "本地用量数据源不可用";
    renderRuntimeModels();
    elements.runtimeUpdated.textContent = "未采集数据";
    elements.runtimeDiagnostics.textContent = "数据源不可用 · 不读取消息内容";
    return;
  }
  elements.runtimeLive.className = "runtime-live";
  elements.runtimeLiveText.textContent = "实时采集";
  setRuntimeMetrics(usage.totals);
  renderRuntimeChart(usage);
  renderRuntimeModels(usage.models);
  elements.runtimeUpdated.textContent = `更新于 ${new Date(usage.generatedAt).toLocaleTimeString("zh-CN")}`;
  const diagnostics = usage.diagnostics ?? {};
  elements.runtimeDiagnostics.textContent = `${diagnostics.filesRead ?? 0} 个本地会话文件 · ${diagnostics.parseErrors ?? 0} 个无效事件 · 不保留消息内容`;
}

function renderRuntimeError(message) {
  elements.runtimeLive.className = "runtime-live unavailable";
  elements.runtimeLiveText.textContent = "连接失败";
  elements.runtimeChart.replaceChildren();
  elements.runtimeEmpty.hidden = false;
  elements.runtimeEmpty.textContent = `无法读取运行时用量：${message}`;
  elements.runtimeUpdated.textContent = "将在后台重试";
  elements.runtimeDiagnostics.textContent = "连接失败 · 不读取消息内容";
}

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

function createProfile(modeId = selectedModeId) {
  const mode = BUILTIN_MODE_CATALOG.modes.find((entry) => entry.id === modeId);
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

function renderTokenChart() {
  const estimates = BUILTIN_MODE_CATALOG.modes.map((mode) => {
    const result = resolveEffectiveSkill({
      profile: createProfile(mode.id),
      agents: EXAMPLE_AGENTS,
      catalog: BUILTIN_MODE_CATALOG,
    });
    return {
      id: mode.id,
      label: mode.displayName,
      tokens: result.ok ? result.value.estimatedTokens : null,
    };
  });
  const available = estimates.flatMap((entry) =>
    entry.tokens === null ? [] : [entry.tokens],
  );
  const rawMaximum = Math.max(1, ...available);
  const maximum = Math.ceil(rawMaximum / 25) * 25;
  const selected = estimates.find((entry) => entry.id === selectedModeId);

  elements.tokenChart.replaceChildren();
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const width = 480;
  const height = 214;
  const margin = { top: 22, right: 12, bottom: 38, left: 42 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    estimates
      .map((entry) => `${entry.label} ${entry.tokens ?? "不可用"} tokens`)
      .join("，"),
  );

  for (let tick = 0; tick <= 4; tick += 1) {
    const ratio = tick / 4;
    const y = margin.top + plotHeight - ratio * plotHeight;
    const line = document.createElementNS(namespace, "line");
    line.setAttribute("class", "usage-grid-line");
    line.setAttribute("x1", String(margin.left));
    line.setAttribute("x2", String(width - margin.right));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    svg.append(line);

    const label = document.createElementNS(namespace, "text");
    label.setAttribute("class", "usage-axis-label");
    label.setAttribute("x", String(margin.left - 9));
    label.setAttribute("y", String(y + 3));
    label.setAttribute("text-anchor", "end");
    label.textContent = String(Math.round(maximum * ratio));
    svg.append(label);
  }

  const groupWidth = plotWidth / estimates.length;
  const barWidth = Math.min(58, groupWidth * 0.44);
  estimates.forEach((estimate, index) => {
    const tokens = estimate.tokens ?? 0;
    const barHeight = (tokens / maximum) * plotHeight;
    const x = margin.left + index * groupWidth + (groupWidth - barWidth) / 2;
    const y = margin.top + plotHeight - barHeight;
    const bar = document.createElementNS(namespace, "rect");
    bar.setAttribute(
      "class",
      `usage-bar${estimate.id === selectedModeId ? " selected" : ""}`,
    );
    bar.setAttribute("x", String(x));
    bar.setAttribute("y", String(y));
    bar.setAttribute("width", String(barWidth));
    bar.setAttribute("height", String(Math.max(0, barHeight)));
    bar.setAttribute("rx", "5");
    const title = document.createElementNS(namespace, "title");
    title.textContent = `${estimate.label}: ${estimate.tokens ?? "不可用"} tokens`;
    bar.append(title);
    svg.append(bar);

    const value = document.createElementNS(namespace, "text");
    value.setAttribute("class", "usage-value");
    value.setAttribute("x", String(x + barWidth / 2));
    value.setAttribute("y", String(Math.max(12, y - 7)));
    value.setAttribute("text-anchor", "middle");
    value.textContent = estimate.tokens === null ? "—" : String(estimate.tokens);
    svg.append(value);

    const modeLabel = document.createElementNS(namespace, "text");
    modeLabel.setAttribute(
      "class",
      `usage-mode-label${estimate.id === selectedModeId ? " selected" : ""}`,
    );
    modeLabel.setAttribute("x", String(x + barWidth / 2));
    modeLabel.setAttribute("y", String(height - 13));
    modeLabel.setAttribute("text-anchor", "middle");
    modeLabel.textContent = estimate.label;
    svg.append(modeLabel);
  });

  elements.tokenChart.append(svg);

  elements.tokenChartSummary.textContent =
    selected?.tokens === null || selected === undefined
      ? "当前不可用"
      : `当前 ≈ ${selected.tokens} tokens`;
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
    renderTokenChart();
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
  renderTokenChart();
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

async function loadRuntimeUsage() {
  if (usageLoading) {
    usageRefreshQueued = true;
    return;
  }
  usageLoading = true;
  const requestedRange = runtimeRange;
  try {
    const usage = await requestJson(`/api/usage?range=${encodeURIComponent(requestedRange)}`);
    if (requestedRange === runtimeRange) renderRuntimeUsage(usage);
  } catch (error) {
    if (requestedRange === runtimeRange) renderRuntimeError(error.message);
  } finally {
    usageLoading = false;
    if (usageRefreshQueued) {
      usageRefreshQueued = false;
      loadRuntimeUsage();
    }
  }
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

elements.runtimeRange.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-range]");
  if (!button || !elements.runtimeRange.contains(button)) return;
  runtimeRange = button.dataset.range;
  for (const candidate of elements.runtimeRange.querySelectorAll("button")) {
    candidate.classList.toggle("active", candidate === button);
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  elements.runtimeWindow.textContent = RANGE_LABELS[runtimeRange];
  loadRuntimeUsage();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadRuntimeUsage();
});

initializeAgentSelectors();
renderModeCards();
refresh();
loadServerStatus();
loadRuntimeUsage();
window.setInterval(() => {
  if (!document.hidden) loadRuntimeUsage();
}, 5000);
