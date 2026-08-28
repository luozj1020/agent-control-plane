import {
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  planSkillActivation,
  resolveEffectiveSkill,
} from "/contracts/index.js";
import { createLatestSwitchCoordinator } from "/mode-switch-coordinator.js";

const MODE_COPY = {
  overnight: "适合放置运行：持久委派下游实现，完成后回到主 Agent 审阅。",
  balanced: "按产品调优窗口运行，每轮结束都回到主 Agent 检查方向。",
  interactive: "主 Agent 保持前台，使用自身原生 subagent 并行协作。",
};

const BALANCED_MODE = BUILTIN_MODE_CATALOG.modes.find((mode) => mode.kind === "balanced");
const BALANCED_POLICY = BUILTIN_MODE_CATALOG.tunedWindowPolicies.find(
  (policy) =>
    policy.id === BALANCED_MODE?.tunedWindowPolicy.id &&
    policy.version === BALANCED_MODE?.tunedWindowPolicy.version,
);
const BALANCED_BUDGET = BUILTIN_MODE_CATALOG.balancedBudgetPolicies.find(
  (budget) =>
    budget.id === BALANCED_MODE?.budgetPolicy.id && budget.version === BALANCED_MODE?.budgetPolicy.version,
);

const elements = {
  activateButton: document.querySelector("#activate-button"),
  activationNote: document.querySelector("#activation-note"),
  activationStep: document.querySelector("#activation-step"),
  balancedActiveWindow: document.querySelector("#balanced-active-window"),
  balancedAdvisorCalls: document.querySelector("#balanced-advisor-calls"),
  balancedConfig: document.querySelector("#balanced-config"),
  balancedContextWindow: document.querySelector("#balanced-context-window"),
  balancedDownstreamCalls: document.querySelector("#balanced-downstream-calls"),
  balancedExtensionWindow: document.querySelector("#balanced-extension-window"),
  balancedHardCap: document.querySelector("#balanced-hard-cap"),
  balancedMainCalls: document.querySelector("#balanced-main-calls"),
  balancedPolicyVersion: document.querySelector("#balanced-policy-version"),
  balancedReservedCalls: document.querySelector("#balanced-reserved-calls"),
  balancedRunList: document.querySelector("#balanced-run-list"),
  balancedRuntimeSummary: document.querySelector("#balanced-runtime-summary"),
  balancedTokenBudget: document.querySelector("#balanced-token-budget"),
  builderAgent: document.querySelector("#builder-agent"),
  builderField: document.querySelector("#builder-field"),
  builderHelp: document.querySelector("#builder-help"),
  compatibilityBadge: document.querySelector("#compatibility-badge"),
  copyButton: document.querySelector("#copy-button"),
  exportButton: document.querySelector("#export-button"),
  configurationTopbar: document.querySelector("#configuration-topbar"),
  configurationWorkspace: document.querySelector("#configuration-workspace"),
  callsChart: document.querySelector("#calls-chart"),
  callsDownstream: document.querySelector("#calls-downstream"),
  callsEmpty: document.querySelector("#calls-empty"),
  callsTotal: document.querySelector("#calls-total"),
  callsUpstream: document.querySelector("#calls-upstream"),
  coverageDownstream: document.querySelector("#coverage-downstream"),
  coverageUpstream: document.querySelector("#coverage-upstream"),
  historyActiveBadge: document.querySelector("#history-active-badge"),
  historyCount: document.querySelector("#history-count"),
  historyDetail: document.querySelector("#history-detail"),
  historyDetailTitle: document.querySelector("#history-detail-title"),
  historyDiffSummary: document.querySelector("#history-diff-summary"),
  historyEmpty: document.querySelector("#history-empty"),
  historyFieldDiff: document.querySelector("#history-field-diff"),
  historyIntegrity: document.querySelector("#history-integrity"),
  historyList: document.querySelector("#history-list"),
  historyMeta: document.querySelector("#history-meta"),
  historyPlaceholder: document.querySelector("#history-placeholder"),
  historyRefresh: document.querySelector("#history-refresh"),
  historyRestore: document.querySelector("#history-restore"),
  historyRestoreNote: document.querySelector("#history-restore-note"),
  historySkillDiff: document.querySelector("#history-skill-diff"),
  historyStatus: document.querySelector("#history-status"),
  historyView: document.querySelector("#history-view"),
  includedAgents: document.querySelector("#included-agents"),
  includedModes: document.querySelector("#included-modes"),
  issueList: document.querySelector("#issue-list"),
  mainAgent: document.querySelector("#main-agent"),
  modeGrid: document.querySelector("#mode-grid"),
  modeSwitchPolicy: document.querySelector("#mode-switch-policy"),
  navConfiguration: document.querySelector("#nav-configuration"),
  navHistory: document.querySelector("#nav-history"),
  navUsage: document.querySelector("#nav-usage"),
  operationList: document.querySelector("#operation-list"),
  restartBadge: document.querySelector("#restart-badge"),
  rollbackButton: document.querySelector("#rollback-button"),
  runtimeCacheRate: document.querySelector("#runtime-cache-rate"),
  runtimeCached: document.querySelector("#runtime-cached"),
  runtimeChart: document.querySelector("#runtime-chart"),
  runtimeDiagnostics: document.querySelector("#runtime-diagnostics"),
  runtimeDownstreamTokens: document.querySelector("#runtime-downstream-tokens"),
  runtimeEmpty: document.querySelector("#runtime-empty"),
  runtimeInput: document.querySelector("#runtime-input"),
  runtimeLive: document.querySelector("#runtime-live"),
  runtimeLiveText: document.querySelector("#runtime-live-text"),
  runtimeLegendLane: document.querySelector("#runtime-legend-lane"),
  runtimeLegendType: document.querySelector("#runtime-legend-type"),
  runtimeLaneFilter: document.querySelector("#runtime-lane-filter"),
  runtimeFilterSummary: document.querySelector("#runtime-filter-summary"),
  runtimeModelCount: document.querySelector("#runtime-model-count"),
  runtimeModelFilter: document.querySelector("#runtime-model-filter"),
  runtimeModels: document.querySelector("#runtime-models"),
  runtimeOutput: document.querySelector("#runtime-output"),
  runtimeRange: document.querySelector("#runtime-range"),
  runtimeReasoning: document.querySelector("#runtime-reasoning"),
  runtimeRequests: document.querySelector("#runtime-requests"),
  runtimeSessions: document.querySelector("#runtime-sessions"),
  runtimeTotal: document.querySelector("#runtime-total"),
  runtimeUncached: document.querySelector("#runtime-uncached"),
  runtimeUpdated: document.querySelector("#runtime-updated"),
  runtimeUpstreamTokens: document.querySelector("#runtime-upstream-tokens"),
  runtimeWindow: document.querySelector("#runtime-window"),
  skillPath: document.querySelector("#skill-path"),
  skillPreview: document.querySelector("#skill-preview"),
  storeStatusDetail: document.querySelector("#store-status-detail"),
  storeStatusTitle: document.querySelector("#store-status-title"),
  toast: document.querySelector("#toast"),
  tokenEstimate: document.querySelector("#token-estimate"),
  tokenDimension: document.querySelector("#token-dimension"),
  tokenChart: document.querySelector("#token-chart"),
  tokenChartSummary: document.querySelector("#token-chart-summary"),
  usageView: document.querySelector("#usage-view"),
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
let runtimeTokenView = "type";
let runtimeLane = "all";
let runtimeModel = "";
let latestRuntimeUsage = null;
let usageLoading = false;
let usageRefreshQueued = false;
let activeView = "configuration";
let historyData = null;
let selectedHistoryId = null;
let historyRequest = 0;
let balancedRuns = [];
let balancedRunsAvailable = true;
let serverStatusLoaded = false;
let modeSwitchState = { active: null, pending: null, running: false };
let markServerStatusReady;
const serverStatusReady = new Promise((resolve) => {
  markServerStatusReady = resolve;
});

const RANGE_LABELS = Object.freeze({
  "1h": "最近 1 小时",
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
});

const LANE_LABELS = Object.freeze({
  all: "全部上下游",
  upstream: "上游 · 主 Agent",
  downstream: "下游 · Builder / subagent",
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

function renderRuntimeFilters(modelOptions = []) {
  elements.runtimeLaneFilter.value = runtimeLane;
  elements.runtimeModelFilter.replaceChildren();
  const allModels = document.createElement("option");
  allModels.value = "";
  allModels.textContent = "全部模型";
  elements.runtimeModelFilter.append(allModels);
  for (const entry of modelOptions) {
    const option = document.createElement("option");
    option.value = entry.model;
    option.textContent = `${entry.model} · ${formatTokens(entry.totalTokens)}`;
    option.title = `${entry.model} · ${exactNumber.format(entry.totalTokens ?? 0)} tokens · ${exactNumber.format(entry.modelCalls ?? 0)} 次调用`;
    elements.runtimeModelFilter.append(option);
  }
  elements.runtimeModelFilter.disabled = modelOptions.length === 0;
  elements.runtimeModelFilter.value = runtimeModel;
  elements.runtimeFilterSummary.textContent = `${LANE_LABELS[runtimeLane]} · ${runtimeModel || "全部模型"}`;
}

function setRuntimeMetrics(totals = {}) {
  elements.runtimeTotal.textContent = formatTokens(totals.totalTokens);
  elements.runtimeTotal.title = exactNumber.format(totals.totalTokens ?? 0);
  elements.runtimeInput.textContent = formatTokens(totals.inputTokens);
  elements.runtimeCached.textContent = formatTokens(totals.cachedInputTokens);
  elements.runtimeOutput.textContent = formatTokens(totals.outputTokens);
  elements.runtimeUpstreamTokens.textContent = formatTokens(totals.upstreamTokens);
  elements.runtimeDownstreamTokens.textContent = formatTokens(totals.downstreamTokens);
  elements.runtimeRequests.textContent = formatTokens(totals.modelCalls ?? totals.requests);
  elements.runtimeUncached.textContent = `未缓存 ${formatTokens(totals.uncachedInputTokens)}`;
  elements.runtimeCacheRate.textContent = `缓存率 ${((totals.cacheRate ?? 0) * 100).toFixed(1)}%`;
  elements.runtimeReasoning.textContent = `含 reasoning ${formatTokens(totals.reasoningOutputTokens)}`;
  elements.runtimeSessions.textContent = `会话 ${formatTokens(totals.sessions)}`;
  elements.runtimeWindow.textContent = RANGE_LABELS[runtimeRange];
}

function setCoverage(element, lane, coverage) {
  const active = coverage?.status === "active";
  element.className = active ? "active" : "unavailable";
  if (active) {
    if (coverage.source === "cc-switch-session-log") {
      element.lastChild.textContent = `${lane} · CC Switch 会话记录已连接`;
    } else if (coverage.source === "claude-local-sessions") {
      element.lastChild.textContent = `${lane} · Claude 本地会话已连接`;
    } else {
      element.lastChild.textContent = `${lane} · 本地事件采集中`;
    }
  } else if (coverage?.status === "not-connected") {
    element.lastChild.textContent =
      coverage?.reason === "database-missing"
        ? `${lane} · 未检测到 CC Switch 数据库`
        : `${lane} · 未连接采集器`;
  } else {
    element.lastChild.textContent = `${lane} · 数据源不可用`;
  }
}

function renderCallsChart(usage) {
  const totals = usage.totals ?? {};
  const available = usage.available !== false;
  elements.callsTotal.textContent = formatTokens(
    available ? (totals.modelCalls ?? totals.requests) : undefined,
  );
  elements.callsUpstream.textContent = formatTokens(
    available ? totals.upstreamCalls : undefined,
  );
  elements.callsDownstream.textContent = formatTokens(
    available ? totals.downstreamCalls : undefined,
  );
  setCoverage(elements.coverageUpstream, "上游", usage.callCoverage?.upstream);
  setCoverage(elements.coverageDownstream, "下游", usage.callCoverage?.downstream);
  elements.callsChart.replaceChildren();

  const buckets = usage.buckets ?? [];
  const hasCalls = buckets.some((bucket) => (bucket.modelCalls ?? bucket.requests) > 0);
  elements.callsEmpty.hidden = hasCalls;
  if (!hasCalls) {
    elements.callsEmpty.textContent = available
      ? "所选时间范围内暂无模型调用"
      : "模型调用数据源不可用";
    return;
  }

  const width = 1120;
  const height = 230;
  const margin = { top: 14, right: 16, bottom: 38, left: 54 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const rawMaximum = Math.max(
    ...buckets.flatMap((bucket) => [bucket.upstreamCalls ?? 0, bucket.downstreamCalls ?? 0]),
  );
  const maximum = Math.max(4, Math.ceil(rawMaximum / 4) * 4);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${RANGE_LABELS[runtimeRange]}上游和下游模型调用次数`,
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
    label.textContent = exactNumber.format((maximum * tick) / 4);
    svg.append(label);
  }

  const slotWidth = plotWidth / buckets.length;
  const barWidth = Math.max(3, Math.min(16, slotWidth * 0.28));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 6));
  buckets.forEach((bucket, index) => {
    const center = margin.left + index * slotWidth + slotWidth / 2;
    const group = svgNode("g", { class: "calls-group" });
    const series = [
      ["upstream", bucket.upstreamCalls ?? 0, center - barWidth - 1],
      ["downstream", bucket.downstreamCalls ?? 0, center + 1],
    ];
    for (const [lane, value, x] of series) {
      const barHeight = (value / maximum) * plotHeight;
      group.append(
        svgNode("rect", {
          class: `calls-bar ${lane}`,
          x,
          y: margin.top + plotHeight - barHeight,
          width: barWidth,
          height: Math.max(0, barHeight),
          rx: 2,
        }),
      );
    }
    const title = svgNode("title");
    title.textContent = `${formatBucketLabel(bucket.start, runtimeRange)} · 上游 ${bucket.upstreamCalls ?? 0} 次 · 下游 ${bucket.downstreamCalls ?? 0} 次`;
    group.append(title);
    svg.append(group);

    if (index % labelEvery === 0 || index === buckets.length - 1) {
      const label = svgNode("text", {
        class: "runtime-axis-label",
        x: center,
        y: height - 13,
        "text-anchor": "middle",
      });
      label.textContent = formatBucketLabel(bucket.start, runtimeRange);
      svg.append(label);
    }
  });
  elements.callsChart.append(svg);
}

function renderRuntimeChart(usage) {
  elements.runtimeChart.replaceChildren();
  const laneView = runtimeTokenView === "lane";
  elements.runtimeLegendType.hidden = laneView;
  elements.runtimeLegendLane.hidden = !laneView;
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
    "aria-label": `${RANGE_LABELS[runtimeRange]} ${laneView ? "上游和下游" : "按类型"} Token 用量时序图`,
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
    const upstreamTokens =
      bucket.upstreamTokens ??
      (bucket.downstreamTokens === undefined ? bucket.totalTokens ?? 0 : 0);
    const segments = laneView
      ? [
          ["lane-upstream", upstreamTokens],
          ["lane-downstream", bucket.downstreamTokens ?? 0],
        ]
      : [
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
    title.textContent = laneView
      ? `${formatBucketLabel(bucket.start, runtimeRange)} · 总计 ${exactNumber.format(bucket.totalTokens)} · 上游 ${exactNumber.format(upstreamTokens)} · 下游 ${exactNumber.format(bucket.downstreamTokens ?? 0)}`
      : `${formatBucketLabel(bucket.start, runtimeRange)} · 总计 ${exactNumber.format(bucket.totalTokens)} · 未缓存输入 ${exactNumber.format(bucket.uncachedInputTokens)} · 缓存输入 ${exactNumber.format(bucket.cachedInputTokens)} · 输出 ${exactNumber.format(bucket.outputTokens)}`;
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

function renderRuntimeModels(models = [], totalTokens = 0) {
  elements.runtimeModels.replaceChildren();
  elements.runtimeModelCount.textContent = `${models.length} 个模型`;
  if (models.length === 0) {
    const empty = document.createElement("span");
    empty.className = "model-empty";
    empty.textContent = "当前筛选范围内暂无模型用量";
    elements.runtimeModels.append(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "model-usage-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const label of ["模型", "数据流", "Total", "Input", "Cached", "Output", "Calls"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);

  const body = document.createElement("tbody");
  for (const entry of models) {
    const row = document.createElement("tr");
    const model = document.createElement("th");
    model.scope = "row";
    model.textContent = entry.model;
    model.title = entry.model;

    const lane = document.createElement("td");
    const hasUpstream = (entry.upstreamCalls ?? 0) > 0;
    const hasDownstream = (entry.downstreamCalls ?? 0) > 0;
    lane.textContent = hasUpstream && hasDownstream ? "上下游" : hasDownstream ? "下游" : "上游";
    lane.className = hasUpstream && hasDownstream ? "both" : hasDownstream ? "downstream" : "upstream";

    const values = [
      entry.totalTokens,
      entry.inputTokens,
      entry.cachedInputTokens,
      entry.outputTokens,
      entry.modelCalls ?? entry.requests,
    ];
    row.append(model, lane);
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = formatTokens(value);
      cell.title = exactNumber.format(value ?? 0);
      if (index === 0 && totalTokens > 0) {
        const share = document.createElement("small");
        share.textContent = `${((value / totalTokens) * 100).toFixed(1)}%`;
        cell.append(share);
      }
      row.append(cell);
    });
    body.append(row);
  }
  table.append(body);
  elements.runtimeModels.append(table);
}

function renderRuntimeUsage(usage) {
  latestRuntimeUsage = usage;
  renderRuntimeFilters(usage.modelOptions);
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
    renderCallsChart(usage);
    elements.runtimeUpdated.textContent = "未采集数据";
    elements.runtimeDiagnostics.textContent = "数据源不可用 · 不读取消息内容";
    return;
  }
  elements.runtimeLive.className = "runtime-live";
  elements.runtimeLiveText.textContent = "实时采集";
  setRuntimeMetrics(usage.totals);
  renderRuntimeChart(usage);
  renderRuntimeModels(usage.models, usage.totals.totalTokens);
  renderCallsChart(usage);
  elements.runtimeUpdated.textContent = `更新于 ${new Date(usage.generatedAt).toLocaleTimeString("zh-CN")}`;
  const diagnostics = usage.diagnostics ?? {};
  const downstream = diagnostics.sources?.find((source) => source.lane === "downstream");
  const downstreamStatus =
    downstream?.status === "active"
      ? `${downstream.source === "claude-local-sessions" ? "Claude 本地" : "CC Switch"}下游 ${formatTokens(downstream.eventsRead)} 条`
      : "Claude 下游未连接";
  elements.runtimeDiagnostics.textContent = `${diagnostics.filesRead ?? 0} 个 Codex 会话文件 · ${downstreamStatus} · ${diagnostics.parseErrors ?? 0} 个无效事件 · 不保留消息内容`;
}

function renderRuntimeError(message) {
  latestRuntimeUsage = null;
  elements.runtimeLive.className = "runtime-live unavailable";
  elements.runtimeLiveText.textContent = "连接失败";
  setRuntimeMetrics();
  elements.runtimeChart.replaceChildren();
  elements.runtimeEmpty.hidden = false;
  elements.runtimeEmpty.textContent = `无法读取运行时用量：${message}`;
  elements.runtimeUpdated.textContent = "将在后台重试";
  elements.runtimeDiagnostics.textContent = "连接失败 · 不读取消息内容";
  renderRuntimeModels();
  renderCallsChart({
    available: false,
    totals: {},
    buckets: [],
    callCoverage: {
      upstream: { status: "unavailable" },
      downstream: { status: "not-connected" },
    },
  });
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function historyActionLabel(action) {
  switch (action) {
    case "activate":
      return "配置激活";
    case "restore-history":
      return "历史恢复";
    case "restore-backup":
      return "备份回滚";
    default:
      return action;
  }
}

function switchView(view) {
  activeView = view;
  const configuration = view === "configuration";
  const usage = view === "usage";
  const history = view === "history";
  elements.configurationTopbar.hidden = !configuration;
  elements.configurationWorkspace.hidden = !configuration;
  elements.usageView.hidden = !usage;
  elements.historyView.hidden = !history;
  elements.navConfiguration.classList.toggle("active", configuration);
  elements.navUsage.classList.toggle("active", usage);
  elements.navHistory.classList.toggle("active", history);
  if (usage) loadRuntimeUsage();
  if (history) loadHistory({ selectEntry: true });
}

function renderHistoryList() {
  elements.historyList.replaceChildren();
  const entries = historyData?.entries ?? [];
  elements.historyCount.hidden = entries.length === 0;
  elements.historyCount.textContent = String(entries.length);

  if (!historyData?.available) {
    elements.historyEmpty.hidden = false;
    elements.historyEmpty.textContent =
      historyData?.reason === "preview-only"
        ? "激活记录只追踪真实文件写入。设置 AGENT_WORKFLOW_SKILLS_DIR 并激活 Skill 后，记录会出现在这里。"
        : "激活记录当前不可用。";
    elements.historyStatus.textContent = "文件写入未启用";
    elements.historyIntegrity.textContent = "预览模式";
    elements.historyIntegrity.classList.remove("error");
    return;
  }

  elements.historyStatus.textContent = `${entries.length} 条不可变快照`;
  const corrupt = historyData.corruptEntries ?? 0;
  elements.historyIntegrity.textContent = corrupt === 0 ? "完整性通过" : `${corrupt} 条损坏记录`;
  elements.historyIntegrity.classList.toggle("error", corrupt > 0);
  elements.historyEmpty.hidden = entries.length > 0;
  if (entries.length === 0) {
    elements.historyEmpty.textContent = "尚无真实激活记录。完成一次文件系统激活后将在这里建立首个快照。";
    return;
  }

  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-entry${entry.historyId === selectedHistoryId ? " selected" : ""}${entry.action.startsWith("restore") ? " restore" : ""}`;
    button.dataset.historyId = entry.historyId;

    const icon = document.createElement("span");
    icon.className = "history-entry-icon";
    icon.textContent = entry.action.startsWith("restore") ? "↺" : "◆";
    const main = document.createElement("span");
    main.className = "history-entry-main";
    const title = document.createElement("strong");
    title.textContent = entry.variantId;
    const time = document.createElement("span");
    time.textContent = `${historyActionLabel(entry.action)} · ${formatHistoryDate(entry.recordedAt)}`;
    const mode = document.createElement("code");
    mode.textContent = `${entry.mode.id}@${entry.mode.version}`;
    main.append(title, time, mode);
    const state = document.createElement("span");
    state.className = `history-entry-state${entry.isActive ? " active" : ""}`;
    state.textContent = entry.isActive ? "当前" : "快照";
    button.append(icon, main, state);
    button.addEventListener("click", () => selectHistoryEntry(entry.historyId));
    elements.historyList.append(button);
  }
}

function renderHistoryMeta(entry) {
  elements.historyMeta.replaceChildren();
  const values = [
    ["Mode", `${entry.mode.id}@${entry.mode.version}`],
    ["Main agent", entry.mainAgentId],
    ["Profile", entry.profileId],
    ["Activated", formatHistoryDate(entry.activatedAt)],
  ];
  for (const [label, value] of values) {
    const item = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value ?? "—";
    content.title = value ?? "—";
    item.append(name, content);
    elements.historyMeta.append(item);
  }
}

function renderFieldChanges(changes) {
  elements.historyFieldDiff.replaceChildren();
  if (changes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "field-diff-empty";
    empty.textContent = "配置元数据与当前版本一致。";
    elements.historyFieldDiff.append(empty);
    return;
  }
  for (const change of changes) {
    const row = document.createElement("div");
    row.className = "field-diff";
    const field = document.createElement("span");
    field.textContent = change.field;
    const current = document.createElement("code");
    current.textContent = change.current ?? "∅";
    current.title = current.textContent;
    const arrow = document.createElement("i");
    arrow.textContent = "→";
    const historical = document.createElement("code");
    historical.textContent = change.historical ?? "∅";
    historical.title = historical.textContent;
    row.append(field, current, arrow, historical);
    elements.historyFieldDiff.append(row);
  }
}

function renderSkillDiff(diff) {
  elements.historySkillDiff.replaceChildren();
  if (!diff.available) {
    const unavailable = document.createElement("div");
    unavailable.className = "diff-unavailable";
    unavailable.textContent = "该快照过大，无法在浏览器中生成安全的逐行差异。";
    elements.historySkillDiff.append(unavailable);
    elements.historyDiffSummary.textContent = "差异过大";
    return;
  }
  elements.historyDiffSummary.textContent = `+${diff.summary.added} / −${diff.summary.removed}`;
  for (const line of diff.lines) {
    const row = document.createElement("div");
    row.className = `diff-line ${line.kind}`;
    const currentNumber = document.createElement("span");
    currentNumber.className = "diff-number";
    currentNumber.textContent = line.currentLine ?? "";
    const snapshotNumber = document.createElement("span");
    snapshotNumber.className = "diff-number";
    snapshotNumber.textContent = line.snapshotLine ?? "";
    const marker = document.createElement("span");
    marker.className = "diff-marker";
    marker.textContent = line.kind === "add" ? "+" : line.kind === "remove" ? "−" : "";
    const content = document.createElement("span");
    content.className = "diff-text";
    content.textContent = line.text || " ";
    row.append(currentNumber, snapshotNumber, marker, content);
    elements.historySkillDiff.append(row);
  }
}

function renderHistoryDetail(detail) {
  elements.historyPlaceholder.hidden = true;
  elements.historyDetail.hidden = false;
  elements.historyDetailTitle.textContent = detail.entry.variantId;
  elements.historyActiveBadge.hidden = !detail.entry.matchesActive;
  elements.historyActiveBadge.textContent = detail.entry.isActive ? "当前激活" : "内容已激活";
  renderHistoryMeta(detail.entry);
  renderFieldChanges(detail.fieldChanges);
  renderSkillDiff(detail.diff);
  elements.historyRestore.disabled = detail.entry.matchesActive;
  elements.historyRestoreNote.textContent = detail.entry.matchesActive
    ? "该快照已经是当前激活版本，无需恢复。"
    : "恢复前会自动备份当前受管 Skill，并新增一条审计记录。";
}

async function selectHistoryEntry(historyId) {
  selectedHistoryId = historyId;
  renderHistoryList();
  const request = ++historyRequest;
  elements.historyPlaceholder.hidden = false;
  elements.historyPlaceholder.querySelector("strong").textContent = "正在生成恢复差异";
  elements.historyPlaceholder.querySelector("p").textContent = "校验快照完整性并与当前 SKILL.md 对比。";
  elements.historyDetail.hidden = true;
  try {
    const detail = await requestJson(`/api/history/${encodeURIComponent(historyId)}`);
    if (request !== historyRequest || selectedHistoryId !== historyId) return;
    renderHistoryDetail(detail);
  } catch (error) {
    if (request !== historyRequest) return;
    elements.historyPlaceholder.hidden = false;
    elements.historyPlaceholder.querySelector("strong").textContent = "无法读取快照";
    elements.historyPlaceholder.querySelector("p").textContent = error.message;
  }
}

async function loadHistory(options = {}) {
  const request = ++historyRequest;
  elements.historyRefresh.disabled = true;
  try {
    const data = await requestJson("/api/history");
    if (request !== historyRequest) return;
    historyData = data;
    if (!data.entries.some((entry) => entry.historyId === selectedHistoryId)) {
      selectedHistoryId = data.entries.find((entry) => entry.isActive)?.historyId ?? data.entries[0]?.historyId ?? null;
    }
    renderHistoryList();
    if (options.selectEntry && selectedHistoryId) await selectHistoryEntry(selectedHistoryId);
    if (!selectedHistoryId) {
      elements.historyDetail.hidden = true;
      elements.historyPlaceholder.hidden = false;
    }
  } catch (error) {
    if (request !== historyRequest) return;
    historyData = { available: false, entries: [], reason: "request-failed" };
    renderHistoryList();
    elements.historyStatus.textContent = error.message;
    elements.historyIntegrity.textContent = "读取失败";
    elements.historyIntegrity.classList.add("error");
  } finally {
    elements.historyRefresh.disabled = false;
  }
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

function balancedBudgetFromControls() {
  return {
    mainReviewCalls: Number(elements.balancedMainCalls.value),
    downstreamCalls: Number(elements.balancedDownstreamCalls.value),
    advisorCalls: Number(elements.balancedAdvisorCalls.value),
    reservedFinalReviewCalls: Number(elements.balancedReservedCalls.value),
    maxTotalTokens: Number(elements.balancedTokenBudget.value),
  };
}

function initializeBalancedControls() {
  if (!BALANCED_MODE || !BALANCED_POLICY || !BALANCED_BUDGET) return;
  elements.balancedPolicyVersion.textContent = `${BALANCED_POLICY.id}@${BALANCED_POLICY.version}`;
  elements.balancedContextWindow.textContent = `${BALANCED_POLICY.contextAcquisitionSeconds}s`;
  elements.balancedActiveWindow.textContent = `${BALANCED_POLICY.activeWindowSeconds}s`;
  elements.balancedExtensionWindow.textContent = `${BALANCED_POLICY.progressExtensionSeconds}s`;
  elements.balancedHardCap.textContent = `${BALANCED_POLICY.hardCapSeconds}s`;
  elements.balancedMainCalls.value = String(BALANCED_BUDGET.mainReviewCalls);
  elements.balancedDownstreamCalls.value = String(BALANCED_BUDGET.downstreamCalls);
  elements.balancedAdvisorCalls.value = String(BALANCED_BUDGET.advisorCalls);
  elements.balancedReservedCalls.value = String(BALANCED_BUDGET.reservedFinalReviewCalls);
  elements.balancedTokenBudget.value = String(BALANCED_BUDGET.maxTotalTokens);
}

function applyBalancedBudgetToControls(budget) {
  if (!budget || typeof budget !== "object") return;
  const fields = [
    ["mainReviewCalls", elements.balancedMainCalls],
    ["downstreamCalls", elements.balancedDownstreamCalls],
    ["advisorCalls", elements.balancedAdvisorCalls],
    ["reservedFinalReviewCalls", elements.balancedReservedCalls],
    ["maxTotalTokens", elements.balancedTokenBudget],
  ];
  for (const [key, input] of fields) {
    if (Number.isInteger(budget[key]) && budget[key] >= 0) input.value = String(budget[key]);
  }
}

function renderBalancedRuns() {
  elements.balancedRunList.replaceChildren();
  elements.balancedRuntimeSummary.textContent =
    !balancedRunsAvailable
      ? "运行记录不可用"
      : balancedRuns.length === 0
        ? "尚无运行记录"
        : `${balancedRuns.length} 个持久化运行`;
  for (const run of balancedRuns.slice(0, 3)) {
    const item = document.createElement("div");
    item.className = "balanced-run";
    const id = document.createElement("code");
    id.textContent = run.taskId ?? run.runId;
    id.title = run.runId;
    const state = document.createElement("b");
    state.textContent = run.state;
    const budget = document.createElement("small");
    const used = run.budgetState?.used ?? {};
    const limits = run.budgetState?.limits ?? {};
    budget.textContent = `轮次 ${run.rounds ?? 0} · 下游 ${used.downstream ?? 0}/${limits.downstreamCalls ?? 0} · 审阅 ${used.main ?? 0}/${limits.mainReviewCalls ?? 0} · Token ${formatTokens(run.budgetState?.totalTokens ?? 0)}`;
    item.append(id, state, budget);
    elements.balancedRunList.append(item);
  }
}

async function loadBalancedRuns() {
  try {
    const result = await requestJson("/api/balanced/runs");
    balancedRuns = result.runs ?? [];
    balancedRunsAvailable = true;
  } catch {
    balancedRuns = [];
    balancedRunsAvailable = false;
  }
  renderBalancedRuns();
}

function renderModeCards() {
  elements.modeGrid.replaceChildren();
  for (const mode of BUILTIN_MODE_CATALOG.modes) {
    const isActive = serverStatus.writeEnabled
      ? serverStatus.active?.mode?.id === mode.id
      : getInstalledState()[0]?.modeId === mode.id;
    const isApplying =
      modeSwitchState.active === mode.id || modeSwitchState.pending === mode.id;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `mode-card${mode.id === selectedModeId ? " selected" : ""}${isActive ? " active-installed" : ""}${isApplying ? " applying" : ""}`;
    button.dataset.mode = mode.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(mode.id === selectedModeId));
    button.setAttribute("aria-busy", String(isApplying));

    const top = document.createElement("div");
    top.className = "mode-top";
    const name = document.createElement("strong");
    name.textContent = mode.displayName;
    const indicators = document.createElement("span");
    indicators.className = "mode-indicators";
    if (isApplying || isActive) {
      const state = document.createElement("span");
      state.className = `mode-state${isApplying ? " applying" : ""}`;
      state.textContent = isApplying ? "APPLYING" : "ACTIVE";
      indicators.append(state);
    }
    const radio = document.createElement("span");
    radio.className = "radio";
    indicators.append(radio);
    top.append(name, indicators);

    const description = document.createElement("p");
    description.textContent = MODE_COPY[mode.id] ?? mode.description;
    const version = document.createElement("code");
    version.textContent = `${mode.id}@${mode.version}`;
    button.append(top, description, version);
    button.addEventListener("click", () => {
      selectedModeId = mode.id;
      renderModeCards();
      refresh();
      modeSwitchCoordinator.request(mode.id);
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
  const profile = {
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
  if (mode.kind === "balanced") profile.balancedBudget = balancedBudgetFromControls();
  return profile;
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
  if (!serverStatusLoaded) {
    elements.modeSwitchPolicy.textContent = "正在读取激活策略";
  } else if (serverStatus.writeEnabled && storeIsHealthy()) {
    elements.modeSwitchPolicy.textContent = "选择即备份并激活";
  } else if (serverStatus.writeEnabled) {
    elements.modeSwitchPolicy.textContent = "自动切换已阻止";
  } else if (serverStatus.health === "preview-only") {
    elements.modeSwitchPolicy.textContent = "选择仅切换预览";
  } else {
    elements.modeSwitchPolicy.textContent = "激活状态不可用";
  }
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
  const balanced = selectedModeId === "balanced";
  elements.builderAgent.disabled = interactive;
  elements.builderField.classList.toggle("native-mode", interactive);
  elements.builderHelp.textContent = interactive
    ? "Interactive 使用主 Agent 原生 subagent"
    : "接收实现任务的外部 Agent";
  elements.balancedConfig.hidden = !balanced;
  elements.activationStep.textContent = balanced ? "04" : "03";

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
    elements.activateButton.textContent = modeSwitchState.running
      ? `正在应用 ${modeDisplayName(modeSwitchState.active ?? modeSwitchState.pending)}`
      : "激活到 Codex Skill 目录";
    elements.activationNote.textContent = modeSwitchState.running
      ? "模式写入正在串行执行；新的选择会覆盖等待中的旧选择。"
      : installed
        ? `文件系统当前激活：${installed.variantId}`
        : `目标目录：${serverStatus.skillsDir}`;
  } else {
    elements.activateButton.textContent = "设为当前预览 Skill";
    elements.activationNote.textContent = installed
      ? `浏览器当前记录：${installed.variantId}`
      : "保存只影响浏览器中的预览状态。";
  }
  if (modeSwitchState.running) elements.activateButton.disabled = true;
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
for (const input of [
  elements.balancedMainCalls,
  elements.balancedDownstreamCalls,
  elements.balancedAdvisorCalls,
  elements.balancedReservedCalls,
  elements.balancedTokenBudget,
]) {
  input.addEventListener("input", refresh);
}
async function requestJson(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.message ?? body.error ?? `Request failed: ${response.status}`);
  }
  return body;
}

function modeDisplayName(modeId) {
  return BUILTIN_MODE_CATALOG.modes.find((mode) => mode.id === modeId)?.displayName ?? modeId;
}

function synchronizeControlsWithActiveSkill() {
  const active = serverStatus.active;
  if (!active) {
    const preview = !serverStatus.writeEnabled ? getInstalledState()[0] : null;
    const previewModeId = preview?.modeId;
    if (BUILTIN_MODE_CATALOG.modes.some((mode) => mode.id === previewModeId)) {
      selectedModeId = previewModeId;
    }
    applyBalancedBudgetToControls(preview?.balancedBudget);
    return;
  }
  if (BUILTIN_MODE_CATALOG.modes.some((mode) => mode.id === active.mode?.id)) {
    selectedModeId = active.mode.id;
  }
  if (
    typeof active.mainAgentId === "string" &&
    [...elements.mainAgent.options].some((option) => option.value === active.mainAgentId)
  ) {
    elements.mainAgent.value = active.mainAgentId;
  }
  const builderId = active.includedAgentIds?.find(
    (agentId) =>
      agentId !== active.mainAgentId &&
      [...elements.builderAgent.options].some((option) => option.value === agentId),
  );
  if (builderId) elements.builderAgent.value = builderId;
  applyBalancedBudgetToControls(active.balancedBudget);
}

function savePreviewSelection(modeId) {
  const resolution = resolveEffectiveSkill({
    profile: createProfile(modeId),
    agents: EXAMPLE_AGENTS,
    catalog: BUILTIN_MODE_CATALOG,
  });
  if (!resolution.ok) throw new Error("当前 Agent 绑定与所选模式不兼容。");
  localStorage.setItem(
    "agent-workflow-active-skill",
    JSON.stringify({
      variantId: resolution.value.id,
      modeId,
      relativeSkillPath: resolution.value.relativeSkillPath,
      contentFingerprint: resolution.value.contentFingerprint,
      balancedBudget: resolution.value.balancedBudget ?? null,
    }),
  );
}

function modeActivationMessage(modeId, result) {
  const mode = modeDisplayName(modeId);
  switch (result.activationKind) {
    case "activate":
      return `${mode} Skill 已激活；重启 Codex 后生效。`;
    case "overwrite":
      return `已备份当前 Skill，并覆写为 ${mode}；重启 Codex 后生效。`;
    default:
      return `${mode} 已经是当前 Skill。`;
  }
}

async function applyModeSwitch(modeId) {
  await serverStatusReady;
  try {
    if (serverStatus.writeEnabled) {
      if (!storeIsHealthy()) {
        throw new Error(serverStatus.error ?? "Skill 目录当前不可写。");
      }
      const result = await requestJson("/api/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: createProfile(modeId) }),
      });
      serverStatus = result.status;
      if (modeId === selectedModeId) showToast(modeActivationMessage(modeId, result));
      loadHistory();
    } else if (serverStatus.health === "preview-only") {
      savePreviewSelection(modeId);
      if (modeId === selectedModeId) {
        showToast(`${modeDisplayName(modeId)} 已切换为浏览器预览；尚未写入 Codex。`);
      }
    } else {
      throw new Error(serverStatus.error ?? "无法确认 Skill 激活状态。");
    }
  } catch (error) {
    if (modeId === selectedModeId) showToast(`模式切换失败：${error.message}`);
  } finally {
    renderModeCards();
    refresh();
  }
}

const modeSwitchCoordinator = createLatestSwitchCoordinator({
  apply: applyModeSwitch,
  onState(state) {
    modeSwitchState = state;
    renderModeCards();
    refresh();
  },
});

async function loadRuntimeUsage() {
  if (usageLoading) {
    usageRefreshQueued = true;
    return;
  }
  usageLoading = true;
  const requested = {
    range: runtimeRange,
    lane: runtimeLane,
    model: runtimeModel,
  };
  const stillCurrent = () =>
    requested.range === runtimeRange &&
    requested.lane === runtimeLane &&
    requested.model === runtimeModel;
  const query = new URLSearchParams({ range: requested.range, lane: requested.lane });
  if (requested.model) query.set("model", requested.model);
  try {
    const usage = await requestJson(`/api/usage?${query}`);
    if (!stillCurrent()) return;
    if (
      requested.model &&
      !usage.modelOptions?.some((entry) => entry.model === requested.model)
    ) {
      runtimeModel = "";
      renderRuntimeFilters(usage.modelOptions);
      usageRefreshQueued = true;
      return;
    }
    renderRuntimeUsage(usage);
  } catch (error) {
    if (stillCurrent()) renderRuntimeError(error.message);
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
    synchronizeControlsWithActiveSkill();
  } catch (error) {
    serverStatus = {
      writeEnabled: false,
      health: "status-unavailable",
      active: null,
      backups: [],
      error: error.message,
    };
  } finally {
    serverStatusLoaded = true;
    markServerStatusReady?.();
    markServerStatusReady = null;
  }
  renderModeCards();
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
      showToast(modeActivationMessage(selectedModeId, result));
      loadHistory();
    } catch (error) {
      showToast(`激活失败：${error.message}`);
    }
    renderModeCards();
    refresh();
    return;
  }
  savePreviewSelection(selectedModeId);
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
    synchronizeControlsWithActiveSkill();
    showToast(`已回滚到 ${result.status.active.variantId}；重启 Codex 后生效。`);
    loadHistory();
    renderModeCards();
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

elements.runtimeLaneFilter.addEventListener("change", () => {
  runtimeLane = elements.runtimeLaneFilter.value;
  runtimeModel = "";
  renderRuntimeFilters();
  loadRuntimeUsage();
});

elements.runtimeModelFilter.addEventListener("change", () => {
  runtimeModel = elements.runtimeModelFilter.value;
  elements.runtimeFilterSummary.textContent = `${LANE_LABELS[runtimeLane]} · ${runtimeModel || "全部模型"}`;
  loadRuntimeUsage();
});

elements.tokenDimension.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-token-view]");
  if (!button || !elements.tokenDimension.contains(button)) return;
  runtimeTokenView = button.dataset.tokenView;
  for (const candidate of elements.tokenDimension.querySelectorAll("button")) {
    candidate.classList.toggle("active", candidate === button);
    candidate.setAttribute("aria-pressed", String(candidate === button));
  }
  if (latestRuntimeUsage) renderRuntimeChart(latestRuntimeUsage);
});

elements.navConfiguration.addEventListener("click", () => switchView("configuration"));
elements.navUsage.addEventListener("click", () => switchView("usage"));
elements.navHistory.addEventListener("click", () => switchView("history"));
elements.historyRefresh.addEventListener("click", () =>
  loadHistory({ selectEntry: activeView === "history" }),
);
elements.historyRestore.addEventListener("click", async () => {
  if (!selectedHistoryId || !historyData) return;
  const entry = historyData.entries.find(
    (candidate) => candidate.historyId === selectedHistoryId,
  );
  if (!entry || entry.matchesActive) return;
  if (
    !window.confirm(
      `恢复 ${entry.variantId}？\n\n当前受管 Skill 会先自动备份，恢复操作也会写入激活记录。`,
    )
  ) {
    return;
  }
  elements.historyRestore.disabled = true;
  try {
    const result = await requestJson(
      `/api/history/${encodeURIComponent(selectedHistoryId)}/restore`,
      { method: "POST" },
    );
    serverStatus = result.status;
    synchronizeControlsWithActiveSkill();
    renderModeCards();
    refresh();
    showToast(
      result.changed
        ? `已恢复 ${result.status.active.variantId}；重启 Codex 后生效。`
        : "该快照已经是当前激活版本。",
    );
    await loadHistory({ selectEntry: true });
  } catch (error) {
    showToast(`恢复失败：${error.message}`);
    elements.historyRestore.disabled = false;
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && activeView === "usage") loadRuntimeUsage();
});

initializeAgentSelectors();
initializeBalancedControls();
renderModeCards();
refresh();
loadServerStatus();
loadHistory();
loadBalancedRuns();
window.setInterval(() => {
  if (!document.hidden && activeView === "usage") loadRuntimeUsage();
  if (!document.hidden && activeView === "configuration" && selectedModeId === "balanced") {
    loadBalancedRuns();
  }
}, 5000);
