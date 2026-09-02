import {
  BALANCED_BUDGET_LIMITS,
  BALANCED_TIMING_LIMITS,
  BUILTIN_MODE_CATALOG,
  CODEX_OVERNIGHT_CLAUDE_PROFILE,
  EXAMPLE_AGENTS,
  customizeEffectiveSkill,
  planSkillActivation,
  resolveEffectiveSkill,
} from "/contracts/index.js";
import { createLatestSwitchCoordinator } from "/mode-switch-coordinator.js";

const MODE_COPY = {
  overnight: "提交后由外部监控接管；可选择逐轮收缩至验收，或达标后持续扩张改进。",
  balanced: "每轮执行期间由上游休眠，外部 Runner 按调优窗口监控，并在轮次边界唤醒审阅。",
  interactive: "主 Agent 保持前台，使用自身原生 subagent 并行协作。",
};

const OVERNIGHT_MODE = BUILTIN_MODE_CATALOG.modes.find((mode) => mode.kind === "overnight");
const OVERNIGHT_LOOP_POLICIES = (OVERNIGHT_MODE?.loopPolicies ?? []).flatMap((reference) => {
  const policy = BUILTIN_MODE_CATALOG.overnightLoopPolicies.find(
    (candidate) => candidate.id === reference.id && candidate.version === reference.version,
  );
  return policy ? [policy] : [];
});
const DEFAULT_OVERNIGHT_LOOP_POLICY = BUILTIN_MODE_CATALOG.overnightLoopPolicies.find(
  (policy) =>
    policy.id === OVERNIGHT_MODE?.defaultLoopPolicy.id &&
    policy.version === OVERNIGHT_MODE?.defaultLoopPolicy.version,
);
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
  balancedFirstProgressWindow: document.querySelector("#balanced-first-progress-window"),
  balancedGrowingExtensionWindow: document.querySelector("#balanced-growing-extension-window"),
  balancedHardCap: document.querySelector("#balanced-hard-cap"),
  balancedMainCalls: document.querySelector("#balanced-main-calls"),
  balancedPolicyVersion: document.querySelector("#balanced-policy-version"),
  balancedReservedCalls: document.querySelector("#balanced-reserved-calls"),
  balancedRunList: document.querySelector("#balanced-run-list"),
  balancedRuntimeSummary: document.querySelector("#balanced-runtime-summary"),
  builderAgent: document.querySelector("#builder-agent"),
  builderField: document.querySelector("#builder-field"),
  builderHelp: document.querySelector("#builder-help"),
  compatibilityBadge: document.querySelector("#compatibility-badge"),
  coordinationCoverageInvoke: document.querySelector("#coordination-coverage-invoke"),
  coordinationCoverageMessage: document.querySelector("#coordination-coverage-message"),
  coordinationCoverageRead: document.querySelector("#coordination-coverage-read"),
  coordinationCoverageWrite: document.querySelector("#coordination-coverage-write"),
  coordinationDetailClose: document.querySelector("#coordination-detail-close"),
  coordinationDetailPanel: document.querySelector("#coordination-detail-panel"),
  coordinationDetailStatus: document.querySelector("#coordination-detail-status"),
  coordinationDetailTitle: document.querySelector("#coordination-detail-title"),
  coordinationEventList: document.querySelector("#coordination-event-list"),
  coordinationEvents: document.querySelector("#coordination-events"),
  coordinationInvocations: document.querySelector("#coordination-invocations"),
  coordinationGraphShell: document.querySelector("#coordination-graph-shell"),
  coordinationReads: document.querySelector("#coordination-reads"),
  coordinationReadsAllowed: document.querySelector("#coordination-reads-allowed"),
  coordinationReadsOutOfScope: document.querySelector("#coordination-reads-out-of-scope"),
  coordinationReadsForbidden: document.querySelector("#coordination-reads-forbidden"),
  coordinationReadsUnknown: document.querySelector("#coordination-reads-unknown"),
  coordinationReadsRepeated: document.querySelector("#coordination-reads-repeated"),
  coordinationReadArtifacts: document.querySelector("#coordination-read-artifacts"),
  coordinationReadViolations: document.querySelector("#coordination-read-violations"),
  coordinationTopologyNodes: document.querySelector("#coordination-topology-nodes"),
  coordinationTopologyRelationships: document.querySelector("#coordination-topology-relationships"),
  coordinationMaxReaderFanOut: document.querySelector("#coordination-max-reader-fanout"),
  coordinationReaderLinks: document.querySelector("#coordination-reader-links"),
  coordinationRefresh: document.querySelector("#coordination-refresh"),
  coordinationReviews: document.querySelector("#coordination-reviews"),
  coordinationRunList: document.querySelector("#coordination-run-list"),
  coordinationRuns: document.querySelector("#coordination-runs"),
  coordinationTransitions: document.querySelector("#coordination-transitions"),
  coordinationUpdated: document.querySelector("#coordination-updated"),
  coordinationView: document.querySelector("#coordination-view"),
  coordinationWrites: document.querySelector("#coordination-writes"),
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
  historyRunList: document.querySelector("#history-run-list"),
  historyRunSummary: document.querySelector("#history-run-summary"),
  historyScopeFilter: document.querySelector("#history-scope-filter"),
  historyRestore: document.querySelector("#history-restore"),
  historyRestoreNote: document.querySelector("#history-restore-note"),
  historySkillDiff: document.querySelector("#history-skill-diff"),
  historyStatus: document.querySelector("#history-status"),
  historyView: document.querySelector("#history-view"),
  includedAgents: document.querySelector("#included-agents"),
  includedModes: document.querySelector("#included-modes"),
  integrationList: document.querySelector("#integration-list"),
  integrationPlanClose: document.querySelector("#integration-plan-close"),
  integrationPlanMeta: document.querySelector("#integration-plan-meta"),
  integrationPlanPanel: document.querySelector("#integration-plan-panel"),
  integrationPlanSteps: document.querySelector("#integration-plan-steps"),
  integrationPlanTitle: document.querySelector("#integration-plan-title"),
  integrationsConfigured: document.querySelector("#integrations-configured"),
  integrationsHarness: document.querySelector("#integrations-harness"),
  integrationsInstalled: document.querySelector("#integrations-installed"),
  integrationsProjectBrowse: document.querySelector("#integrations-project-browse"),
  integrationsProjectRoot: document.querySelector("#integrations-project-root"),
  integrationsRefresh: document.querySelector("#integrations-refresh"),
  integrationsScope: document.querySelector("#integrations-scope"),
  integrationsStatus: document.querySelector("#integrations-status"),
  integrationsTotal: document.querySelector("#integrations-total"),
  integrationsView: document.querySelector("#integrations-view"),
  workflowSourcePanel: document.querySelector("#workflow-source-panel"),
  workflowSourceHealth: document.querySelector("#workflow-source-health"),
  workflowSourceVersion: document.querySelector("#workflow-source-version"),
  workflowSourceSupport: document.querySelector("#workflow-source-support"),
  workflowSourceHash: document.querySelector("#workflow-source-hash"),
  workflowSourceRuntime: document.querySelector("#workflow-source-runtime"),
  workflowSourcePath: document.querySelector("#workflow-source-path"),
  workflowSourceDiagnostic: document.querySelector("#workflow-source-diagnostic"),
  workflowSourceDiagnose: document.querySelector("#workflow-source-diagnose"),
  interactiveAgentHealth: document.querySelector("#interactive-agent-health"),
  interactiveAddRole: document.querySelector("#interactive-add-role"),
  interactiveAgentList: document.querySelector("#interactive-agent-list"),
  interactiveAgentOverwrite: document.querySelector("#interactive-agent-overwrite"),
  interactiveConfig: document.querySelector("#interactive-config"),
  interactiveConflictDetail: document.querySelector("#interactive-conflict-detail"),
  interactiveDefaultEffort: document.querySelector("#interactive-default-effort"),
  interactiveDefaultModel: document.querySelector("#interactive-default-model"),
  interactiveInstallDetail: document.querySelector("#interactive-install-detail"),
  interactiveInstallTitle: document.querySelector("#interactive-install-title"),
  interactiveMaxThreads: document.querySelector("#interactive-max-threads"),
  interactiveOverwriteRow: document.querySelector("#interactive-overwrite-row"),
  interactiveRedo: document.querySelector("#interactive-redo"),
  interactiveRevert: document.querySelector("#interactive-revert"),
  interactiveResetRoles: document.querySelector("#interactive-reset-roles"),
  interactiveRoleCount: document.querySelector("#interactive-role-count"),
  interactiveUndo: document.querySelector("#interactive-undo"),
  issueList: document.querySelector("#issue-list"),
  mainAgent: document.querySelector("#main-agent"),
  modeGrid: document.querySelector("#mode-grid"),
  modeSwitchNoteCopy: document.querySelector("#mode-switch-note-copy"),
  modeSwitchPolicy: document.querySelector("#mode-switch-policy"),
  overnightCompletionRule: document.querySelector("#overnight-completion-rule"),
  overnightConfig: document.querySelector("#overnight-config"),
  overnightLoopPolicy: document.querySelector("#overnight-loop-policy"),
  overnightPolicyDescription: document.querySelector("#overnight-policy-description"),
  overnightPolicyVersion: document.querySelector("#overnight-policy-version"),
  overnightRunList: document.querySelector("#overnight-run-list"),
  overnightRuntimeSummary: document.querySelector("#overnight-runtime-summary"),
  projectConfigCheck: document.querySelector("#project-config-check"),
  projectConfigBrowse: document.querySelector("#project-config-browse"),
  projectConfigClear: document.querySelector("#project-config-clear"),
  projectConfigHash: document.querySelector("#project-config-hash"),
  projectConfigId: document.querySelector("#project-config-id"),
  projectConfigInitialize: document.querySelector("#project-config-initialize"),
  projectConfigMigrate: document.querySelector("#project-config-migrate"),
  projectConfigPublish: document.querySelector("#project-config-publish"),
  projectConfigRestore: document.querySelector("#project-config-restore"),
  projectConfigRevision: document.querySelector("#project-config-revision"),
  projectConfigRoot: document.querySelector("#project-config-root"),
  projectConfigSave: document.querySelector("#project-config-save"),
  projectConfigSource: document.querySelector("#project-config-source"),
  projectConfigStatus: document.querySelector("#project-config-status"),
  projectConfigWorkspace: document.querySelector("#project-config-workspace"),
  projectCurrentActive: document.querySelector("#project-current-active"),
  projectCurrentActivate: document.querySelector("#project-current-activate"),
  projectCurrentBuilder: document.querySelector("#project-current-builder"),
  projectCurrentIntegrations: document.querySelector("#project-current-integrations"),
  projectCurrentMain: document.querySelector("#project-current-main"),
  projectCurrentMode: document.querySelector("#project-current-mode"),
  projectCurrentName: document.querySelector("#project-current-name"),
  projectCurrentPath: document.querySelector("#project-current-path"),
  projectCurrentRun: document.querySelector("#project-current-run"),
  projectCurrentRunAction: document.querySelector("#project-current-run-action"),
  projectCurrentTools: document.querySelector("#project-current-tools"),
  projectSkillAppendix: document.querySelector("#project-skill-appendix"),
  recentProjectList: document.querySelector("#recent-project-list"),
  recentProjectRefresh: document.querySelector("#recent-project-refresh"),
  recentProjectStatus: document.querySelector("#recent-project-status"),
  overnightScopeRule: document.querySelector("#overnight-scope-rule"),
  navConfiguration: document.querySelector("#nav-configuration"),
  navHistory: document.querySelector("#nav-history"),
  navIntegrations: document.querySelector("#nav-integrations"),
  navTaskCard: document.querySelector("#nav-task-card"),
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
  runtimeLoadStatus: document.querySelector("#runtime-load-status"),
  runtimeLoadStatusText: document.querySelector("#runtime-load-status-text"),
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
  restoreSkillDefault: document.querySelector("#restore-skill-default"),
  skillDraftState: document.querySelector("#skill-draft-state"),
  skillPath: document.querySelector("#skill-path"),
  skillPreview: document.querySelector("#skill-preview"),
  storeStatusDetail: document.querySelector("#store-status-detail"),
  storeStatusTitle: document.querySelector("#store-status-title"),
  taskCardEditor: document.querySelector("#task-card-editor"),
  taskCardEditorSwitch: document.querySelector("#task-card-editor-switch"),
  taskCardEnvironmentIsolation: document.querySelector("#task-card-environment-isolation"),
  taskCardExecutionEnvironment: document.querySelector("#task-card-execution-environment"),
  taskCardExport: document.querySelector("#task-card-export"),
  taskCardForm: document.querySelector("#task-card-form"),
  taskCardImport: document.querySelector("#task-card-import"),
  taskCardImportInput: document.querySelector("#task-card-import-input"),
  taskCardMarkdown: document.querySelector("#task-card-markdown"),
  taskCardMessage: document.querySelector("#task-card-message"),
  taskCardNetworkDiagnostics: document.querySelector("#task-card-network-diagnostics"),
  taskCardAdapter: document.querySelector("#task-card-adapter"),
  taskCardConnectivityResult: document.querySelector("#task-card-connectivity-result"),
  taskCardConnectivityRun: document.querySelector("#task-card-connectivity-run"),
  taskCardPreflightResult: document.querySelector("#task-card-preflight-result"),
  taskCardPreflightRun: document.querySelector("#task-card-preflight-run"),
  taskCardPreflightState: document.querySelector("#task-card-preflight-state"),
  taskCardProxyMode: document.querySelector("#task-card-proxy-mode"),
  taskCardRedo: document.querySelector("#task-card-redo"),
  taskCardRevert: document.querySelector("#task-card-revert"),
  taskCardReset: document.querySelector("#task-card-reset"),
  taskCardState: document.querySelector("#task-card-state"),
  taskCardStrategy: document.querySelector("#task-card-strategy"),
  taskCardStrategyField: document.querySelector("#task-card-strategy-field"),
  taskCardUndo: document.querySelector("#task-card-undo"),
  taskCardViewSwitch: document.querySelector("#task-card-view-switch"),
  taskCardView: document.querySelector("#task-card-view"),
  taskCardWorkflowMode: document.querySelector("#task-card-workflow-mode"),
  taskCardWorktree: document.querySelector("#task-card-worktree"),
  toast: document.querySelector("#toast"),
  tokenEstimate: document.querySelector("#token-estimate"),
  tokenDimension: document.querySelector("#token-dimension"),
  tokenChart: document.querySelector("#token-chart"),
  tokenChartSummary: document.querySelector("#token-chart-summary"),
  usageView: document.querySelector("#usage-view"),
  variantName: document.querySelector("#variant-name"),
};

// The temporal detail belongs to the unified activity page even though its
// markup is shared with the coordination summary above the activation list.
elements.historyView.append(elements.coordinationDetailPanel);

let selectedModeId = "overnight";
let currentResolution = null;
let currentDefaultResolution = null;
let currentDraftKey = null;
const skillDrafts = new Map();
let serverStatus = {
  writeEnabled: false,
  health: "loading",
  active: null,
  backups: [],
};
let interactiveAgentStatus = {
  writeEnabled: false,
  health: "loading",
  conflicts: [],
  agents: [],
  preset: { globalSettings: {}, agents: [] },
};
let interactiveAgentStatusLoaded = false;
let interactiveAgentConfiguration = null;
let interactiveAgentCatalog = { models: [], reasoningEfforts: [], sandboxModes: [], limits: {} };
let interactiveEditorFingerprint = null;
let interactivePlanTimer = null;
let interactivePlanRequest = 0;
let interactivePlanPending = false;
let interactiveHistorySnapshot = null;
let interactiveBaselineConfiguration = null;
let interactiveHistoryGroup = null;
let interactiveHistoryAt = 0;
const interactiveUndoStack = [];
const interactiveRedoStack = [];
const interactiveOpenRoles = new Set();
let toastTimer;
let runtimeRange = "24h";
let runtimeTokenView = "type";
let runtimeLane = "all";
let runtimeModel = "";
let latestRuntimeUsage = null;
let usageLoading = false;
let usageRefreshQueued = false;
let runtimeLoadStatusTimer = null;
let runtimeLoadStatusHideTimer = null;
let activeView = "configuration";
let historyData = null;
let selectedHistoryId = null;
let historyRequest = 0;
let balancedRuns = [];
let balancedRunsAvailable = true;
let overnightRuns = [];
let overnightRunsAvailable = true;
let taskCardTemplate = null;
let taskCardDraft = null;
let taskCardBaseline = null;
let validatedTaskCard = null;
let taskCardValidationTimer = null;
let taskCardValidationRequest = 0;
let taskCardProjectionView = "audit";
let taskCardProjections = { audit: "", execution: "" };
let taskCardEditorView = "form";
let taskCardErrorPath = null;
let taskCardLastEditorValue = "";
let taskCardHistoryGroup = null;
let taskCardHistoryAt = 0;
let taskCardSetBaselineOnValidation = false;
let taskCardPreflightOptions = { workflowModes: [], overnightStrategies: [], adapters: [] };
let taskCardConnectivityRunning = false;
let integrationsData = null;
let integrationsLoading = false;
let integrationsRefreshQueued = false;
let projectConfigState = null;
let projectConfigLoading = false;
let recentProjectsData = { projects: [], corruptEntries: 0 };
let recentProjectsLoading = false;
let recentProjectsRefreshQueued = false;
let directoryPickerLoading = false;
let workflowSourceData = null;
let selectedCoordinationRun = null;
let coordinationDetailRequest = 0;
const integrationDiagnostics = new Map();
const taskCardUndoStack = [];
const taskCardRedoStack = [];
const taskCardOpenSections = new Set([
  "identity", "scope", "acceptance", "risk", "handoff", "validation", "stop", "extensions",
]);
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

const TASK_CARD_DRAFT_KEY = "agent-workflow-task-card-draft";
const TASK_CARD_PREFLIGHT_KEY = "agent-workflow-task-card-preflight";
const INTEGRATION_PROJECT_KEY = "agent-workflow-integration-project-root";
const TASK_CARD_MODES = ["builder", "checker-test", "mixed-exception", "control-plane"];
const TASK_CARD_RISKS = [
  "public_api", "data_model", "security", "migration", "permission",
  "concurrency", "cross_module", "production_impact",
];
const TASK_CARD_HANDOFF = ["must_do", "must_not_do", "may_decide", "must_report", "stop_condition"];

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

function clearRuntimeLoadStatusTimers() {
  clearTimeout(runtimeLoadStatusTimer);
  clearTimeout(runtimeLoadStatusHideTimer);
  runtimeLoadStatusTimer = null;
  runtimeLoadStatusHideTimer = null;
}

function showRuntimeLoadStatus(state) {
  clearRuntimeLoadStatusTimers();
  elements.runtimeLoadStatus.hidden = false;
  elements.runtimeLoadStatus.className = `runtime-load-status ${state}`;
  elements.runtimeLoadStatusText.textContent = state === "loading"
    ? "正在载入用量数据…"
    : "加载完成";
  if (state !== "complete") return;
  runtimeLoadStatusTimer = setTimeout(() => {
    elements.runtimeLoadStatus.classList.add("fading");
    runtimeLoadStatusHideTimer = setTimeout(() => {
      elements.runtimeLoadStatus.hidden = true;
      elements.runtimeLoadStatus.className = "runtime-load-status";
    }, 260);
  }, 1000);
}

function hideRuntimeLoadStatus() {
  clearRuntimeLoadStatusTimers();
  elements.runtimeLoadStatus.hidden = true;
  elements.runtimeLoadStatus.className = "runtime-load-status";
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

function switchView(view, options = {}) {
  activeView = view;
  const configuration = view === "configuration";
  const taskCard = view === "task-card";
  const integrations = view === "integrations";
  const usage = view === "usage";
  const history = view === "history";
  elements.configurationTopbar.hidden = !configuration;
  elements.configurationWorkspace.hidden = !configuration;
  elements.taskCardView.hidden = !taskCard;
  elements.integrationsView.hidden = !integrations;
  elements.usageView.hidden = !usage;
  elements.coordinationView.hidden = !history;
  elements.historyView.hidden = !history;
  elements.navConfiguration.classList.toggle("active", configuration);
  elements.navTaskCard.classList.toggle("active", taskCard);
  elements.navIntegrations.classList.toggle("active", integrations);
  elements.navUsage.classList.toggle("active", usage);
  elements.navHistory.classList.toggle("active", history);
  if (taskCard && ["overnight", "balanced"].includes(selectedModeId)) {
    elements.taskCardWorkflowMode.value = selectedModeId;
    synchronizeTaskCardStrategy();
  }
  if (options.load !== false && integrations && !integrationsData) loadIntegrations();
  if (options.load !== false && usage) loadRuntimeUsage();
  if (options.load !== false && history) {
    loadCoordination();
    loadHistory({ selectEntry: true });
  }
}

function setTaskCardState(state, message) {
  const labels = {
    pending: "正在校验",
    valid: "有效",
    invalid: "无效",
    unavailable: "不可用",
  };
  elements.taskCardState.className = `task-card-state ${state}`;
  elements.taskCardState.textContent = labels[state] ?? state;
  elements.taskCardMessage.className = `task-card-message ${state}`;
  elements.taskCardMessage.textContent = message;
}

function taskCardSnapshot(value = elements.taskCardEditor.value) {
  return value;
}

function taskCardPath(path) {
  return JSON.stringify(path);
}

function taskCardPathLabel(path) {
  return path.map((part) => typeof part === "number" ? `[${part}]` : part).join(".").replaceAll(".[", "[");
}

function taskCardDisplayErrorPath(path) {
  if (!path) return null;
  let result = path.startsWith("task.") ? path.slice(5) : path;
  const acceptanceReference = result.match(/^acceptance\.([A-Za-z0-9._-]+)\.(.+)$/);
  if (acceptanceReference && taskCardDraft?.acceptance) {
    const index = taskCardDraft.acceptance.findIndex((entry) => entry.id === acceptanceReference[1]);
    if (index >= 0) result = `acceptance[${index}].${acceptanceReference[2]}`;
  }
  return result;
}

function openTaskCardErrorSection(path) {
  const section = path?.match(/^[A-Za-z_]+/)?.[0];
  const mapped = {
    schema_version: "identity", id: "identity", mode: "identity", goal: "identity", profiles: "identity",
    scope: "scope", acceptance: "acceptance", risk: "risk", handoff: "handoff",
    validation: "validation", stop_conditions: "stop", extensions: "extensions",
  }[section];
  if (mapped) taskCardOpenSections.add(mapped);
}

function taskCardClone(value) {
  return structuredClone(value);
}

function setTaskCardValue(target, path, value, { removeEmpty = false } = {}) {
  let parent = target;
  for (let index = 0; index < path.length - 1; index += 1) parent = parent[path[index]];
  const key = path.at(-1);
  if (removeEmpty && value === "") delete parent[key];
  else parent[key] = value;
}

function updateTaskCardHistoryButtons() {
  elements.taskCardUndo.disabled = taskCardUndoStack.length === 0;
  elements.taskCardRedo.disabled = taskCardRedoStack.length === 0;
  elements.taskCardRevert.disabled = !taskCardBaseline || taskCardSnapshot() === taskCardBaseline;
}

function recordTaskCardHistory(previous, group = null) {
  const now = Date.now();
  if (
    previous !== taskCardUndoStack.at(-1) &&
    (group !== taskCardHistoryGroup || now - taskCardHistoryAt > 800)
  ) {
    taskCardUndoStack.push(previous);
    if (taskCardUndoStack.length > 100) taskCardUndoStack.shift();
  }
  taskCardHistoryGroup = group;
  taskCardHistoryAt = now;
  taskCardRedoStack.length = 0;
  updateTaskCardHistoryButtons();
}

function replaceTaskCardSnapshot(snapshot, { render = true } = {}) {
  elements.taskCardEditor.value = snapshot;
  taskCardLastEditorValue = snapshot;
  try {
    taskCardDraft = JSON.parse(snapshot);
    if (render) renderTaskCardForm();
  } catch {
    taskCardDraft = null;
  }
  queueTaskCardValidation({ preserveHistoryGroup: true });
  updateTaskCardHistoryButtons();
}

function commitTaskCardMutation(mutator, group, { render = false } = {}) {
  if (!taskCardDraft) return;
  const previous = taskCardSnapshot();
  const next = taskCardClone(taskCardDraft);
  mutator(next);
  const serialized = JSON.stringify(next, null, 2);
  if (serialized === previous) return;
  recordTaskCardHistory(previous, group);
  taskCardDraft = next;
  elements.taskCardEditor.value = serialized;
  taskCardLastEditorValue = serialized;
  if (render) renderTaskCardForm();
  queueTaskCardValidation({ preserveHistoryGroup: true });
  updateTaskCardHistoryButtons();
}

function createTaskCardControl(labelText, control, path = null, help = null) {
  const label = document.createElement("label");
  label.className = "task-card-field";
  const title = document.createElement("span");
  title.textContent = labelText;
  label.append(title, control);
  if (help) {
    const note = document.createElement("small");
    note.textContent = help;
    label.append(note);
  }
  if (path && taskCardErrorPath) {
    const fieldPath = taskCardPathLabel(path);
    if (taskCardErrorPath === fieldPath || taskCardErrorPath.startsWith(`${fieldPath}.`)) {
      label.classList.add("invalid");
    }
  }
  return label;
}

function createTaskCardInput(path, value, options = {}) {
  const control = document.createElement(options.multiline ? "textarea" : "input");
  if (!options.multiline) control.type = options.type ?? "text";
  control.value = value ?? "";
  control.dataset.taskPath = taskCardPath(path);
  if (options.valueType) control.dataset.taskValueType = options.valueType;
  if (options.removeEmpty) control.dataset.taskRemoveEmpty = "true";
  if (options.rerender) control.dataset.taskRerender = "true";
  if (options.placeholder) control.placeholder = options.placeholder;
  if (options.disabled) control.disabled = true;
  return control;
}

function createTaskCardSelect(path, value, values, options = {}) {
  const control = document.createElement("select");
  control.dataset.taskPath = taskCardPath(path);
  if (options.removeEmpty) control.dataset.taskRemoveEmpty = "true";
  if (options.rerender) control.dataset.taskRerender = "true";
  for (const entry of values) {
    const choice = typeof entry === "string" ? { value: entry, label: entry } : entry;
    control.append(option(choice.value, choice.label));
  }
  control.value = value ?? "";
  return control;
}

function createTaskCardSection(id, title, summary) {
  const section = document.createElement("details");
  section.className = "task-card-section";
  section.dataset.taskSection = id;
  section.open = taskCardOpenSections.has(id);
  const heading = document.createElement("summary");
  const name = document.createElement("strong");
  name.textContent = title;
  const meta = document.createElement("span");
  meta.textContent = summary;
  heading.append(name, meta);
  const body = document.createElement("div");
  body.className = "task-card-section-body";
  section.append(heading, body);
  section.addEventListener("toggle", () => {
    if (section.open) taskCardOpenSections.add(id);
    else taskCardOpenSections.delete(id);
  });
  return { section, body };
}

function createTaskCardRemoveButton(path, index, label = "删除") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-card-remove";
  button.dataset.taskAction = "remove";
  button.dataset.taskPath = taskCardPath(path);
  button.dataset.taskIndex = String(index);
  button.setAttribute("aria-label", label);
  button.textContent = "−";
  return button;
}

function createTaskCardAddButton(path, kind, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "task-card-add";
  button.dataset.taskAction = "add";
  button.dataset.taskPath = taskCardPath(path);
  button.dataset.taskKind = kind;
  button.textContent = `＋ ${label}`;
  return button;
}

function appendTaskCardTextList(body, label, path, values, placeholder) {
  const group = document.createElement("div");
  group.className = "task-card-list-group";
  const title = document.createElement("strong");
  title.textContent = label;
  group.append(title);
  values.forEach((value, index) => {
    const row = document.createElement("div");
    row.className = "task-card-list-row";
    row.append(
      createTaskCardInput([...path, index], value, { placeholder }),
      createTaskCardRemoveButton(path, index, `删除 ${label} 第 ${index + 1} 项`),
    );
    group.append(row);
  });
  group.append(createTaskCardAddButton(path, "text", `添加${label}`));
  body.append(group);
}

function renderTaskCardForm() {
  elements.taskCardForm.replaceChildren();
  if (!taskCardDraft || typeof taskCardDraft !== "object") {
    const empty = document.createElement("p");
    empty.className = "task-card-form-empty";
    empty.textContent = "JSON 有效后才会显示结构化编辑器。";
    elements.taskCardForm.append(empty);
    return;
  }
  const task = taskCardDraft;

  const identity = createTaskCardSection("identity", "任务身份与目标", `${task.id ?? "—"} · ${task.mode ?? "—"}`);
  const identityGrid = document.createElement("div");
  identityGrid.className = "task-card-field-grid";
  identityGrid.append(
    createTaskCardControl("Schema", createTaskCardInput(["schema_version"], task.schema_version, { disabled: true }), ["schema_version"]),
    createTaskCardControl("稳定任务 ID", createTaskCardInput(["id"], task.id), ["id"]),
    createTaskCardControl("执行角色", createTaskCardSelect(["mode"], task.mode, TASK_CARD_MODES), ["mode"]),
  );
  identity.body.append(identityGrid);
  identity.body.append(createTaskCardControl(
    "目标",
    createTaskCardInput(["goal"], task.goal, { multiline: true }),
    ["goal"],
    "描述一个有边界、可验收的结果。",
  ));
  appendTaskCardTextList(identity.body, "Profile", ["profiles"], task.profiles ?? [], "base");
  elements.taskCardForm.append(identity.section);

  const scope = createTaskCardSection("scope", "范围", `${task.scope?.write_paths?.length ?? 0} 个可写路径`);
  appendTaskCardTextList(scope.body, "可写路径", ["scope", "write_paths"], task.scope?.write_paths ?? [], "src/**");
  appendTaskCardTextList(scope.body, "只读路径", ["scope", "read_paths"], task.scope?.read_paths ?? [], "docs/**");
  appendTaskCardTextList(scope.body, "禁止路径", ["scope", "forbidden_paths"], task.scope?.forbidden_paths ?? [], ".env");
  elements.taskCardForm.append(scope.section);

  const acceptance = createTaskCardSection("acceptance", "验收标准", `${task.acceptance?.length ?? 0} 条`);
  const validationOptions = [
    { value: "", label: "不绑定验证命令" },
    ...(task.validation ?? []).map((entry) => ({ value: entry.id, label: entry.id })),
  ];
  (task.acceptance ?? []).forEach((entry, index) => {
    const card = document.createElement("div");
    card.className = "task-card-object-card";
    const cardHead = document.createElement("div");
    cardHead.className = "task-card-object-heading";
    const title = document.createElement("strong");
    title.textContent = entry.id || `验收 ${index + 1}`;
    cardHead.append(title, createTaskCardRemoveButton(["acceptance"], index, `删除验收 ${index + 1}`));
    const grid = document.createElement("div");
    grid.className = "task-card-field-grid two";
    grid.append(
      createTaskCardControl("稳定 ID", createTaskCardInput(["acceptance", index, "id"], entry.id, { rerender: true }), ["acceptance", index, "id"]),
      createTaskCardControl("验证绑定", createTaskCardSelect(
        ["acceptance", index, "validation_id"],
        entry.validation_id ?? "",
        validationOptions,
        { removeEmpty: true },
      ), ["acceptance", index, "validation_id"]),
    );
    card.append(cardHead, grid, createTaskCardControl(
      "可观察结果",
      createTaskCardInput(["acceptance", index, "description"], entry.description, { multiline: true }),
      ["acceptance", index, "description"],
    ));
    acceptance.body.append(card);
  });
  acceptance.body.append(createTaskCardAddButton(["acceptance"], "acceptance", "添加验收标准"));
  elements.taskCardForm.append(acceptance.section);

  const risk = createTaskCardSection("risk", "风险声明", "no / yes / unknown");
  const riskGrid = document.createElement("div");
  riskGrid.className = "task-card-risk-grid";
  for (const key of TASK_CARD_RISKS) {
    riskGrid.append(createTaskCardControl(
      key.replaceAll("_", " "),
      createTaskCardSelect(["risk", key], task.risk?.[key] ?? "unknown", ["no", "yes", "unknown"]),
      ["risk", key],
    ));
  }
  risk.body.append(riskGrid);
  elements.taskCardForm.append(risk.section);

  const handoff = createTaskCardSection("handoff", "交接与权限", "必须做 / 禁止做 / 可自主决定");
  for (const key of TASK_CARD_HANDOFF) {
    appendTaskCardTextList(
      handoff.body,
      key.replaceAll("_", " "),
      ["handoff", key],
      task.handoff?.[key] ?? [],
      "输入一条明确边界",
    );
  }
  elements.taskCardForm.append(handoff.section);

  const validation = createTaskCardSection("validation", "验证命令", `${task.validation?.length ?? 0} 条 argv 命令`);
  (task.validation ?? []).forEach((entry, index) => {
    const card = document.createElement("div");
    card.className = "task-card-object-card";
    const cardHead = document.createElement("div");
    cardHead.className = "task-card-object-heading";
    const title = document.createElement("strong");
    title.textContent = entry.id || `验证 ${index + 1}`;
    cardHead.append(title, createTaskCardRemoveButton(["validation"], index, `删除验证 ${index + 1}`));
    const grid = document.createElement("div");
    grid.className = "task-card-field-grid two";
    const local = document.createElement("input");
    local.type = "checkbox";
    local.checked = entry.local_allowed !== false;
    local.dataset.taskPath = taskCardPath(["validation", index, "local_allowed"]);
    local.dataset.taskValueType = "boolean";
    grid.append(
      createTaskCardControl("稳定 ID", createTaskCardInput(["validation", index, "id"], entry.id, { rerender: true }), ["validation", index, "id"]),
      createTaskCardControl("允许本地执行", local, ["validation", index, "local_allowed"]),
    );
    card.append(cardHead, grid, createTaskCardControl(
      "说明",
      createTaskCardInput(["validation", index, "description"], entry.description ?? "", { removeEmpty: true }),
      ["validation", index, "description"],
    ));
    appendTaskCardTextList(card, "argv 参数", ["validation", index, "command"], entry.command ?? [], "npm");
    validation.body.append(card);
  });
  validation.body.append(createTaskCardAddButton(["validation"], "validation", "添加验证命令"));
  elements.taskCardForm.append(validation.section);

  const stop = createTaskCardSection("stop", "停止条件", `${task.stop_conditions?.length ?? 0} 条`);
  appendTaskCardTextList(stop.body, "停止条件", ["stop_conditions"], task.stop_conditions ?? [], "external_blocker");
  elements.taskCardForm.append(stop.section);

  const extensions = createTaskCardSection("extensions", "扩展字段", "高级 JSON");
  const extensionEditor = createTaskCardInput(["extensions"], JSON.stringify(task.extensions ?? {}, null, 2), {
    multiline: true,
    valueType: "json",
  });
  extensionEditor.classList.add("task-card-extension-editor");
  extensions.body.append(createTaskCardControl(
    "extensions",
    extensionEditor,
    ["extensions"],
    "用于 task_shape、participants、interfaces、complex_gate_contract 与产品扩展；仍会经过严格运行时校验。",
  ));
  elements.taskCardForm.append(extensions.section);
}

function renderTaskCardProjection() {
  elements.taskCardMarkdown.value = taskCardProjections[taskCardProjectionView] ?? "";
}

async function validateTaskCardDraft() {
  const requestId = ++taskCardValidationRequest;
  let candidate;
  try {
    candidate = JSON.parse(elements.taskCardEditor.value);
  } catch (error) {
    taskCardDraft = null;
    validatedTaskCard = null;
    taskCardErrorPath = null;
    elements.taskCardMarkdown.value = "";
    elements.taskCardExport.disabled = true;
    elements.taskCardPreflightRun.disabled = true;
    setTaskCardState("invalid", `JSON 语法错误：${error.message}`);
    if (taskCardEditorView === "form") renderTaskCardForm();
    return;
  }

  setTaskCardState("pending", "正在使用运行时校验器检查契约。");
  try {
    const shouldRenderCanonicalForm = !taskCardDraft || Boolean(taskCardErrorPath);
    const result = await requestJson("/api/task-card/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidate),
    });
    if (requestId !== taskCardValidationRequest) return;
    validatedTaskCard = result.task;
    taskCardDraft = taskCardClone(result.task);
    taskCardErrorPath = null;
    taskCardProjections = result.projections ?? { audit: "", execution: "" };
    if (result.migrated) {
      const migrated = JSON.stringify(result.task, null, 2);
      elements.taskCardEditor.value = migrated;
      taskCardLastEditorValue = migrated;
      localStorage.setItem(TASK_CARD_DRAFT_KEY, migrated);
    }
    if (taskCardEditorView === "form" && (result.migrated || shouldRenderCanonicalForm)) {
      renderTaskCardForm();
    }
    if (taskCardSetBaselineOnValidation || taskCardBaseline === null) {
      taskCardBaseline = elements.taskCardEditor.value;
      taskCardSetBaselineOnValidation = false;
    }
    renderTaskCardProjection();
    elements.taskCardExport.disabled = false;
    elements.taskCardPreflightRun.disabled = false;
    updateTaskCardHistoryButtons();
    setTaskCardState(
      "valid",
      result.migrated
        ? "已从 legacy-v0 自动迁移并保存为 task-card-v1；请检查生成的稳定验收 ID。"
        : "task-card-v1 契约有效，浏览器草稿已保存；可供 Overnight 与 Balanced 使用。",
    );
  } catch (error) {
    if (requestId !== taskCardValidationRequest) return;
    validatedTaskCard = null;
    taskCardErrorPath = taskCardDisplayErrorPath(error.path);
    openTaskCardErrorSection(taskCardErrorPath);
    taskCardProjections = { audit: "", execution: "" };
    elements.taskCardMarkdown.value = "";
    elements.taskCardExport.disabled = true;
    elements.taskCardPreflightRun.disabled = true;
    setTaskCardState("invalid", error.message);
    if (taskCardEditorView === "form") renderTaskCardForm();
  }
}

function queueTaskCardValidation(options = {}) {
  localStorage.setItem(TASK_CARD_DRAFT_KEY, elements.taskCardEditor.value);
  taskCardValidationRequest += 1;
  if (!options.preserveHistoryGroup) taskCardHistoryGroup = null;
  clearTimeout(taskCardValidationTimer);
  taskCardValidationTimer = window.setTimeout(validateTaskCardDraft, 220);
}

async function loadTaskCard() {
  try {
    const result = await requestJson("/api/task-card/template");
    taskCardTemplate = result.task;
    const stored = localStorage.getItem(TASK_CARD_DRAFT_KEY);
    elements.taskCardEditor.value = stored ?? JSON.stringify(taskCardTemplate, null, 2);
    taskCardLastEditorValue = elements.taskCardEditor.value;
    taskCardSetBaselineOnValidation = true;
    await validateTaskCardDraft();
    await loadTaskCardPreflightOptions();
  } catch (error) {
    validatedTaskCard = null;
    elements.taskCardEditor.disabled = true;
    elements.taskCardExport.disabled = true;
    setTaskCardState("unavailable", `Task Card 服务不可用：${error.message}`);
  }
}

function exportTaskCard() {
  if (!validatedTaskCard) return;
  const content = `${JSON.stringify(validatedTaskCard, null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "TASK.json";
  anchor.click();
  URL.revokeObjectURL(url);
  showToast("已导出经过校验的 TASK.json。");
}

function setTaskCardEditorView(view) {
  if (view === "form" && !taskCardDraft) {
    showToast("JSON 仍有语法错误，修复后才能返回结构化编辑。");
    return;
  }
  taskCardEditorView = view;
  elements.taskCardForm.hidden = view !== "form";
  elements.taskCardEditor.hidden = view !== "json";
  for (const button of elements.taskCardEditorSwitch.querySelectorAll("button")) {
    const active = button.dataset.taskCardEditorView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (view === "form") renderTaskCardForm();
}

function taskCardAddedValue(kind, length) {
  if (kind === "acceptance") {
    return { id: `acceptance-${length + 1}`, description: "Replace with one observable result." };
  }
  if (kind === "validation") {
    return {
      id: `validation-${length + 1}`,
      command: ["npm", "test"],
      description: "Replace with a deterministic validation command.",
      local_allowed: true,
    };
  }
  return "";
}

function taskCardArrayAt(task, path) {
  let value = task;
  for (const part of path) value = value[part];
  return value;
}

function restoreTaskCardHistory(stack, destination) {
  const snapshot = stack.pop();
  if (snapshot === undefined) return;
  destination.push(taskCardSnapshot());
  taskCardHistoryGroup = null;
  replaceTaskCardSnapshot(snapshot);
}

function preflightConfiguration() {
  try {
    return JSON.parse(localStorage.getItem(TASK_CARD_PREFLIGHT_KEY) ?? "null") ?? {};
  } catch {
    localStorage.removeItem(TASK_CARD_PREFLIGHT_KEY);
    return {};
  }
}

function savePreflightConfiguration() {
  localStorage.setItem(TASK_CARD_PREFLIGHT_KEY, JSON.stringify({
    workflowMode: elements.taskCardWorkflowMode.value,
    adapterId: elements.taskCardAdapter.value,
    worktree: elements.taskCardWorktree.value,
    strategy: elements.taskCardStrategy.value,
    executionEnvironment: elements.taskCardExecutionEnvironment.value,
    proxyMode: elements.taskCardProxyMode.value,
    isolationMode: elements.taskCardEnvironmentIsolation.value,
    networkDiagnostics: elements.taskCardNetworkDiagnostics.value,
  }));
}

function updateTaskCardConnectivityAvailability() {
  const adapter = (taskCardPreflightOptions.adapters ?? []).find(
    (candidate) => candidate.id === elements.taskCardAdapter.value,
  );
  const supported = adapter?.connectivityProbeSupported !== false;
  elements.taskCardConnectivityRun.disabled =
    taskCardConnectivityRunning ||
    !elements.taskCardAdapter.value ||
    !elements.taskCardWorktree.value.trim() ||
    !supported;
  elements.taskCardConnectivityRun.title = supported
    ? "向当前路由发送一次固定最小交互"
    : "当前 Adapter 未实现主动连接诊断协议";
}

function synchronizeTaskCardStrategy() {
  const overnight = elements.taskCardWorkflowMode.value === "overnight";
  elements.taskCardStrategyField.hidden = !overnight;
}

async function loadTaskCardPreflightOptions() {
  try {
    taskCardPreflightOptions = await requestJson("/api/task-card/preflight");
    const stored = preflightConfiguration();
    const delegatedMode = ["overnight", "balanced"].includes(selectedModeId)
      ? selectedModeId
      : "overnight";
    elements.taskCardWorkflowMode.value = stored.workflowMode ?? delegatedMode;
    elements.taskCardAdapter.replaceChildren();
    for (const adapter of taskCardPreflightOptions.adapters ?? []) {
      elements.taskCardAdapter.append(option(adapter.id, adapter.displayName));
    }
    if (stored.adapterId && [...elements.taskCardAdapter.options].some((entry) => entry.value === stored.adapterId)) {
      elements.taskCardAdapter.value = stored.adapterId;
    }
    elements.taskCardWorktree.value = stored.worktree ?? "";
    elements.taskCardStrategy.value = stored.strategy ?? "convergent";
    elements.taskCardExecutionEnvironment.value = stored.executionEnvironment ?? "auto";
    elements.taskCardProxyMode.value = stored.proxyMode ?? "direct";
    elements.taskCardEnvironmentIsolation.value = stored.isolationMode ?? "provider-scoped";
    elements.taskCardNetworkDiagnostics.value = stored.networkDiagnostics ?? "metadata";
    synchronizeTaskCardStrategy();
    updateTaskCardConnectivityAvailability();
  } catch (error) {
    elements.taskCardPreflightRun.disabled = true;
    elements.taskCardConnectivityRun.disabled = true;
    elements.taskCardPreflightState.className = "task-card-state unavailable";
    elements.taskCardPreflightState.textContent = "不可用";
    elements.taskCardPreflightResult.textContent = `Preflight 配置不可用：${error.message}`;
  }
}

function connectivityRecommendation(failureCategory) {
  const recommendations = {
    "sandbox-network-host-handoff": "当前沙箱禁止网络访问。请从宿主机终端启动控制面，再重新执行一次诊断。",
    "adapter-unavailable": "下游 CLI 不在控制面 PATH 中。请检查命令安装位置或 AGENT_CONTROL_CLAUDE_COMMAND。",
    "workspace-not-trusted": "下游 CLI 拒绝当前工作树。请先在对应工具中完成工作区信任。",
    "proxy-failure": "代理握手失败。检查系统代理，或切换为直连后手动重新诊断。",
    "dns-failure": "域名解析失败。检查 DNS、网络出口，或切换当前代理路由后手动重试。",
    "tls-failure": "TLS 或证书校验失败。检查系统证书、企业代理与供应商证书链。",
    "authentication-failure": "供应商认证失败。检查登录状态、CC Switch 当前供应商以及认证变量。",
    "provider-limit": "供应商返回额度、账单或限流错误。请检查对应账户状态。",
    "transport-failure": "连接未建立或被中断。检查网络出口和当前代理路由。",
    "probe-timeout": "诊断在 60 秒内没有结束。确认下游 CLI 未等待交互输入，再手动重试。",
    "no-response": "CLI 正常退出但没有返回内容。检查下游模型与 stream-json 兼容性。",
    "cli-error": "下游 CLI 返回非零状态。请在同一宿主环境检查 CLI 配置。",
  };
  return recommendations[failureCategory] ?? "未识别到明确原因。请检查下游 CLI 日志与供应商状态。";
}

function connectivityMetric(label, value) {
  const row = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value;
  row.append(name, data);
  return row;
}

function renderTaskCardConnectivity(result) {
  const target = elements.taskCardConnectivityResult;
  target.replaceChildren();
  target.hidden = false;
  target.className = `task-card-connectivity-result wide ${result.success ? "success" : "failure"}`;

  const heading = document.createElement("div");
  heading.className = "task-card-connectivity-heading";
  const title = document.createElement("strong");
  title.textContent = result.success ? "连接已建立" : "连接诊断未通过";
  const route = document.createElement("code");
  route.textContent = `${result.adapterDisplayName ?? result.adapterId} · ${result.proxyMode}`;
  heading.append(title, route);

  const metrics = document.createElement("div");
  metrics.className = "task-card-connectivity-metrics";
  metrics.append(
    connectivityMetric("耗时", `${result.elapsedMilliseconds ?? 0} ms`),
    connectivityMetric("Stream 初始化", result.streamInitialized ? "已确认" : "未确认"),
    connectivityMetric("终态回执", result.resultReceived ? "已收到" : "未收到"),
    connectivityMetric("调用状态", result.consumedCall ? "已观察到用量阶段" : result.attempted ? "已启动，未确认用量" : "未启动"),
    connectivityMetric("输出活动", `${result.activity?.stdoutBytes ?? 0} / ${result.activity?.stderrBytes ?? 0} B`),
    connectivityMetric("Token", result.usageAvailable ? String(result.usage?.totalTokens ?? 0) : "不可见"),
  );
  target.append(heading, metrics);

  const note = document.createElement("p");
  if (result.success) {
    note.textContent = result.resultReceived
      ? "当前所选路由完成了最小交互。该结果只证明连接可用，不作为任务验收证据。"
      : "CLI 返回了内容，但未解析到标准终态事件；连接可用，协议兼容性仍需检查。";
  } else {
    note.textContent = `${result.failureCategory ?? "unknown"}：${connectivityRecommendation(result.failureCategory)}`;
  }
  target.append(note);
}

async function runTaskCardConnectivityProbe() {
  if (taskCardConnectivityRunning) return;
  if (!elements.taskCardAdapter.value || !elements.taskCardWorktree.value.trim()) {
    showToast("请先选择下游 Adapter 并填写绝对工作树路径。");
    return;
  }
  if (!window.confirm(
    "主动连接诊断会向当前下游发送固定最小提示，并最多消耗 1 次模型调用。不会发送 Task Card、工作区内容或代理凭证。继续？",
  )) return;

  savePreflightConfiguration();
  taskCardConnectivityRunning = true;
  updateTaskCardConnectivityAvailability();
  elements.taskCardConnectivityRun.textContent = "正在诊断…";
  elements.taskCardConnectivityResult.hidden = false;
  elements.taskCardConnectivityResult.className = "task-card-connectivity-result wide pending";
  elements.taskCardConnectivityResult.textContent = "正在等待当前路由返回最小交互回执；不会自动切换路由或发起第二次调用。";
  try {
    const result = await requestJson("/api/runtime/connectivity-probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        adapterId: elements.taskCardAdapter.value,
        worktree: elements.taskCardWorktree.value,
        timeoutSeconds: 60,
        runtimeEnvironment: {
          executionEnvironment: elements.taskCardExecutionEnvironment.value,
          proxyMode: elements.taskCardProxyMode.value,
          isolationMode: elements.taskCardEnvironmentIsolation.value,
          networkDiagnostics: elements.taskCardNetworkDiagnostics.value,
        },
      }),
    });
    renderTaskCardConnectivity(result);
  } catch (error) {
    elements.taskCardConnectivityResult.hidden = false;
    elements.taskCardConnectivityResult.className = "task-card-connectivity-result wide failure";
    elements.taskCardConnectivityResult.textContent = `诊断请求失败：${error.message}`;
  } finally {
    taskCardConnectivityRunning = false;
    elements.taskCardConnectivityRun.textContent = "主动连接诊断 · 1 次调用";
    updateTaskCardConnectivityAvailability();
  }
}

function renderTaskCardPreflight(result) {
  elements.taskCardPreflightResult.replaceChildren();
  elements.taskCardPreflightState.className = `task-card-state ${result.ready ? "valid" : "invalid"}`;
  elements.taskCardPreflightState.textContent = result.ready ? "可以启动" : "存在阻断";

  const summary = document.createElement("div");
  summary.className = "task-card-preflight-summary";
  const title = document.createElement("strong");
  title.textContent = result.ready ? "启动前检查通过" : "启动前检查未通过";
  const fingerprint = document.createElement("code");
  fingerprint.textContent = result.taskSha256 ? `sha256:${result.taskSha256.slice(0, 16)}…` : "无任务指纹";
  summary.append(title, fingerprint);
  elements.taskCardPreflightResult.append(summary);

  const checks = document.createElement("div");
  checks.className = "task-card-preflight-checks";
  for (const entry of result.checks ?? []) {
    const row = document.createElement("div");
    row.className = `task-card-preflight-check ${entry.status}`;
    const marker = document.createElement("i");
    marker.textContent = entry.status === "passed" ? "✓" : entry.status === "warning" ? "!" : "×";
    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = entry.label;
    const detail = document.createElement("span");
    detail.textContent = entry.detail;
    copy.append(label, detail);
    row.append(marker, copy);
    checks.append(row);
  }
  elements.taskCardPreflightResult.append(checks);

  const warnings = (result.issues ?? []).filter((entry) => entry.severity === "warning");
  if (warnings.length > 0) {
    const list = document.createElement("ul");
    list.className = "task-card-preflight-warnings";
    for (const warning of warnings) {
      const item = document.createElement("li");
      item.textContent = warning.message;
      list.append(item);
    }
    elements.taskCardPreflightResult.append(list);
  }
}

async function runTaskCardPreflight() {
  if (!validatedTaskCard) return;
  savePreflightConfiguration();
  elements.taskCardPreflightRun.disabled = true;
  elements.taskCardPreflightState.className = "task-card-state pending";
  elements.taskCardPreflightState.textContent = "正在检查";
  try {
    const workflowMode = elements.taskCardWorkflowMode.value;
    const result = await requestJson("/api/task-card/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: validatedTaskCard,
        workflowMode,
        worktree: elements.taskCardWorktree.value,
        adapterId: elements.taskCardAdapter.value,
        runtimeEnvironment: {
          executionEnvironment: elements.taskCardExecutionEnvironment.value,
          proxyMode: elements.taskCardProxyMode.value,
          isolationMode: elements.taskCardEnvironmentIsolation.value,
          networkDiagnostics: elements.taskCardNetworkDiagnostics.value,
        },
        ...(workflowMode === "overnight" ? { strategy: elements.taskCardStrategy.value } : {
          timing: balancedTimingFromControls(),
          budget: balancedBudgetFromControls(),
        }),
      }),
    });
    renderTaskCardPreflight(result);
  } catch (error) {
    elements.taskCardPreflightState.className = "task-card-state invalid";
    elements.taskCardPreflightState.textContent = "检查失败";
    elements.taskCardPreflightResult.textContent = error.message;
  } finally {
    elements.taskCardPreflightRun.disabled = !validatedTaskCard;
  }
}

function historyEntriesInScope() {
  const entries = historyData?.entries ?? [];
  const workspaceId = projectConfigState?.workspaceId;
  if (elements.historyScopeFilter.value !== "current") return entries;
  if (!workspaceId) return [];
  return entries.filter((entry) => entry.projectBinding?.workspaceId === workspaceId);
}

function historyRunsInScope(entries) {
  const workspaceId = projectConfigState?.workspaceId;
  const linked = entries.flatMap((entry) => entry.runs ?? []);
  if (elements.historyScopeFilter.value !== "current") {
    return [...linked, ...(historyData?.unlinkedRuns ?? [])];
  }
  if (!workspaceId) return [];
  return [
    ...linked,
    ...(historyData?.unlinkedRuns ?? []).filter(
      (run) => run.projectBinding?.workspaceId === workspaceId,
    ),
  ];
}

function renderHistoryList() {
  elements.historyList.replaceChildren();
  const entries = historyEntriesInScope();
  const scopedRuns = historyRunsInScope(entries);
  const activityCount = (historyData?.activitySummary?.activations ?? entries.length)
    + (historyData?.activitySummary?.runs ?? 0);
  elements.historyCount.hidden = activityCount === 0;
  elements.historyCount.textContent = String(activityCount);

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

  const currentScope = elements.historyScopeFilter.value === "current";
  elements.historyStatus.textContent = currentScope
    ? `${projectConfigState?.workspaceId ? projectName(projectConfigState.projectRoot) : "尚未打开工作目录"} · ${entries.length} 条激活 · ${scopedRuns.length} 条运行`
    : `${entries.length} 条激活 · ${scopedRuns.length} 条运行 · ${historyData.activitySummary?.projects ?? 0} 个项目 · ${historyData.activitySummary?.workspaces ?? 0} 个工作区`;
  const corrupt = historyData.corruptEntries ?? 0;
  elements.historyIntegrity.textContent = corrupt === 0 ? "完整性通过" : `${corrupt} 条损坏记录`;
  elements.historyIntegrity.classList.toggle("error", corrupt > 0);
  elements.historyEmpty.hidden = entries.length > 0;
  if (entries.length === 0) {
    elements.historyEmpty.textContent = scopedRuns.length > 0
      ? "存在运行记录，但尚无可关联的真实激活快照；这些运行保留在上方未关联区域。"
      : currentScope
        ? "当前项目尚无真实激活记录。激活一次项目 Skill 后将在这里建立首个快照。"
        : "尚无真实激活记录。完成一次文件系统激活后将在这里建立首个快照。";
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
    mode.textContent = entry.projectBinding
      ? `${entry.mode.id}@${entry.mode.version} · workspace ${shortHash(entry.projectBinding.workspaceId)}`
      : `${entry.mode.id}@${entry.mode.version} · global`;
    main.append(title, time, mode);
    const state = document.createElement("span");
    state.className = `history-entry-state${entry.isActive ? " active" : ""}`;
    state.textContent = entry.isActive ? `当前 · ${entry.runs?.length ?? 0}` : `${entry.runs?.length ?? 0} 运行`;
    button.append(icon, main, state);
    button.addEventListener("click", () => selectHistoryEntry(entry.historyId));
    elements.historyList.append(button);
  }
}

function renderHistoryMeta(entry) {
  elements.historyMeta.replaceChildren();
  const values = [
    ["Activation ID", entry.historyId],
    ["Mode", `${entry.mode.id}@${entry.mode.version}`],
    ["Main agent", entry.mainAgentId],
    ["Profile", entry.profileId],
    ["Activated", formatHistoryDate(entry.activatedAt)],
    ["Skill hash", entry.contentSha256 ? entry.contentSha256.slice(0, 12) : "—"],
    ["Repository project", entry.projectBinding?.projectId ?? "not enabled"],
    ["Workspace", entry.projectBinding?.workspaceId ?? "—"],
    ["Project revision", entry.projectBinding ? `r${entry.projectBinding.projectRevision}` : "—"],
    ["Project config", entry.projectBinding?.projectConfigSha256?.slice(0, 12) ?? "—"],
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
  renderActivityRuns(elements.historyRunList, detail.runs ?? [], {
    empty: "该激活快照尚无关联运行。",
  });
  elements.historyRunSummary.textContent = `${detail.runs?.length ?? 0} 条运行`;
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
    const detail = await requestJson(`/api/activity/${encodeURIComponent(historyId)}`);
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
    const data = await requestJson("/api/activity");
    if (request !== historyRequest) return;
    historyData = data;
    const scopedEntries = historyEntriesInScope();
    if (!scopedEntries.some((entry) => entry.historyId === selectedHistoryId)) {
      selectedHistoryId = scopedEntries.find((entry) => entry.isActive)?.historyId ?? scopedEntries[0]?.historyId ?? null;
    }
    renderHistoryList();
    refreshActivityRunSelections();
    renderProjectHub();
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

function selectedOvernightPolicy() {
  return (
    OVERNIGHT_LOOP_POLICIES.find(
      (policy) => `${policy.id}@${policy.version}` === elements.overnightLoopPolicy.value,
    ) ?? DEFAULT_OVERNIGHT_LOOP_POLICY
  );
}

function renderOvernightPolicySummary() {
  const policy = selectedOvernightPolicy();
  if (!policy) return;
  elements.overnightPolicyVersion.textContent = `${policy.id}@${policy.version}`;
  elements.overnightPolicyDescription.textContent = policy.description;
  elements.overnightScopeRule.textContent =
    policy.scopePolicy === "monotonic-non-expanding"
      ? "逐轮收缩；下一轮允许路径必须是前一轮子集"
      : "通过审阅的新周期可以扩张；禁止与授权边界保持不变";
  elements.overnightCompletionRule.textContent =
    policy.completionPolicy === "terminal-on-acceptance"
      ? "验收通过即结束，不再重复唤醒"
      : "用户指标只是最低线；持续运行直到用户中断";
}

function initializeOvernightControls() {
  for (const policy of OVERNIGHT_LOOP_POLICIES) {
    elements.overnightLoopPolicy.append(
      option(`${policy.id}@${policy.version}`, policy.displayName),
    );
  }
  if (DEFAULT_OVERNIGHT_LOOP_POLICY) {
    elements.overnightLoopPolicy.value =
      `${DEFAULT_OVERNIGHT_LOOP_POLICY.id}@${DEFAULT_OVERNIGHT_LOOP_POLICY.version}`;
  }
  renderOvernightPolicySummary();
}

function applyOvernightLoopPolicyToControls(reference) {
  const selected = OVERNIGHT_LOOP_POLICIES.find(
    (policy) => policy.id === reference?.id && policy.version === reference?.version,
  );
  const policy = selected ?? DEFAULT_OVERNIGHT_LOOP_POLICY;
  if (!policy) return;
  elements.overnightLoopPolicy.value = `${policy.id}@${policy.version}`;
  renderOvernightPolicySummary();
}

function balancedBudgetFromControls() {
  return {
    mainReviewCalls: Number(elements.balancedMainCalls.value),
    downstreamCalls: Number(elements.balancedDownstreamCalls.value),
    advisorCalls: Number(elements.balancedAdvisorCalls.value),
    reservedFinalReviewCalls: Number(elements.balancedReservedCalls.value),
  };
}

function balancedTimingFromControls() {
  return {
    contextAcquisitionSeconds: Number(elements.balancedContextWindow.value),
    firstProgressSeconds: Number(elements.balancedFirstProgressWindow.value),
    activeWindowSeconds: Number(elements.balancedActiveWindow.value),
    progressExtensionSeconds: Number(elements.balancedExtensionWindow.value),
    growingProgressExtensionSeconds: Number(elements.balancedGrowingExtensionWindow.value),
    hardCapSeconds: Number(elements.balancedHardCap.value),
  };
}

function synchronizeBalancedBudgetConstraints({ clampReserved = false } = {}) {
  const controls = {
    mainReviewCalls: elements.balancedMainCalls,
    downstreamCalls: elements.balancedDownstreamCalls,
    advisorCalls: elements.balancedAdvisorCalls,
    reservedFinalReviewCalls: elements.balancedReservedCalls,
  };
  for (const [key, input] of Object.entries(controls)) {
    const range = BALANCED_BUDGET_LIMITS[key];
    input.min = String(range.min);
    input.max = String(range.max);
  }
  const mainReviewCalls = Number(elements.balancedMainCalls.value);
  if (
    Number.isInteger(mainReviewCalls) &&
    mainReviewCalls >= BALANCED_BUDGET_LIMITS.mainReviewCalls.min &&
    mainReviewCalls <= BALANCED_BUDGET_LIMITS.mainReviewCalls.max
  ) {
    elements.balancedReservedCalls.max = String(
      Math.min(mainReviewCalls, BALANCED_BUDGET_LIMITS.reservedFinalReviewCalls.max),
    );
    if (clampReserved && Number(elements.balancedReservedCalls.value) > mainReviewCalls) {
      elements.balancedReservedCalls.value = String(mainReviewCalls);
    }
  }
}

function synchronizeBalancedTimingConstraints({ clampHardCap = false } = {}) {
  const controls = {
    contextAcquisitionSeconds: elements.balancedContextWindow,
    firstProgressSeconds: elements.balancedFirstProgressWindow,
    activeWindowSeconds: elements.balancedActiveWindow,
    progressExtensionSeconds: elements.balancedExtensionWindow,
    growingProgressExtensionSeconds: elements.balancedGrowingExtensionWindow,
    hardCapSeconds: elements.balancedHardCap,
  };
  for (const [key, input] of Object.entries(controls)) {
    const range = BALANCED_TIMING_LIMITS[key];
    input.min = String(range.min);
    input.max = String(range.max);
  }
  const windowValues = Object.entries(controls)
    .filter(([key]) => key !== "hardCapSeconds")
    .map(([, input]) => Number(input.value));
  if (windowValues.every(Number.isInteger)) {
    const requiredHardCap = Math.max(
      BALANCED_TIMING_LIMITS.hardCapSeconds.min,
      ...windowValues,
    );
    elements.balancedHardCap.min = String(requiredHardCap);
    if (clampHardCap && Number(elements.balancedHardCap.value) < requiredHardCap) {
      elements.balancedHardCap.value = String(requiredHardCap);
    }
  }
}

function initializeBalancedControls() {
  if (!BALANCED_MODE || !BALANCED_POLICY || !BALANCED_BUDGET) return;
  elements.balancedPolicyVersion.textContent = `${BALANCED_POLICY.id}@${BALANCED_POLICY.version}`;
  elements.balancedContextWindow.value = String(BALANCED_POLICY.contextAcquisitionSeconds);
  elements.balancedFirstProgressWindow.value = String(BALANCED_POLICY.firstProgressSeconds);
  elements.balancedActiveWindow.value = String(BALANCED_POLICY.activeWindowSeconds);
  elements.balancedExtensionWindow.value = String(BALANCED_POLICY.progressExtensionSeconds);
  elements.balancedGrowingExtensionWindow.value = String(
    BALANCED_POLICY.growingProgressExtensionSeconds,
  );
  elements.balancedHardCap.value = String(BALANCED_POLICY.hardCapSeconds);
  elements.balancedMainCalls.value = String(BALANCED_BUDGET.mainReviewCalls);
  elements.balancedDownstreamCalls.value = String(BALANCED_BUDGET.downstreamCalls);
  elements.balancedAdvisorCalls.value = String(BALANCED_BUDGET.advisorCalls);
  elements.balancedReservedCalls.value = String(BALANCED_BUDGET.reservedFinalReviewCalls);
  synchronizeBalancedBudgetConstraints();
  synchronizeBalancedTimingConstraints();
}

function applyBalancedBudgetToControls(budget) {
  if (!budget || typeof budget !== "object") return;
  const fields = [
    ["mainReviewCalls", elements.balancedMainCalls],
    ["downstreamCalls", elements.balancedDownstreamCalls],
    ["advisorCalls", elements.balancedAdvisorCalls],
    ["reservedFinalReviewCalls", elements.balancedReservedCalls],
  ];
  for (const [key, input] of fields) {
    const range = BALANCED_BUDGET_LIMITS[key];
    if (
      Number.isInteger(budget[key]) &&
      budget[key] >= range.min &&
      budget[key] <= range.max
    ) {
      input.value = String(budget[key]);
    }
  }
  synchronizeBalancedBudgetConstraints({ clampReserved: true });
}

function applyBalancedTimingToControls(timing) {
  if (!timing || typeof timing !== "object") return;
  const fields = [
    ["contextAcquisitionSeconds", elements.balancedContextWindow],
    ["firstProgressSeconds", elements.balancedFirstProgressWindow],
    ["activeWindowSeconds", elements.balancedActiveWindow],
    ["progressExtensionSeconds", elements.balancedExtensionWindow],
    ["growingProgressExtensionSeconds", elements.balancedGrowingExtensionWindow],
    ["hardCapSeconds", elements.balancedHardCap],
  ];
  for (const [key, input] of fields) {
    const range = BALANCED_TIMING_LIMITS[key];
    if (
      Number.isInteger(timing[key]) &&
      timing[key] >= range.min &&
      timing[key] <= range.max
    ) {
      input.value = String(timing[key]);
    }
  }
  synchronizeBalancedTimingConstraints({ clampHardCap: true });
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
    const failure = run.latestFailureCategory ? ` · ${run.latestFailureCategory}` : "";
    budget.textContent = `轮次 ${run.rounds ?? 0} · 下游 ${used.downstream ?? 0}/${limits.downstreamCalls ?? 0} · 审阅 ${used.main ?? 0}/${limits.mainReviewCalls ?? 0} · Token ${formatTokens(run.budgetState?.totalTokens ?? 0)}${failure}`;
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

function renderOvernightRuns() {
  elements.overnightRunList.replaceChildren();
  elements.overnightRuntimeSummary.textContent =
    !overnightRunsAvailable
      ? "运行记录不可用"
      : overnightRuns.length === 0
        ? "尚无运行记录"
        : `${overnightRuns.length} 个持久化运行`;
  for (const run of overnightRuns.slice(0, 3)) {
    const item = document.createElement("div");
    item.className = "balanced-run";
    const id = document.createElement("code");
    id.textContent = run.taskId ?? run.runId;
    id.title = run.runId;
    const state = document.createElement("b");
    state.textContent = run.state;
    const stateActions = document.createElement("div");
    stateActions.className = "overnight-run-actions";
    stateActions.append(state);
    if (!["accepted", "stopped", "interrupted"].includes(run.state)) {
      const interrupt = document.createElement("button");
      interrupt.type = "button";
      interrupt.className = "overnight-interrupt";
      interrupt.textContent = "中断";
      interrupt.addEventListener("click", async () => {
        interrupt.disabled = true;
        try {
          const result = await requestJson(
            `/api/overnight/runs/${encodeURIComponent(run.runId)}/interrupt`,
            { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
          );
          showToast(result.state === "interrupt_requested" ? "已提交中断请求" : "运行已中断");
          await loadOvernightRuns();
        } catch (error) {
          showToast(`中断失败：${error.message}`);
          interrupt.disabled = false;
        }
      });
      stateActions.append(interrupt);
    }
    const detail = document.createElement("small");
    const strategy = run.strategy === "continuous-improvement" ? "持续改进" : "收缩式";
    const delivery = run.wakeDelivery?.status ? ` · 唤醒 ${run.wakeDelivery.status}` : "";
    const failure = run.latestFailureCategory ? ` · ${run.latestFailureCategory}` : "";
    detail.textContent = `${strategy} · 周期 ${run.cycle ?? 0} · ${run.adapterId ?? "未知下游"}${delivery}${failure}`;
    item.append(id, stateActions, detail);
    elements.overnightRunList.append(item);
  }
}

async function loadOvernightRuns() {
  try {
    const result = await requestJson("/api/overnight/runs");
    overnightRuns = result.runs ?? [];
    overnightRunsAvailable = true;
  } catch {
    overnightRuns = [];
    overnightRunsAvailable = false;
  }
  renderOvernightRuns();
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
      if (projectConfigState?.initialized) {
        showToast("已更新当前 workspace 草稿；保存配置后再显式激活。");
        return;
      }
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
  if (mode.kind === "overnight") {
    const policy = selectedOvernightPolicy();
    if (policy) profile.overnightLoopPolicy = { id: policy.id, version: policy.version };
  }
  if (mode.kind === "balanced") {
    profile.balancedBudget = balancedBudgetFromControls();
    profile.balancedTiming = balancedTimingFromControls();
  }
  return profile;
}

function projectSkillContent(content) {
  if (!projectConfigState?.initialized) return content;
  const appendix = elements.projectSkillAppendix.value.trim();
  if (!appendix) return content;
  return `${content.trimEnd()}\n\n## Project policy\n\n${appendix}\n`;
}

function draftKeyFor(variant) {
  const project = variant.projectBinding
    ? `${variant.projectBinding.projectId}:${variant.projectBinding.workspaceId}:r${variant.projectBinding.projectRevision}:${variant.projectBinding.projectConfigSha256}`
    : "global";
  return `${variant.id}:${variant.contentFingerprint}:${project}`;
}

function resolveSkillDraft(modeId = selectedModeId) {
  const resolved = resolveEffectiveSkill({
    profile: createProfile(modeId),
    agents: EXAMPLE_AGENTS,
    catalog: BUILTIN_MODE_CATALOG,
  });
  if (!resolved.ok) return { ok: false, issues: resolved.issues };
  const projected = customizeEffectiveSkill(resolved.value, projectSkillContent(resolved.value.content));
  if (!projected.ok) return { ok: false, issues: projected.issues };
  const projectBound = projectConfigState?.initialized && !projectConfigState.migrationRequired && projectConfigState.workspaceId
    ? {
        ...projected.value,
        projectBinding: {
          projectId: projectConfigState.projectId,
          workspaceId: projectConfigState.workspaceId,
          projectRevision: projectConfigState.revision,
          projectConfigSha256: projectConfigState.configSha256,
        },
      }
    : projected.value;
  const key = draftKeyFor(projectBound);
  const content = skillDrafts.get(key) ?? projectBound.content;
  return {
    ok: true,
    base: projectBound,
    key,
    content,
    customized: customizeEffectiveSkill(projectBound, content),
  };
}

function resetControlsToGlobalProfile() {
  selectedModeId = "overnight";
  const defaultMain = CODEX_OVERNIGHT_CLAUDE_PROFILE.mainAgentId;
  const defaultBuilder = CODEX_OVERNIGHT_CLAUDE_PROFILE.roleBindings.find(
    (binding) => binding.role === "builder" && binding.target.kind === "agent",
  )?.target.agentId;
  if ([...elements.mainAgent.options].some((entry) => entry.value === defaultMain)) {
    elements.mainAgent.value = defaultMain;
  }
  if (defaultBuilder && [...elements.builderAgent.options].some((entry) => entry.value === defaultBuilder)) {
    elements.builderAgent.value = defaultBuilder;
  }
  applyOvernightLoopPolicyToControls(DEFAULT_OVERNIGHT_LOOP_POLICY);
  initializeBalancedControls();
  synchronizeControlsWithActiveSkill();
  elements.projectSkillAppendix.value = "";
}

function applyProjectOverrides(overrides = {}) {
  resetControlsToGlobalProfile();
  if (BUILTIN_MODE_CATALOG.modes.some((mode) => mode.id === overrides.modeId)) {
    selectedModeId = overrides.modeId;
  }
  if ([...elements.mainAgent.options].some((entry) => entry.value === overrides.mainAgentId)) {
    elements.mainAgent.value = overrides.mainAgentId;
  }
  if ([...elements.builderAgent.options].some((entry) => entry.value === overrides.builderAgentId)) {
    elements.builderAgent.value = overrides.builderAgentId;
  }
  const overnightPolicy = OVERNIGHT_LOOP_POLICIES.find(
    (policy) => policy.id === overrides.overnightLoopPolicyId,
  );
  if (overnightPolicy) applyOvernightLoopPolicyToControls(overnightPolicy);
  applyBalancedBudgetToControls(overrides.balancedBudget);
  applyBalancedTimingToControls(overrides.balancedTiming);
  elements.projectSkillAppendix.value = overrides.skillAppendix ?? "";
  renderModeCards();
  refresh();
}

function projectName(projectRoot) {
  const normalized = String(projectRoot ?? "").replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
}

function selectedAgentLabel(select) {
  return select.selectedOptions[0]?.textContent ?? select.value ?? "—";
}

function relativeTime(value) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "时间未知";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, divisor] of units) {
    if (Math.abs(seconds) >= divisor) {
      return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(
        Math.round(seconds / divisor),
        unit,
      );
    }
  }
  return "刚刚";
}

function currentWorkspaceRuns() {
  const workspaceId = projectConfigState?.workspaceId;
  if (!workspaceId || !historyData) return [];
  return [
    ...(historyData.entries ?? []).flatMap((entry) => entry.runs ?? []),
    ...(historyData.unlinkedRuns ?? []),
  ]
    .filter((run) => run.projectBinding?.workspaceId === workspaceId)
    .sort((left, right) => String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")));
}

const WORKSPACE_REVIEW_STATES = new Set([
  "review_pending",
  "revision_pending",
  "improvement_cycle_ready",
  "runtime_blocked",
  "budget_exhausted",
  "scope_violation",
  "validation_failed",
]);

function workspaceRunAction(run) {
  if (run) {
    return {
      kind: "run",
      label: WORKSPACE_REVIEW_STATES.has(run.state) ? "查看并继续" : "查看运行",
    };
  }
  if (["balanced", "overnight"].includes(selectedModeId)) {
    return { kind: "task-card", label: "打开 Task Card" };
  }
  return null;
}

async function openWorkspaceRun(run) {
  selectedCoordinationRun = `${run.mode}:${run.runId}`;
  const activation = historyData?.entries?.find((entry) =>
    (entry.runs ?? []).some((candidate) => candidate.mode === run.mode && candidate.runId === run.runId)
  );
  selectedHistoryId = activation?.historyId ?? null;
  switchView("history", { load: false });
  await Promise.all([loadCoordination(), loadHistory({ selectEntry: true })]);
  const refreshed = [
    ...(historyData?.entries ?? []).flatMap((entry) => entry.runs ?? []),
    ...(historyData?.unlinkedRuns ?? []),
  ].find((candidate) => candidate.mode === run.mode && candidate.runId === run.runId);
  if (refreshed) await loadCoordinationDetail(refreshed);
}

function projectActivationState() {
  const state = projectConfigState;
  if (!state?.initialized) return { label: "尚未打开", tone: "" };
  if (state.migrationRequired) return { label: "需要迁移", tone: "error" };
  if (!serverStatusLoaded) return { label: "正在检查", tone: "" };
  if (!serverStatus.writeEnabled) return { label: "仅本地预览", tone: "" };
  const active = serverStatus.active;
  if (!active) return { label: "尚未激活", tone: "stale" };
  if (active.projectBinding?.workspaceId !== state.workspaceId) {
    return { label: active.projectBinding ? "其他项目已激活" : "全局 Skill 已激活", tone: "stale" };
  }
  if (
    active.projectBinding.projectRevision !== state.revision ||
    active.projectBinding.projectConfigSha256 !== state.configSha256 ||
    active.mode?.id !== selectedModeId ||
    (currentResolution && active.contentFingerprint !== currentResolution.contentFingerprint)
  ) {
    return { label: "配置待重新激活", tone: "stale" };
  }
  return { label: "当前配置已激活", tone: "ready" };
}

function renderProjectHub() {
  const state = projectConfigState;
  const root = state?.projectRoot ?? elements.projectConfigRoot.value.trim();
  elements.projectCurrentName.textContent = root ? projectName(root) : "尚未选择工作目录";
  elements.projectCurrentPath.textContent = root || "从文件管理器选择或输入工作目录";
  elements.projectCurrentPath.title = root;
  elements.projectCurrentMode.textContent = modeDisplayName(selectedModeId);
  elements.projectCurrentMain.textContent = selectedAgentLabel(elements.mainAgent);
  elements.projectCurrentBuilder.textContent = selectedModeId === "interactive"
    ? "原生 subagents"
    : selectedAgentLabel(elements.builderAgent);
  const activation = projectActivationState();
  elements.projectCurrentActive.className = `project-current-status${activation.tone ? ` ${activation.tone}` : ""}`;
  elements.projectCurrentActive.textContent = activation.label;
  const latestRun = currentWorkspaceRuns()[0];
  elements.projectCurrentRun.textContent = latestRun
    ? `${modeDisplayName(latestRun.mode)} · ${latestRun.state ?? "状态未知"} · ${relativeTime(latestRun.createdAt)}`
    : state?.initialized ? "尚无运行" : "—";
  elements.projectCurrentRun.title = latestRun?.createdAt
    ? formatHistoryDate(latestRun.createdAt)
    : "";
  if (integrationsLoading) {
    elements.projectCurrentTools.textContent = "正在检查";
  } else if (integrationsData?.projectRoot === root) {
    const total = integrationsData.summary?.total ?? integrationsData.integrations?.length ?? 0;
    const available = integrationsData.summary?.globalAvailable ?? 0;
    const initialized = integrationsData.summary?.projectInitialized ?? 0;
    elements.projectCurrentTools.textContent = `${available}/${total} 可用 · ${initialized} 项目就绪`;
  } else {
    elements.projectCurrentTools.textContent = root ? "等待检查" : "—";
  }
  const canActivate =
    state?.initialized === true &&
    !state.migrationRequired &&
    activation.tone !== "ready";
  elements.projectCurrentActivate.hidden = !canActivate;
  elements.projectCurrentActivate.disabled = !canActivate || elements.activateButton.disabled;
  elements.projectCurrentActivate.textContent = getInstalledState().length > 0
    ? "重新激活 Skill"
    : "激活 Skill";
  const runAction = workspaceRunAction(latestRun);
  elements.projectCurrentRunAction.hidden = runAction === null || state?.initialized !== true;
  elements.projectCurrentRunAction.disabled = runAction === null;
  elements.projectCurrentRunAction.textContent = runAction?.label ?? "查看运行";
  elements.projectCurrentRunAction.dataset.action = runAction?.kind ?? "";
  elements.projectCurrentIntegrations.disabled = !root || integrationsLoading;
  elements.projectCurrentIntegrations.textContent = integrationsLoading ? "正在刷新…" : "刷新集成状态";
  renderRecentProjects();
}

function renderRecentProjects() {
  elements.recentProjectList.replaceChildren();
  const projects = recentProjectsData?.projects ?? [];
  const corrupt = recentProjectsData?.corruptEntries ?? 0;
  elements.recentProjectRefresh.disabled = recentProjectsLoading;
  elements.recentProjectStatus.textContent = recentProjectsLoading
    ? "正在读取本机 workspace…"
    : recentProjectsData?.error
      ? `读取失败：${recentProjectsData.error}`
      : `${projects.length} 个 workspace${corrupt > 0 ? ` · 忽略 ${corrupt} 条无效记录` : ""}`;
  if (projects.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = recentProjectsLoading ? "正在读取…" : "尚无最近工作目录。打开目录后会出现在这里。";
    elements.recentProjectList.append(empty);
    return;
  }
  for (const project of projects.slice(0, 8)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `recent-project${project.workspaceId === projectConfigState?.workspaceId ? " current" : ""}`;
    button.disabled = project.available !== true || projectConfigLoading;
    const name = document.createElement("strong");
    name.textContent = project.displayName;
    const mode = document.createElement("code");
    mode.textContent = project.modeId ? modeDisplayName(project.modeId) : "全局默认";
    const path = document.createElement("small");
    path.textContent = project.available === true ? project.projectRoot : `${project.projectRoot} · 路径不可用`;
    button.append(name, mode, path);
    button.addEventListener("click", () => loadProjectConfig(project.projectRoot));
    elements.recentProjectList.append(button);
  }
}

async function loadRecentProjects() {
  if (recentProjectsLoading) {
    recentProjectsRefreshQueued = true;
    return;
  }
  recentProjectsLoading = true;
  renderRecentProjects();
  try {
    recentProjectsData = await requestJson("/api/projects/recent");
  } catch (error) {
    recentProjectsData = { projects: [], corruptEntries: 0, error: error.message };
  } finally {
    recentProjectsLoading = false;
    renderRecentProjects();
    if (recentProjectsRefreshQueued) {
      recentProjectsRefreshQueued = false;
      queueMicrotask(loadRecentProjects);
    }
  }
}

function renderProjectConfig() {
  const state = projectConfigState;
  const initialized = state?.initialized === true;
  const repositoryConfigEnabled = state?.repositoryConfigEnabled === true;
  const migrationRequired = initialized && state.migrationRequired === true;
  elements.projectConfigStatus.classList.toggle("error", state?.error !== undefined);
  elements.projectConfigStatus.textContent = projectConfigLoading
    ? "正在读取"
    : state?.error
      ? "项目配置不可用"
      : migrationRequired
        ? "需要迁移本地状态"
        : initialized ? "Workspace 已载入" : state ? "目录尚未打开" : "尚未检查";
  elements.projectConfigId.textContent = repositoryConfigEnabled ? shortHash(state.projectId) : "未启用";
  elements.projectConfigId.title = repositoryConfigEnabled ? state.projectId : "";
  elements.projectConfigWorkspace.textContent = state?.workspaceId ? shortHash(state.workspaceId) : "—";
  elements.projectConfigWorkspace.title = state?.workspaceId ?? "";
  elements.projectConfigRevision.textContent = initialized ? `r${state.revision}` : "—";
  elements.projectConfigHash.textContent = initialized ? shortHash(state.configSha256) : "—";
  elements.projectConfigHash.title = initialized ? state.configSha256 : "";
  const localCount = initialized ? Object.keys(state.localOverrides ?? {}).length : 0;
  const sharedCount = initialized ? Object.keys(state.sharedOverrides ?? {}).length : 0;
  elements.projectConfigSource.textContent = localCount > 0
    ? `本机 ${localCount} 项 · 仓库 ${sharedCount} 项`
    : sharedCount > 0 ? `仓库 ${sharedCount} 项` : "全局 Profile";
  elements.projectConfigInitialize.hidden = !initialized || repositoryConfigEnabled || migrationRequired;
  elements.projectConfigMigrate.hidden = !migrationRequired;
  elements.projectConfigInitialize.disabled = projectConfigLoading;
  elements.projectConfigMigrate.disabled = projectConfigLoading;
  elements.projectConfigCheck.disabled = projectConfigLoading;
  elements.projectConfigSave.disabled = !initialized || migrationRequired || projectConfigLoading;
  elements.projectConfigPublish.disabled = !initialized || !repositoryConfigEnabled || migrationRequired || projectConfigLoading;
  elements.projectConfigClear.disabled = !initialized || migrationRequired || projectConfigLoading || localCount === 0;
  elements.projectConfigRestore.disabled =
    !initialized || migrationRequired || projectConfigLoading || (state.history?.length ?? 0) === 0;
  elements.projectSkillAppendix.disabled = !initialized || migrationRequired || projectConfigLoading;
  renderProjectHub();
}

async function loadProjectConfig(projectRoot = elements.projectConfigRoot.value.trim()) {
  if (!projectRoot || projectConfigLoading) return;
  projectConfigLoading = true;
  renderProjectConfig();
  try {
    const result = await requestJson("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });
    projectConfigState = result;
    elements.projectConfigRoot.value = result.projectRoot;
    elements.integrationsProjectRoot.value = result.projectRoot;
    localStorage.setItem(INTEGRATION_PROJECT_KEY, result.projectRoot);
    applyProjectOverrides(result.initialized ? result.overrides : {});
    void loadRecentProjects();
    void loadIntegrations();
    void loadHistory();
  } catch (error) {
    projectConfigState = { initialized: false, error: error.message };
    resetControlsToGlobalProfile();
    renderModeCards();
    refresh();
  } finally {
    projectConfigLoading = false;
    renderProjectConfig();
  }
}

function renderDirectoryPickerState() {
  for (const button of [elements.projectConfigBrowse, elements.integrationsProjectBrowse]) {
    button.disabled = directoryPickerLoading;
    button.textContent = directoryPickerLoading ? "选择中…" : "选择文件夹";
  }
}

async function chooseProjectDirectory() {
  if (directoryPickerLoading) return;
  directoryPickerLoading = true;
  renderDirectoryPickerState();
  const initialDirectory =
    elements.projectConfigRoot.value.trim() || elements.integrationsProjectRoot.value.trim();
  try {
    const result = await requestJson("/api/system/select-directory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialDirectory: initialDirectory || undefined }),
    });
    if (!result.selected) {
      showToast("已取消选择，当前工作目录未改变。");
      return;
    }
    elements.projectConfigRoot.value = result.projectRoot;
    elements.integrationsProjectRoot.value = result.projectRoot;
    localStorage.setItem(INTEGRATION_PROJECT_KEY, result.projectRoot);
    elements.integrationPlanPanel.hidden = true;
    await loadProjectConfig(result.projectRoot);
    await loadIntegrations();
    showToast("已从文件管理器打开工作目录；仓库未被修改。");
  } catch (error) {
    showToast(`无法选择工作目录：${error.message}`);
  } finally {
    directoryPickerLoading = false;
    renderDirectoryPickerState();
  }
}

function currentProjectOverrides() {
  const profile = createProfile();
  const overrides = {
    modeId: selectedModeId,
    mainAgentId: profile.mainAgentId,
  };
  if (selectedModeId !== "interactive") overrides.builderAgentId = elements.builderAgent.value;
  if (selectedModeId === "overnight") {
    overrides.overnightLoopPolicyId = selectedOvernightPolicy()?.id;
  }
  if (selectedModeId === "balanced") {
    overrides.balancedBudget = balancedBudgetFromControls();
    overrides.balancedTiming = balancedTimingFromControls();
  }
  const appendix = elements.projectSkillAppendix.value.trim();
  if (appendix) overrides.skillAppendix = appendix;
  return overrides;
}

async function writeProjectOverrides(overrides, successMessage, scope = "local") {
  if (!projectConfigState?.initialized || projectConfigLoading) return;
  projectConfigLoading = true;
  renderProjectConfig();
  try {
    projectConfigState = await requestJson("/api/projects/current", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: projectConfigState.projectRoot,
        expectedRevision: projectConfigState.revision,
        expectedSharedConfigSha256: projectConfigState.sharedConfigSha256,
        overrides,
        scope,
      }),
    });
    applyProjectOverrides(projectConfigState.overrides);
    void loadRecentProjects();
    showToast(successMessage);
  } catch (error) {
    showToast(`项目配置保存失败：${error.message}`);
  } finally {
    projectConfigLoading = false;
    renderProjectConfig();
  }
}

function seedStoredSkillDraft(stored) {
  if (!stored || typeof stored.content !== "string") return;
  const drafted = resolveSkillDraft(stored.mode?.id ?? stored.modeId ?? selectedModeId);
  if (!drafted.ok || drafted.base.id !== stored.variantId) return;
  const customized = customizeEffectiveSkill(drafted.base, stored.content);
  if (
    customized.ok &&
    customized.value.contentFingerprint === stored.contentFingerprint &&
    stored.content !== drafted.base.content
  ) {
    skillDrafts.set(drafted.key, stored.content);
  }
}

function renderTokenChart() {
  const estimates = BUILTIN_MODE_CATALOG.modes.map((mode) => {
    const draft = resolveSkillDraft(mode.id);
    return {
      id: mode.id,
      label: mode.displayName,
      tokens: draft.ok && draft.customized.ok ? draft.customized.value.estimatedTokens : null,
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
  currentDefaultResolution = null;
  currentDraftKey = null;
  elements.compatibilityBadge.textContent = "配置不兼容";
  elements.compatibilityBadge.classList.add("error");
  elements.variantName.textContent = "无法生成";
  elements.tokenEstimate.textContent = "—";
  elements.includedModes.textContent = "—";
  elements.includedAgents.textContent = "—";
  elements.skillPath.textContent = "SKILL.md";
  elements.skillPreview.value = "修复左侧配置后将在此生成最小 Skill。";
  elements.skillDraftState.textContent = "UNAVAILABLE";
  elements.skillDraftState.classList.remove("edited", "invalid");
  elements.restoreSkillDefault.disabled = true;
  elements.activateButton.disabled = true;
  elements.copyButton.disabled = true;
  elements.exportButton.disabled = true;
  renderIssues(issues);
  renderOperations({ ok: false, issues });
}

function renderSkillDraftState(isDefault, valid) {
  elements.skillDraftState.textContent = valid ? (isDefault ? "DEFAULT" : "EDITED") : "INVALID";
  elements.skillDraftState.classList.toggle("edited", valid && !isDefault);
  elements.skillDraftState.classList.toggle("invalid", !valid);
  elements.restoreSkillDefault.disabled = isDefault;
}

function storeIsHealthy() {
  return serverStatus.health === "ready" || serverStatus.health === "active";
}

function renderStoreStatus() {
  if (!serverStatusLoaded) {
    elements.modeSwitchPolicy.textContent = "正在读取激活策略";
  } else if (projectConfigState?.initialized) {
    elements.modeSwitchPolicy.textContent = "项目草稿 · 显式保存与激活";
  } else if (serverStatus.writeEnabled && storeIsHealthy()) {
    elements.modeSwitchPolicy.textContent = "选择即备份并激活";
  } else if (serverStatus.writeEnabled) {
    elements.modeSwitchPolicy.textContent = "自动切换已阻止";
  } else if (serverStatus.health === "preview-only") {
    elements.modeSwitchPolicy.textContent = "选择仅切换预览";
  } else {
    elements.modeSwitchPolicy.textContent = "激活状态不可用";
  }
  elements.modeSwitchNoteCopy.textContent = projectConfigState?.initialized
    ? "当前 workspace 已载入；点击模式只更新草稿，保存配置后再显式激活当前 Harness Skill。"
    : "文件写入启用后，点击模式会自动备份当前受管 Skill，并原子覆写或首次激活。";
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

const INTERACTIVE_AGENT_STATUS_LABELS = Object.freeze({
  installed: "已安装",
  imported: "已读取",
  modified: "待覆盖",
  stale: "外部已修改",
  missing: "待安装",
  "update-available": "可更新",
  conflict: "冲突",
  unsafe: "不安全",
  unavailable: "不可用",
});

const INTERACTIVE_DRAFT_KEY = "agent-workflow-interactive-agents-draft";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function interactiveConfigurationFingerprint() {
  return interactiveAgentConfiguration ? JSON.stringify(interactiveAgentConfiguration) : null;
}

function createSelect(options, value, inheritLabel = null) {
  const select = document.createElement("select");
  if (inheritLabel !== null) {
    const inherit = document.createElement("option");
    inherit.value = "";
    inherit.textContent = inheritLabel;
    select.append(inherit);
  }
  for (const option of options) {
    const node = document.createElement("option");
    node.value = typeof option === "string" ? option : option.id;
    node.textContent = typeof option === "string" ? option : option.label;
    select.append(node);
  }
  if (value && ![...select.options].some((option) => option.value === value)) {
    const custom = document.createElement("option");
    custom.value = value;
    custom.textContent = value;
    select.append(custom);
  }
  select.value = value ?? "";
  return select;
}

function persistInteractiveDraft() {
  if (!interactiveAgentConfiguration) return;
  localStorage.setItem(INTERACTIVE_DRAFT_KEY, JSON.stringify(interactiveAgentConfiguration));
}

function updateInteractiveHistoryControls() {
  elements.interactiveUndo.disabled = interactiveUndoStack.length === 0;
  elements.interactiveRedo.disabled = interactiveRedoStack.length === 0;
  elements.interactiveUndo.title = interactiveUndoStack.length > 0
    ? `撤回上一步修改（剩余 ${interactiveUndoStack.length} 步）`
    : "没有可撤回的修改";
  elements.interactiveRedo.title = interactiveRedoStack.length > 0
    ? `重做下一步修改（剩余 ${interactiveRedoStack.length} 步）`
    : "没有可重做的修改";
  const differsFromBaseline =
    interactiveAgentConfiguration &&
    interactiveBaselineConfiguration &&
    JSON.stringify(interactiveAgentConfiguration) !== JSON.stringify(interactiveBaselineConfiguration);
  elements.interactiveRevert.disabled = !differsFromBaseline;
  elements.interactiveRevert.title = differsFromBaseline
    ? "回退到本次打开页面时或最近一次激活成功的配置"
    : "当前没有待回退的修改";
}

function initializeInteractiveHistory() {
  interactiveHistorySnapshot = interactiveAgentConfiguration
    ? cloneJson(interactiveAgentConfiguration)
    : null;
  interactiveUndoStack.length = 0;
  interactiveRedoStack.length = 0;
  interactiveHistoryGroup = null;
  interactiveHistoryAt = 0;
  updateInteractiveHistoryControls();
}

function recordInteractiveHistory(historyGroup = null) {
  if (!interactiveAgentConfiguration) return;
  const current = cloneJson(interactiveAgentConfiguration);
  const now = Date.now();
  const coalesced =
    historyGroup !== null &&
    historyGroup === interactiveHistoryGroup &&
    now - interactiveHistoryAt < 800;
  if (
    interactiveHistorySnapshot &&
    JSON.stringify(interactiveHistorySnapshot) !== JSON.stringify(current) &&
    !coalesced
  ) {
    interactiveUndoStack.push(interactiveHistorySnapshot);
    if (interactiveUndoStack.length > 100) interactiveUndoStack.shift();
    interactiveRedoStack.length = 0;
  }
  interactiveHistorySnapshot = current;
  interactiveHistoryGroup = historyGroup;
  interactiveHistoryAt = now;
  updateInteractiveHistoryControls();
}

function markInteractiveConfigurationChanged({
  rebuild = false,
  recordHistory = true,
  historyGroup = null,
} = {}) {
  if (recordHistory) recordInteractiveHistory(historyGroup);
  if (rebuild) interactiveEditorFingerprint = null;
  else interactiveEditorFingerprint = interactiveConfigurationFingerprint();
  persistInteractiveDraft();
  interactivePlanPending = true;
  interactivePlanRequest += 1;
  interactiveAgentStatus.health = "loading";
  clearTimeout(interactivePlanTimer);
  interactivePlanTimer = setTimeout(planInteractiveAgentConfiguration, 220);
  refresh({ preserveEditor: true });
}

function travelInteractiveHistory(direction) {
  if (!interactiveAgentConfiguration) return;
  const source = direction === "undo" ? interactiveUndoStack : interactiveRedoStack;
  const destination = direction === "undo" ? interactiveRedoStack : interactiveUndoStack;
  const restored = source.pop();
  if (!restored) return;
  destination.push(cloneJson(interactiveAgentConfiguration));
  interactiveAgentConfiguration = cloneJson(restored);
  interactiveHistorySnapshot = cloneJson(restored);
  interactiveHistoryGroup = null;
  interactiveHistoryAt = 0;
  interactiveEditorFingerprint = null;
  updateInteractiveHistoryControls();
  markInteractiveConfigurationChanged({ rebuild: true, recordHistory: false });
  showToast(direction === "undo" ? "已撤回上一步角色修改。" : "已重做角色修改。");
}

async function planInteractiveAgentConfiguration() {
  if (!interactiveAgentConfiguration) return;
  const requestId = ++interactivePlanRequest;
  try {
    const planned = await requestJson("/api/interactive-agents/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configuration: interactiveAgentConfiguration }),
    });
    if (requestId !== interactivePlanRequest) return;
    interactiveAgentStatus = planned;
    interactiveAgentCatalog = planned.catalog ?? interactiveAgentCatalog;
  } catch (error) {
    if (requestId !== interactivePlanRequest) return;
    interactiveAgentStatus = {
      ...interactiveAgentStatus,
      health: "agents.invalid_configuration",
      error: error.message,
      conflicts: [],
      requiresOverwrite: false,
    };
  } finally {
    if (requestId === interactivePlanRequest) {
      interactivePlanPending = false;
      renderInteractiveAgentConfig();
      refresh({ preserveEditor: true });
    }
  }
}

function buildInteractiveRoleEditor(agent, index, states) {
  const row = document.createElement("details");
  row.className = "interactive-agent";
  row.dataset.agentName = agent.name;
  row.open = interactiveOpenRoles.has(agent.name);
  row.addEventListener("toggle", () => {
    if (row.open) interactiveOpenRoles.add(agent.name);
    else interactiveOpenRoles.delete(agent.name);
  });

  const heading = document.createElement("summary");
  heading.className = "interactive-agent-heading";
  const roleTag = document.createElement("strong");
  roleTag.className = "interactive-role-tag";
  roleTag.textContent = agent.name;
  const modelTag = document.createElement("code");
  modelTag.className = "interactive-role-model";
  modelTag.textContent = agent.model ?? "继承默认模型";
  const badge = document.createElement("b");
  badge.className = "interactive-agent-state";
  badge.dataset.roleState = agent.name;
  const state = states.get(agent.name) ?? "unavailable";
  badge.textContent = INTERACTIVE_AGENT_STATUS_LABELS[state] ?? state;
  badge.classList.toggle("conflict", state === "conflict" || state === "unsafe" || state === "stale");
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "interactive-delete-role";
  remove.textContent = "−";
  remove.title = `删除角色 ${agent.name}`;
  remove.setAttribute("aria-label", `删除角色 ${agent.name}`);
  remove.disabled = interactiveAgentConfiguration.agents.length <= 1;
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    interactiveOpenRoles.delete(agent.name);
    interactiveAgentConfiguration.agents.splice(index, 1);
    markInteractiveConfigurationChanged({ rebuild: true });
  });
  heading.append(roleTag, modelTag, badge, remove);

  const body = document.createElement("div");
  body.className = "interactive-agent-body";
  const nameField = document.createElement("label");
  nameField.className = "interactive-role-name";
  const nameLabel = document.createElement("span");
  nameLabel.textContent = "角色名";
  const name = document.createElement("input");
  name.value = agent.name;
  name.spellcheck = false;
  name.addEventListener("input", () => {
    const previousName = agent.name;
    agent.name = name.value.trim();
    row.dataset.agentName = agent.name;
    badge.dataset.roleState = agent.name;
    roleTag.textContent = agent.name || "未命名角色";
    remove.title = `删除角色 ${agent.name || "未命名角色"}`;
    if (interactiveOpenRoles.delete(previousName)) interactiveOpenRoles.add(agent.name);
    markInteractiveConfigurationChanged({ historyGroup: `role-${index}-name` });
  });
  nameField.append(nameLabel, name);

  const descriptionField = document.createElement("label");
  descriptionField.className = "interactive-role-description";
  const descriptionLabel = document.createElement("span");
  descriptionLabel.textContent = "用途描述";
  const description = document.createElement("input");
  description.value = agent.description;
  description.addEventListener("input", () => {
    agent.description = description.value;
    markInteractiveConfigurationChanged({ historyGroup: `role-${index}-description` });
  });
  descriptionField.append(descriptionLabel, description);

  const controls = document.createElement("div");
  controls.className = "interactive-role-controls";
  const modelField = document.createElement("label");
  modelField.append(document.createTextNode("模型"));
  const model = createSelect(interactiveAgentCatalog.models ?? [], agent.model, "继承默认模型");
  model.addEventListener("change", () => {
    agent.model = model.value || null;
    modelTag.textContent = agent.model ?? "继承默认模型";
    markInteractiveConfigurationChanged();
  });
  modelField.append(model);
  const effortField = document.createElement("label");
  effortField.append(document.createTextNode("推理强度"));
  const effort = createSelect(interactiveAgentCatalog.reasoningEfforts ?? [], agent.reasoningEffort, "继承 / 模型默认");
  effort.addEventListener("change", () => {
    agent.reasoningEffort = effort.value || null;
    markInteractiveConfigurationChanged();
  });
  effortField.append(effort);
  const sandboxField = document.createElement("label");
  sandboxField.append(document.createTextNode("权限"));
  const sandbox = createSelect(interactiveAgentCatalog.sandboxModes ?? [], agent.sandboxMode, "继承主线程");
  sandbox.addEventListener("change", () => {
    agent.sandboxMode = sandbox.value || null;
    markInteractiveConfigurationChanged();
  });
  sandboxField.append(sandbox);
  controls.append(modelField, effortField, sandboxField);

  const instructions = document.createElement("label");
  instructions.className = "interactive-role-instructions";
  const instructionsLabel = document.createElement("span");
  instructionsLabel.textContent = "Markdown 指令（developer_instructions）";
  const editor = document.createElement("textarea");
  editor.value = agent.developerInstructions;
  editor.spellcheck = false;
  editor.addEventListener("input", () => {
    agent.developerInstructions = editor.value;
    markInteractiveConfigurationChanged({ historyGroup: `role-${index}-instructions` });
  });
  instructions.append(instructionsLabel, editor);
  body.append(nameField, descriptionField, controls, instructions);
  row.append(heading, body);
  return row;
}

function renderInteractiveAgentConfig() {
  if (!interactiveAgentConfiguration) return;
  const global = interactiveAgentConfiguration.globalSettings;
  if (elements.interactiveDefaultModel.options.length === 0) {
    for (const option of interactiveAgentCatalog.models ?? []) {
      elements.interactiveDefaultModel.add(new Option(option.label, option.id));
    }
  }
  if (![...elements.interactiveDefaultModel.options].some((option) => option.value === global.defaultSubagentModel)) {
    elements.interactiveDefaultModel.add(new Option(global.defaultSubagentModel, global.defaultSubagentModel));
  }
  if (elements.interactiveDefaultEffort.options.length === 0) {
    for (const effort of interactiveAgentCatalog.reasoningEfforts ?? []) {
      elements.interactiveDefaultEffort.add(new Option(effort, effort));
    }
  }
  elements.interactiveDefaultModel.value = global.defaultSubagentModel;
  elements.interactiveDefaultEffort.value = global.defaultSubagentReasoningEffort;
  elements.interactiveMaxThreads.value = String(global.maxConcurrentThreadsPerSession);
  elements.interactiveRoleCount.textContent = `${interactiveAgentConfiguration.agents.length} / ${interactiveAgentCatalog.limits?.maxAgents ?? 32}`;
  elements.interactiveAddRole.disabled = interactiveAgentConfiguration.agents.length >= (interactiveAgentCatalog.limits?.maxAgents ?? 32);
  updateInteractiveHistoryControls();

  const states = new Map(
    (interactiveAgentStatus.agents ?? []).map((agent) => [agent.name, agent.status]),
  );
  const fingerprint = interactiveConfigurationFingerprint();
  if (interactiveEditorFingerprint !== fingerprint) {
    elements.interactiveAgentList.replaceChildren(
      ...interactiveAgentConfiguration.agents.map((agent, index) => buildInteractiveRoleEditor(agent, index, states)),
    );
    interactiveEditorFingerprint = fingerprint;
  } else {
    for (const badge of elements.interactiveAgentList.querySelectorAll("[data-role-state]")) {
      const state = states.get(badge.dataset.roleState) ?? "unavailable";
      badge.textContent = INTERACTIVE_AGENT_STATUS_LABELS[state] ?? state;
      badge.classList.toggle("conflict", state === "conflict" || state === "unsafe" || state === "stale");
    }
  }

  const conflictNames = interactiveAgentStatus.conflicts ?? [];
  const removalConflicts = (interactiveAgentStatus.removals ?? [])
    .filter((removal) => removal.status === "conflict")
    .map((removal) => removal.name);
  elements.interactiveOverwriteRow.hidden = !interactiveAgentStatus.requiresOverwrite;
  elements.interactiveConflictDetail.textContent = removalConflicts.length > 0
    ? `无法自动删除外部已修改角色：${removalConflicts.join(", ")}`
    : conflictNames.length > 0
      ? `将先备份：${conflictNames.join(", ")}`
    : "检测到现有自定义配置";
  const health = interactiveAgentStatus.health;
  elements.interactiveAgentHealth.classList.toggle(
    "error",
    health === "conflict" || !["loading", "ready", "installed", "preview-only"].includes(health),
  );
  if (!interactiveAgentStatusLoaded || health === "loading" || interactivePlanPending) {
    elements.interactiveAgentHealth.textContent = "正在检查";
    elements.interactiveInstallTitle.textContent = "等待状态";
    elements.interactiveInstallDetail.textContent = "读取 Codex agents 目录";
  } else if (health === "installed") {
    elements.interactiveAgentHealth.textContent = "配置已安装";
    elements.interactiveInstallTitle.textContent = `${interactiveAgentConfiguration.agents.length} 个角色已就绪`;
    elements.interactiveInstallDetail.textContent = interactiveAgentStatus.agentsDir ?? "~/.codex/agents";
  } else if (health === "ready") {
    const imported = interactiveAgentStatus.configurationOrigin === "existing";
    elements.interactiveAgentHealth.textContent = imported ? "已读取现有配置" : "等待安装";
    elements.interactiveInstallTitle.textContent = imported
      ? `${interactiveAgentConfiguration.agents.length} 个现有角色可编辑`
      : "已加载推荐角色；激活时安装";
    elements.interactiveInstallDetail.textContent = imported
      ? "激活后备份并覆盖对应原文件"
      : interactiveAgentStatus.agentsDir ?? "~/.codex/agents";
  } else if (health === "conflict") {
    elements.interactiveAgentHealth.textContent = "检测到同名配置";
    elements.interactiveInstallTitle.textContent = "需要覆写授权";
    elements.interactiveInstallDetail.textContent = "勾选后先备份现有文件，再激活 Interactive";
  } else if (health === "preview-only") {
    elements.interactiveAgentHealth.textContent = "仅预览";
    elements.interactiveInstallTitle.textContent = "未启用全局写入";
    elements.interactiveInstallDetail.textContent = "设置 AGENT_WORKFLOW_CODEX_HOME 后可安装";
  } else {
    elements.interactiveAgentHealth.textContent = "配置被阻止";
    elements.interactiveInstallTitle.textContent = "无法安全安装";
    elements.interactiveInstallDetail.textContent = interactiveAgentStatus.error ?? health;
  }
}

function interactiveAgentIssue() {
  if (!interactiveAgentStatusLoaded) {
    return "正在读取 Codex 全局 subagent 配置。";
  }
  if (interactivePlanPending) {
    return "正在校验角色配置与文件冲突。";
  }
  if (!interactiveAgentStatus.writeEnabled) {
    return "未启用 Codex 全局 agent 写入；请设置 AGENT_WORKFLOW_CODEX_HOME。";
  }
  const removalConflict = (interactiveAgentStatus.removals ?? []).find(
    (removal) => removal.status === "conflict",
  );
  if (removalConflict) {
    return `角色 ${removalConflict.name} 的文件已被外部修改；为避免误删，请恢复该角色或手动处理文件。`;
  }
  if (interactiveAgentStatus.health === "conflict") {
    return elements.interactiveAgentOverwrite.checked
      ? null
      : "检测到同名 custom agent；需明确勾选备份并覆写。";
  }
  if (!["ready", "installed"].includes(interactiveAgentStatus.health)) {
    return interactiveAgentStatus.error ?? `Interactive agent store health: ${interactiveAgentStatus.health}`;
  }
  return null;
}

function refresh(options = {}) {
  const preserveEditor = options?.preserveEditor === true;
  const overnight = selectedModeId === "overnight";
  const interactive = selectedModeId === "interactive";
  const balanced = selectedModeId === "balanced";
  elements.builderAgent.disabled = interactive;
  elements.builderField.classList.toggle("native-mode", interactive);
  elements.builderHelp.textContent = interactive
    ? "Interactive 使用主 Agent 原生 subagent"
    : "接收实现任务的外部 Agent";
  elements.interactiveConfig.hidden = !interactive;
  elements.overnightConfig.hidden = !overnight;
  elements.balancedConfig.hidden = !balanced;
  elements.activationStep.textContent = overnight || balanced || interactive ? "04" : "03";
  if (overnight) renderOvernightPolicySummary();
  renderInteractiveAgentConfig();
  renderProjectHub();

  const draft = resolveSkillDraft();
  if (!draft.ok) {
    renderTokenChart();
    renderFailure(draft.issues);
    return;
  }

  currentDefaultResolution = draft.base;
  currentDraftKey = draft.key;
  if (!preserveEditor) elements.skillPreview.value = draft.content;
  const isDefault = draft.content === draft.base.content;
  renderSkillDraftState(isDefault, draft.customized.ok);

  if (!draft.customized.ok) {
    currentResolution = null;
    elements.compatibilityBadge.textContent = "Skill 内容无效";
    elements.compatibilityBadge.classList.add("error");
    elements.variantName.textContent = draft.base.id;
    elements.tokenEstimate.textContent = `≈ ${Math.ceil(draft.content.length / 4)} tokens`;
    elements.includedModes.textContent = draft.base.includedModeIds.join(", ");
    elements.includedAgents.textContent = draft.base.includedAgentIds.join(", ");
    elements.skillPath.textContent = draft.base.relativeSkillPath;
    elements.activateButton.disabled = true;
    elements.copyButton.disabled = true;
    elements.exportButton.disabled = true;
    renderIssues(draft.customized.issues);
    renderOperations(draft.customized);
    renderProjectHub();
    renderStoreStatus();
    renderTokenChart();
    return;
  }

  currentResolution = draft.customized.value;
  const plan = planSkillActivation(currentResolution, getInstalledState());
  if (!plan.ok) {
    renderFailure(plan.issues);
    renderProjectHub();
    return;
  }

  elements.compatibilityBadge.textContent = "兼容性通过";
  elements.compatibilityBadge.classList.remove("error");
  elements.variantName.textContent = currentResolution.id;
  elements.tokenEstimate.textContent = `≈ ${currentResolution.estimatedTokens} tokens`;
  elements.includedModes.textContent = currentResolution.includedModeIds.join(", ");
  elements.includedAgents.textContent = currentResolution.includedAgentIds.join(", ");
  elements.skillPath.textContent = currentResolution.relativeSkillPath;
  elements.activateButton.disabled = false;
  elements.copyButton.disabled = false;
  elements.exportButton.disabled = false;
  const storeBlocked = serverStatus.writeEnabled && !storeIsHealthy();
  const activationIssues = [];
  if (storeBlocked) {
    elements.compatibilityBadge.textContent = "目录写入被阻止";
    elements.compatibilityBadge.classList.add("error");
    elements.activateButton.disabled = true;
    activationIssues.push({
      path: "/skill-store",
      message: serverStatus.error ?? `Skill store health: ${serverStatus.health}`,
    });
  }
  if (projectConfigState?.migrationRequired) {
    elements.compatibilityBadge.textContent = "项目状态需要迁移";
    elements.compatibilityBadge.classList.add("error");
    elements.activateButton.disabled = true;
    activationIssues.push({
      path: "/project",
      message: "先迁移旧版项目本地状态，再激活带项目覆盖的 Skill。",
    });
  }
  const agentIssue = interactive && serverStatus.writeEnabled ? interactiveAgentIssue() : null;
  if (agentIssue) {
    elements.compatibilityBadge.textContent = "Agent 配置未就绪";
    elements.compatibilityBadge.classList.add("error");
    elements.activateButton.disabled = true;
    activationIssues.push({ path: "/interactive-agents", message: agentIssue });
  }
  renderIssues(activationIssues);
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
    if (interactive && !modeSwitchState.running && !agentIssue) {
      elements.activationNote.textContent =
        interactiveAgentStatus.health === "installed"
          ? "同步检查 SKILL.md、config.toml 与 7 个 native agents。"
          : `激活时安装到 ${interactiveAgentStatus.agentsDir ?? "Codex agents 目录"}。`;
    }
  } else {
    elements.activateButton.textContent = "激活skill";
    elements.activationNote.textContent = installed
      ? `浏览器当前记录：${installed.variantId}`
      : "保存只影响浏览器中的预览状态。";
  }
  if (modeSwitchState.running) elements.activateButton.disabled = true;
  renderProjectHub();
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
elements.overnightLoopPolicy.addEventListener("change", () => {
  renderOvernightPolicySummary();
  refresh();
});
for (const input of [
  elements.balancedMainCalls,
  elements.balancedDownstreamCalls,
  elements.balancedAdvisorCalls,
  elements.balancedReservedCalls,
]) {
  input.addEventListener("input", () => {
    synchronizeBalancedBudgetConstraints({
      clampReserved:
        input === elements.balancedMainCalls || input === elements.balancedReservedCalls,
    });
    refresh();
  });
}
for (const input of [
  elements.balancedContextWindow,
  elements.balancedFirstProgressWindow,
  elements.balancedActiveWindow,
  elements.balancedExtensionWindow,
  elements.balancedGrowingExtensionWindow,
  elements.balancedHardCap,
]) {
  input.addEventListener("input", () => {
    synchronizeBalancedTimingConstraints({ clampHardCap: input !== elements.balancedHardCap });
    refresh();
  });
}
async function requestJson(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.message ?? body.error ?? `Request failed: ${response.status}`);
    error.code = body.error;
    error.path = body.path;
    error.status = response.status;
    error.body = body;
    throw error;
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
    applyOvernightLoopPolicyToControls(preview?.overnightLoopPolicy);
    applyBalancedBudgetToControls(preview?.balancedBudget);
    applyBalancedTimingToControls(preview?.balancedTiming);
    seedStoredSkillDraft(preview);
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
  applyOvernightLoopPolicyToControls(active.overnightLoopPolicy);
  applyBalancedBudgetToControls(active.balancedBudget);
  applyBalancedTimingToControls(active.balancedTiming);
  seedStoredSkillDraft(active);
}

function savePreviewSelection(modeId) {
  const draft = resolveSkillDraft(modeId);
  if (!draft.ok || !draft.customized.ok) {
    throw new Error("当前 Skill 内容或 Agent 绑定无效。");
  }
  const resolution = draft.customized.value;
  localStorage.setItem(
    "agent-workflow-active-skill",
    JSON.stringify({
      variantId: resolution.id,
      modeId,
      relativeSkillPath: resolution.relativeSkillPath,
      contentFingerprint: resolution.contentFingerprint,
      content: resolution.content,
      overnightLoopPolicy: resolution.overnightLoopPolicy ?? null,
      balancedBudget: resolution.balancedBudget ?? null,
      balancedTiming: resolution.balancedTiming ?? null,
    }),
  );
}

function modeActivationMessage(modeId, result) {
  const mode = modeDisplayName(modeId);
  const agentSuffix = result.interactiveAgentInstall
    ? " Interactive subagents 已同步。"
    : "";
  switch (result.activationKind) {
    case "activate":
      return `${mode} Skill 已激活；重启 Codex 后生效。${agentSuffix}`;
    case "overwrite":
      return `已备份当前 Skill，并覆写为 ${mode}；重启 Codex 后生效。${agentSuffix}`;
    default:
      return `${mode} 已经是当前 Skill。${agentSuffix}`;
  }
}

async function applyModeSwitch(modeId) {
  await serverStatusReady;
  try {
    if (serverStatus.writeEnabled) {
      if (!storeIsHealthy()) {
        throw new Error(serverStatus.error ?? "Skill 目录当前不可写。");
      }
      const draft = resolveSkillDraft(modeId);
      if (!draft.ok || !draft.customized.ok) {
        throw new Error("当前 Skill 内容或 Agent 绑定无效。");
      }
      const result = await requestJson("/api/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: createProfile(modeId),
          content: draft.customized.value.content,
          allowAgentOverwrite:
            modeId === "interactive" && elements.interactiveAgentOverwrite.checked,
          interactiveAgents:
            modeId === "interactive" ? interactiveAgentConfiguration : undefined,
        }),
      });
      serverStatus = result.status;
      if (result.interactiveAgentInstall?.status) {
        interactiveAgentStatus = result.interactiveAgentInstall.status;
        interactiveBaselineConfiguration = cloneJson(interactiveAgentConfiguration);
        interactiveAgentStatusLoaded = true;
        elements.interactiveAgentOverwrite.checked = false;
      }
      if (modeId === selectedModeId) showToast(modeActivationMessage(modeId, result));
      loadHistory();
    } else if (serverStatus.health === "preview-only") {
      savePreviewSelection(modeId);
      if (modeId === "interactive") {
        interactiveBaselineConfiguration = cloneJson(interactiveAgentConfiguration);
      }
      if (modeId === selectedModeId) {
        showToast(`${modeDisplayName(modeId)} 已切换为浏览器预览；尚未写入 Codex。`);
      }
    } else {
      throw new Error(serverStatus.error ?? "无法确认 Skill 激活状态。");
    }
  } catch (error) {
    if (modeId === selectedModeId) showToast(`模式切换失败：${error.message}`);
    if (modeId === "interactive") loadInteractiveAgentStatus();
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

function integrationHealthCopy(health) {
  const labels = {
    ready: "已就绪",
    "ready-to-activate": "可激活",
    "project-setup-required": "待初始化项目",
    "project-sync-required": "项目待同步",
    "project-unhealthy": "项目检查异常",
    "not-installed": "未安装",
    unhealthy: "诊断异常",
    blocked: "已阻断",
    "registration-required": "待登记 Server",
    available: "可用",
    "not-applicable": "不适用",
    "not-initialized": "未初始化",
    "sync-required": "待同步",
    "verification-unavailable": "无法验证",
    "ready-with-unknown-drift": "漂移未知",
    "identity-mismatch": "项目不匹配",
    "identity-unverified": "身份未知",
    "marker-present": "标记已存在",
    unknown: "未知",
    compatible: "契约兼容",
    "drift-detected": "检测到漂移",
    incompatible: "协议不兼容",
    unavailable: "核心缺失",
  };
  return labels[health] ?? health ?? "未知";
}

function shortHash(value) {
  if (typeof value !== "string") return "—";
  return value.length > 24 ? `${value.slice(0, 18)}…${value.slice(-6)}` : value;
}

function renderWorkflowSource() {
  const source = workflowSourceData;
  const health = source?.health ?? "unavailable";
  elements.workflowSourcePanel.className = `workflow-source-panel health-${health}`;
  elements.workflowSourceHealth.textContent = integrationHealthCopy(health);
  elements.workflowSourceVersion.textContent = source?.contractVersion ? `v${source.contractVersion}` : "未发现";
  elements.workflowSourceSupport.textContent = `Contract ${source?.supported?.contractMajor ?? 1}.${source?.supported?.minimumContractMinor ?? 1}+`;
  elements.workflowSourceHash.textContent = shortHash(source?.contractSha256);
  elements.workflowSourceHash.title = source?.contractSha256 ?? "";
  elements.workflowSourceRuntime.textContent = source?.authority?.localRuntime === "embedded-projection"
    ? "内置投影"
    : source?.authority?.localRuntime === "compatibility-layer" ? "安全默认值" : "未知";
  elements.workflowSourcePath.textContent = source?.source?.contractPath
    ? `内置核心：${source.source.contractPath}`
    : `内置核心缺失：${source?.source?.root ?? "packages/workflow-core"}`;
  elements.workflowSourceDiagnostic.replaceChildren();

  for (const item of source?.checks ?? []) {
    const row = document.createElement("p");
    row.className = item.status;
    const marker = document.createElement("i");
    marker.textContent = item.status === "passed" ? "✓" : item.status === "failed" ? "×" : "·";
    const copy = document.createElement("span");
    copy.textContent = `${item.label}：${item.detail}`;
    row.append(marker, copy);
    elements.workflowSourceDiagnostic.append(row);
  }
  for (const drift of source?.drift ?? []) {
    const row = document.createElement("p");
    row.className = drift.severity === "warning" ? "warning" : "info";
    const marker = document.createElement("i");
    marker.textContent = drift.severity === "warning" ? "!" : "i";
    const copy = document.createElement("span");
    copy.textContent = `漂移 · ${drift.id}：${drift.detail}`;
    row.append(marker, copy);
    elements.workflowSourceDiagnostic.append(row);
  }
}

function integrationKindCopy(kind) {
  return kind === "mcp-server" ? "MCP SERVER" : "LOCAL TOOL";
}

function integrationStatusMetric(label, value) {
  const item = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value;
  item.append(name, data);
  return item;
}

function integrationLayer(titleText, layer, metrics) {
  const panel = document.createElement("section");
  panel.className = `integration-layer health-${layer?.health ?? "unknown"}`;
  const heading = document.createElement("div");
  heading.className = "integration-layer-heading";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const badge = document.createElement("span");
  badge.className = "integration-layer-badge";
  badge.textContent = integrationHealthCopy(layer?.health ?? "unknown");
  heading.append(title, badge);
  const details = document.createElement("div");
  details.className = "integration-layer-details";
  for (const [label, value] of metrics) details.append(integrationStatusMetric(label, value));
  panel.append(heading, details);
  return panel;
}

function projectInitializationCopy(project) {
  if (!project?.applicable) return "不适用";
  if (project.health === "blocked") return "项目标记不安全";
  if (project.health === "identity-mismatch") return "项目身份不匹配";
  if (project.health === "unavailable") return "无法读取";
  if (project.initialized === false) return "未初始化";
  if (project.initialized === true && project.verified) return "已验证";
  if (project.initialized === true) return "已存在，未通过验证";
  return "未知";
}

function integrationPlanCopy(status) {
  if (status.global?.available === false) return "查看全局安装计划";
  if (status.project?.health === "not-initialized") return "查看项目初始化计划";
  if (status.project?.health === "sync-required") return "查看项目同步计划";
  if (status.health === "ready-to-activate") return "查看 Harness 激活计划";
  return "查看维护计划";
}

function renderIntegrationDiagnostic(target, diagnostic) {
  const receipt = document.createElement("div");
  receipt.className = "integration-diagnostic";
  const heading = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "只读诊断回执";
  const time = document.createElement("span");
  time.textContent = diagnostic.testedAt
    ? new Date(diagnostic.testedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "刚刚";
  heading.append(title, time);
  receipt.append(heading);
  for (const entry of diagnostic.checks ?? []) {
    const row = document.createElement("p");
    row.className = entry.status;
    const marker = document.createElement("i");
    marker.textContent = entry.status === "passed" ? "✓" : entry.status === "failed" ? "×" : "·";
    const copy = document.createElement("span");
    const layer = entry.layer === "global" ? "全局" : entry.layer === "project" ? "项目" : "系统";
    copy.textContent = `${layer} · ${entry.label}：${entry.detail}`;
    row.append(marker, copy);
    receipt.append(row);
  }
  target.append(receipt);
}

function renderIntegrations() {
  elements.integrationList.replaceChildren();
  const integrations = integrationsData?.integrations ?? [];
  elements.integrationsTotal.textContent = String(integrations.length);
  elements.integrationsInstalled.textContent = String(
    integrationsData?.summary?.globalAvailable ??
      integrations.filter((entry) => entry.status.global?.available === true).length,
  );
  elements.integrationsConfigured.textContent = String(
    integrationsData?.summary?.projectInitialized ??
      integrations.filter((entry) => entry.status.project?.initialized === true && entry.status.project?.verified).length,
  );
  elements.integrationsStatus.textContent = integrationsData
    ? `${integrationsData.projectRoot} · 安装执行关闭`
    : "等待首次发现";

  if (integrations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "integration-empty";
    empty.textContent = "没有可用的 Integration Manifest。";
    elements.integrationList.append(empty);
    renderProjectHub();
    return;
  }

  for (const entry of integrations) {
    const { manifest, status } = entry;
    const card = document.createElement("article");
    card.className = `integration-card health-${status.health}`;

    const heading = document.createElement("div");
    heading.className = "integration-card-heading";
    const identity = document.createElement("div");
    const kind = document.createElement("span");
    kind.className = "integration-kind";
    kind.textContent = integrationKindCopy(manifest.kind);
    const title = document.createElement("h2");
    title.textContent = manifest.displayName;
    const version = document.createElement("code");
    version.textContent = `${manifest.id}@${manifest.manifestVersion}`;
    identity.append(kind, title, version);
    const badge = document.createElement("span");
    badge.className = "integration-health";
    badge.textContent = integrationHealthCopy(status.health);
    heading.append(identity, badge);

    const summary = document.createElement("p");
    summary.className = "integration-summary-copy";
    summary.textContent = manifest.summary;

    const layers = document.createElement("div");
    layers.className = "integration-layer-grid";
    layers.append(
      integrationLayer("全局环境", status.global, [
        ["命令", status.global?.command ?? "等待登记"],
        ["版本", status.global?.version ?? (status.global?.available === true ? "未知" : "不可见")],
      ]),
      integrationLayer("当前项目", status.project, [
        ["项目标记", status.project?.marker ? `${status.project.marker}/` : "不适用"],
        ["初始化", projectInitializationCopy(status.project)],
        ["索引状态", status.project?.reindexRecommended === true
          ? "建议重建"
          : Number.isSafeInteger(status.project?.pendingChanges)
            ? `${status.project.pendingChanges} 项待同步`
          : status.project?.applicable ? "未知" : "不适用"],
      ]),
    );

    const capabilityList = document.createElement("div");
    capabilityList.className = "integration-capabilities";
    for (const capability of manifest.capabilities ?? []) {
      const chip = document.createElement("span");
      chip.textContent = capability;
      capabilityList.append(chip);
    }

    const support = document.createElement("p");
    support.className = "integration-support";
    support.textContent = `Harness：${(manifest.harnessSupport ?? [])
      .map((item) => item.displayName)
      .join(" · ")}`;

    const actions = document.createElement("div");
    actions.className = "integration-actions";
    const diagnose = document.createElement("button");
    diagnose.className = "button ghost";
    diagnose.type = "button";
    diagnose.dataset.integrationId = manifest.id;
    diagnose.dataset.integrationAction = "diagnose";
    diagnose.textContent = "只读诊断";
    const plan = document.createElement("button");
    plan.className = "button ghost";
    plan.type = "button";
    plan.dataset.integrationId = manifest.id;
    plan.dataset.integrationAction = "plan";
    plan.textContent = integrationPlanCopy(status);
    actions.append(diagnose, plan);

    card.append(heading, summary, layers, capabilityList, support, actions);
    const diagnostic = integrationDiagnostics.get(manifest.id);
    if (diagnostic) renderIntegrationDiagnostic(card, diagnostic);
    elements.integrationList.append(card);
  }
  renderProjectHub();
}

function integrationPlanMeta(label, value) {
  const item = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const data = document.createElement("strong");
  data.textContent = value;
  item.append(name, data);
  return item;
}

function renderIntegrationPlan(plan) {
  elements.integrationPlanPanel.hidden = false;
  elements.integrationPlanTitle.textContent = `${plan.integrationId} 安装计划`;
  elements.integrationPlanMeta.replaceChildren(
    integrationPlanMeta("Manifest", `${plan.integrationId}@${plan.manifestVersion}`),
    integrationPlanMeta("Harness", plan.harnessId),
    integrationPlanMeta("范围", plan.scope === "global" ? "全局" : "项目级"),
    integrationPlanMeta("执行状态", plan.executable ? "允许执行" : "仅预览"),
  );
  elements.integrationPlanSteps.replaceChildren();
  for (const [index, step] of (plan.steps ?? []).entries()) {
    const row = document.createElement("article");
    const marker = document.createElement("span");
    marker.textContent = String(index + 1).padStart(2, "0");
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = step.summary;
    const kind = document.createElement("small");
    kind.textContent = `${step.kind} · ${step.requiresNetwork ? "需要网络" : "无需网络"}`;
    content.append(title, kind);
    if (step.argv) {
      const command = document.createElement("code");
      command.textContent = JSON.stringify({ cwd: step.cwd, argv: step.argv });
      content.append(command);
    }
    if ((step.mutates ?? []).length > 0) {
      const mutates = document.createElement("p");
      mutates.textContent = `预计写入：${step.mutates.join("、")}`;
      content.append(mutates);
    }
    row.append(marker, content);
    elements.integrationPlanSteps.append(row);
  }
  elements.integrationPlanPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function loadIntegrations() {
  if (integrationsLoading) {
    integrationsRefreshQueued = true;
    return;
  }
  integrationsLoading = true;
  elements.integrationsRefresh.disabled = true;
  elements.integrationsStatus.textContent = "正在发现本地工具与项目配置…";
  const storedProject = localStorage.getItem(INTEGRATION_PROJECT_KEY) ?? "";
  if (!elements.integrationsProjectRoot.value && storedProject) {
    elements.integrationsProjectRoot.value = storedProject;
  }
  const requestedProject = elements.integrationsProjectRoot.value.trim();
  const query = new URLSearchParams();
  if (requestedProject) query.set("projectRoot", requestedProject);
  try {
    const suffix = query.size > 0 ? `?${query}` : "";
    const [result, source] = await Promise.all([
      requestJson(`/api/integrations${suffix}`),
      requestJson("/api/workflow-core"),
    ]);
    const projectChanged = integrationsData?.projectRoot && integrationsData.projectRoot !== result.projectRoot;
    integrationsData = result;
    workflowSourceData = source;
    elements.integrationsProjectRoot.value = result.projectRoot;
    localStorage.setItem(INTEGRATION_PROJECT_KEY, result.projectRoot);
    if (projectChanged) integrationDiagnostics.clear();
    renderIntegrations();
    renderWorkflowSource();
  } catch (error) {
    integrationsData = null;
    elements.integrationList.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "integration-empty error";
    empty.textContent = `集成发现失败：${error.message}`;
    elements.integrationList.append(empty);
    elements.integrationsTotal.textContent = "—";
    elements.integrationsInstalled.textContent = "—";
    elements.integrationsConfigured.textContent = "—";
    elements.integrationsStatus.textContent = "项目路径或本地环境不可用";
    workflowSourceData = null;
    renderWorkflowSource();
  } finally {
    integrationsLoading = false;
    elements.integrationsRefresh.disabled = false;
    renderProjectHub();
    if (integrationsRefreshQueued) {
      integrationsRefreshQueued = false;
      queueMicrotask(loadIntegrations);
    }
  }
}

async function diagnoseWorkflowSource() {
  elements.workflowSourceDiagnose.disabled = true;
  const original = elements.workflowSourceDiagnose.textContent;
  elements.workflowSourceDiagnose.textContent = "检查中…";
  try {
    workflowSourceData = await requestJson("/api/workflow-core/diagnose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    renderWorkflowSource();
    showToast(`Workflow Contract：${integrationHealthCopy(workflowSourceData.health)}。`);
  } catch (error) {
    showToast(`Workflow Contract 诊断失败：${error.message}`);
  } finally {
    elements.workflowSourceDiagnose.disabled = false;
    elements.workflowSourceDiagnose.textContent = original;
  }
}

async function runIntegrationAction(button) {
  const integrationId = button.dataset.integrationId;
  const action = button.dataset.integrationAction;
  if (!integrationId || !["diagnose", "plan"].includes(action)) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = action === "diagnose" ? "诊断中…" : "生成中…";
  try {
    const result = await requestJson(
      `/api/integrations/${encodeURIComponent(integrationId)}/${action}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectRoot: elements.integrationsProjectRoot.value,
          harnessId: elements.integrationsHarness.value,
          scope: elements.integrationsScope.value,
        }),
      },
    );
    if (action === "diagnose") {
      integrationDiagnostics.set(integrationId, result);
      renderIntegrations();
      showToast(`${integrationId} 只读诊断已完成。`);
    } else {
      renderIntegrationPlan(result);
    }
  } catch (error) {
    showToast(`${action === "diagnose" ? "诊断" : "计划生成"}失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function loadRuntimeUsage() {
  if (usageLoading) {
    usageRefreshQueued = true;
    return;
  }
  usageLoading = true;
  showRuntimeLoadStatus("loading");
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
    showRuntimeLoadStatus("complete");
  } catch (error) {
    if (stillCurrent()) {
      hideRuntimeLoadStatus();
      renderRuntimeError(error.message);
    }
  } finally {
    usageLoading = false;
    if (usageRefreshQueued) {
      usageRefreshQueued = false;
      loadRuntimeUsage();
    }
  }
}

const COORDINATION_COVERAGE_LABELS = {
  enforced: "已强制",
  observed: "已观测",
  "not-observed": "尚无事件",
  unsupported: "不支持",
  mixed: "混合覆盖",
};

function renderCoordinationCoverage(element, label, status) {
  element.className = status;
  element.replaceChildren();
  const dot = document.createElement("i");
  element.append(dot, `${label}：${COORDINATION_COVERAGE_LABELS[status] ?? "未知"}`);
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const COORDINATION_KIND_COLORS = Object.freeze({
  artifact_read: "#7ea7ff",
  artifact_write: "#c78cff",
  agent_invoke_started: "#d8ff4f",
  agent_invoke_completed: "#9fd36a",
  state_transition: "#ffcf66",
  review_decision: "#ff8f70",
  validation_completed: "#67d8c4",
  wake_requested: "#f49ac2",
  wake_delivered: "#cf8cff",
});

function coordinationSvgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function renderCoordinationGraph(detail) {
  elements.coordinationGraphShell.replaceChildren();
  const nodes = detail.graph?.nodes ?? [];
  const edges = detail.graph?.edges ?? [];
  if (nodes.length === 0) {
    const empty = document.createElement("p");
    empty.className = "coordination-empty";
    empty.textContent = "返回范围内没有可绘制的端点关系。无目标事件仍会显示在时间线中。";
    elements.coordinationGraphShell.append(empty);
    return;
  }
  const laneHeight = 48;
  const labelWidth = 190;
  const width = Math.max(860, labelWidth + edges.length * 38 + 80);
  const height = Math.max(180, nodes.length * laneHeight + 42);
  const svg = coordinationSvgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: "presentation",
  });
  const laneByNode = new Map();
  nodes.forEach((node, index) => {
    const y = 30 + index * laneHeight;
    laneByNode.set(node.id, y);
    svg.append(coordinationSvgElement("line", {
      x1: labelWidth,
      y1: y,
      x2: width - 18,
      y2: y,
      class: "coordination-graph-lane",
    }));
    const label = coordinationSvgElement("text", {
      x: 12,
      y: y + 4,
      class: `coordination-graph-label ${node.type}`,
    });
    label.textContent = `${node.type} · ${node.label}`;
    svg.append(label);
  });
  edges.forEach((edge, index) => {
    const x = labelWidth + 24 + index * 38;
    const sourceY = laneByNode.get(edge.source);
    const targetY = laneByNode.get(edge.target);
    if (sourceY === undefined || targetY === undefined) return;
    const color = COORDINATION_KIND_COLORS[edge.kind] ?? "#8b97a3";
    const line = coordinationSvgElement("line", {
      x1: x,
      y1: sourceY,
      x2: x,
      y2: targetY,
      class: "coordination-graph-edge",
      stroke: color,
    });
    const title = coordinationSvgElement("title");
    title.textContent = `#${edge.sequence} ${edge.kind} · ${formatHistoryDate(edge.recordedAt)}`;
    line.append(title);
    svg.append(line);
    svg.append(coordinationSvgElement("circle", { cx: x, cy: sourceY, r: 4, fill: color }));
    svg.append(coordinationSvgElement("circle", { cx: x, cy: targetY, r: 4, fill: color }));
    if (index % 5 === 0 || index === edges.length - 1) {
      const sequence = coordinationSvgElement("text", {
        x,
        y: 14,
        class: "coordination-graph-sequence",
        "text-anchor": "middle",
      });
      sequence.textContent = `#${edge.sequence}`;
      svg.append(sequence);
    }
  });
  elements.coordinationGraphShell.append(svg);
}

function renderCoordinationEventTimeline(detail) {
  elements.coordinationEventList.replaceChildren();
  const events = detail.timeline?.events ?? [];
  if (events.length === 0) {
    const empty = document.createElement("p");
    empty.className = "coordination-empty";
    empty.textContent = "返回范围内没有可展示的事件。";
    elements.coordinationEventList.append(empty);
    return;
  }
  for (const event of events) {
    const article = document.createElement("article");
    const heading = document.createElement("div");
    const kind = document.createElement("strong");
    kind.textContent = `#${event.sequence} · ${event.kind}`;
    const time = document.createElement("time");
    time.dateTime = event.recordedAt;
    time.textContent = formatHistoryDate(event.recordedAt);
    heading.append(kind, time);
    const path = document.createElement("p");
    path.textContent = `${event.actor.type}:${event.actor.id}${event.target ? ` → ${event.target.type}:${event.target.id}` : ""}`;
    const attributes = document.createElement("small");
    const values = [
      ...Object.entries(event.detail ?? {}).map(([key, value]) => `${key}=${value}`),
      ...["tokens", "bytes", "elapsedMilliseconds"]
        .filter((key) => event.measurement?.[key] !== undefined)
        .map((key) => `${key}=${event.measurement[key]}`),
    ];
    attributes.textContent = values.length > 0 ? values.join(" · ") : `${event.measurement.source} · ${event.measurement.confidence}`;
    article.append(heading, path, attributes);
    elements.coordinationEventList.append(article);
  }
}

async function loadCoordinationDetail(run, options = {}) {
  const requestId = ++coordinationDetailRequest;
  selectedCoordinationRun = `${run.mode}:${run.runId}`;
  elements.coordinationDetailPanel.hidden = false;
  elements.coordinationDetailTitle.textContent = run.runId;
  if (!options.background) {
    elements.coordinationDetailStatus.textContent = "正在读取经过脱敏投影的协调事件…";
    elements.coordinationGraphShell.replaceChildren();
    elements.coordinationEventList.replaceChildren();
  }
  refreshActivityRunSelections();
  try {
    const detail = await requestJson(
      `/api/coordination/${encodeURIComponent(run.mode)}/${encodeURIComponent(run.runId)}?limit=200`,
    );
    if (requestId !== coordinationDetailRequest) return;
    const rejected = detail.timeline.invalidLines + detail.timeline.rejectedEvents;
    elements.coordinationDetailStatus.textContent = `显示 ${detail.timeline.returnedEvents} / ${detail.timeline.totalEvents} 条事件${detail.timeline.truncated ? " · 已截取最近事件" : ""}${rejected > 0 ? ` · 拒绝 ${rejected} 条无效记录` : ""}`;
    renderCoordinationGraph(detail);
    renderCoordinationEventTimeline(detail);
    if (!options.background) {
      elements.coordinationDetailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    if (requestId !== coordinationDetailRequest) return;
    elements.coordinationDetailStatus.textContent = `详情加载失败：${error.message}`;
    renderCoordinationGraph({ graph: { nodes: [], edges: [] } });
  }
}

function coordinationRunView(run) {
  return run.coordination
    ? {
        ...run.coordination,
        runId: run.runId,
        mode: run.mode,
        adapterId: run.adapterId ?? run.coordination.adapterId,
        state: run.state ?? run.coordination.state,
        association: run.association,
        projectBinding: run.projectBinding ?? null,
      }
    : run;
}

function associationText(association) {
  if (association?.status !== "linked") {
    return `未关联 · ${association?.reason ?? "缺少激活上下文"}`;
  }
  if (association.source === "explicit") return "精确关联 · Activation ID";
  if (association.source === "skill-hash") return "精确关联 · Skill Hash";
  return "推断关联 · 时间与模式";
}

function renderActivityRuns(target, runs, options = {}) {
  target.replaceChildren();
  if (runs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "coordination-empty";
    empty.textContent = options.empty ?? "尚无运行记录。";
    target.append(empty);
    return;
  }
  for (const source of runs) {
    const run = coordinationRunView(source);
    const article = document.createElement("article");
    article.classList.toggle("selected", selectedCoordinationRun === `${run.mode}:${run.runId}`);
    const identity = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = run.runId;
    const subtitle = document.createElement("span");
    const bindingLabel = run.projectBinding
      ? `workspace ${shortHash(run.projectBinding.workspaceId)}${run.projectBinding.projectId ? ` · project ${shortHash(run.projectBinding.projectId)}` : ""}@r${run.projectBinding.projectRevision}`
      : "global";
    subtitle.textContent = `${run.mode} · ${run.adapterId ?? "adapter 未知"} · ${run.state ?? "状态未知"} · ${bindingLabel}`;
    const association = document.createElement("span");
    association.className = `coordination-association ${run.association?.confidence ?? "unknown"}`;
    association.textContent = associationText(run.association);
    identity.append(title, subtitle);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "coordination-run-open";
    open.textContent = "查看时序";
    open.addEventListener("click", () => loadCoordinationDetail(run));
    identity.append(association, open);
    const metrics = document.createElement("div");
    metrics.className = "coordination-run-metrics";
    for (const [label, value] of [
      ["调用", run.agentInvocations],
      ["读取", run.artifactReads],
      ["制品", run.artifactWrites],
      ["违规", run.readViolations],
      ["重复", run.topology?.repeatedArtifactReads],
      ["转换", run.stateTransitions],
      ["审阅", run.reviewDecisions],
      ["事件", run.eventCount],
    ]) {
      const item = document.createElement("span");
      item.textContent = `${label} ${exactNumber.format(value ?? 0)}`;
      metrics.append(item);
    }
    const coverage = document.createElement("small");
    coverage.textContent = `读取 ${COORDINATION_COVERAGE_LABELS[run.coverage?.read] ?? "未知"} (${run.containment?.read ?? "能力未知"}) · 分类 允许 ${run.readClassifications?.allowed ?? 0} / 越界 ${run.readClassifications?.outOfScope ?? 0} / 禁止 ${run.readClassifications?.forbidden ?? 0} / 未知 ${run.readClassifications?.unknown ?? 0} · 拓扑 ${run.topology?.nodeCount ?? 0} 节点 / ${run.topology?.relationshipCount ?? 0} 边`;
    article.append(identity, metrics, coverage);
    target.append(article);
  }
}

function renderCoordinationRuns(runs) {
  renderActivityRuns(elements.coordinationRunList, runs, {
    empty: "没有未关联运行。所有可识别运行都已归入对应激活快照。",
  });
}

function refreshActivityRunSelections() {
  renderCoordinationRuns(historyData?.unlinkedRuns ?? []);
  const selected = historyData?.entries?.find((entry) => entry.historyId === selectedHistoryId);
  if (selected && !elements.historyDetail.hidden) {
    renderActivityRuns(elements.historyRunList, selected.runs ?? [], {
      empty: "该激活快照尚无关联运行。",
    });
  }
}

function refreshSelectedCoordinationDetail() {
  if (!selectedCoordinationRun) return;
  const runs = [
    ...(historyData?.entries ?? []).flatMap((entry) => entry.runs ?? []),
    ...(historyData?.unlinkedRuns ?? []),
  ];
  const run = runs.find((candidate) => `${candidate.mode}:${candidate.runId}` === selectedCoordinationRun);
  if (run) loadCoordinationDetail(run, { background: true });
}

async function loadCoordination() {
  elements.coordinationRefresh.disabled = true;
  try {
    const result = await requestJson("/api/coordination?limit=50");
    elements.coordinationRuns.textContent = exactNumber.format(result.aggregate.runs);
    elements.coordinationEvents.textContent = exactNumber.format(result.aggregate.events);
    elements.coordinationInvocations.textContent = exactNumber.format(result.aggregate.agentInvocations);
    elements.coordinationReads.textContent = exactNumber.format(result.aggregate.artifactReads);
    elements.coordinationWrites.textContent = exactNumber.format(result.aggregate.artifactWrites);
    elements.coordinationReadViolations.textContent = exactNumber.format(result.aggregate.readViolations);
    elements.coordinationReadsAllowed.textContent = exactNumber.format(result.aggregate.readClassifications.allowed);
    elements.coordinationReadsOutOfScope.textContent = exactNumber.format(result.aggregate.readClassifications.outOfScope);
    elements.coordinationReadsForbidden.textContent = exactNumber.format(result.aggregate.readClassifications.forbidden);
    elements.coordinationReadsUnknown.textContent = exactNumber.format(result.aggregate.readClassifications.unknown);
    elements.coordinationReadsRepeated.textContent = exactNumber.format(result.aggregate.topology.repeatedArtifactReads);
    elements.coordinationReadArtifacts.textContent = exactNumber.format(result.aggregate.topology.uniqueReadArtifacts);
    elements.coordinationTopologyNodes.textContent = exactNumber.format(result.aggregate.topology.nodeCount);
    elements.coordinationTopologyRelationships.textContent = exactNumber.format(result.aggregate.topology.relationshipCount);
    elements.coordinationReaderLinks.textContent = exactNumber.format(result.aggregate.topology.artifactReaderLinks);
    elements.coordinationMaxReaderFanOut.textContent = exactNumber.format(result.aggregate.topology.maxArtifactReaderFanOut);
    elements.coordinationTransitions.textContent = exactNumber.format(result.aggregate.stateTransitions);
    elements.coordinationReviews.textContent = exactNumber.format(result.aggregate.reviewDecisions);
    elements.coordinationUpdated.textContent = `更新于 ${formatHistoryDate(result.generatedAt)}`;
    renderCoordinationCoverage(elements.coordinationCoverageInvoke, "调用", result.coverage.invoke);
    renderCoordinationCoverage(elements.coordinationCoverageWrite, "写入", result.coverage.write);
    renderCoordinationCoverage(elements.coordinationCoverageRead, "读取", result.coverage.read);
    renderCoordinationCoverage(elements.coordinationCoverageMessage, "消息", result.coverage.message);
    renderCoordinationRuns(historyData?.unlinkedRuns ?? []);
  } catch (error) {
    elements.coordinationUpdated.textContent = `采集失败：${error.message}`;
    renderCoordinationRuns(historyData?.unlinkedRuns ?? []);
  } finally {
    elements.coordinationRefresh.disabled = false;
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

async function loadInteractiveAgentStatus() {
  try {
    interactiveAgentStatus = await requestJson("/api/interactive-agents");
    interactiveAgentCatalog = interactiveAgentStatus.catalog ?? interactiveAgentCatalog;
    if (!interactiveAgentConfiguration) {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(INTERACTIVE_DRAFT_KEY) ?? "null");
      } catch {
        localStorage.removeItem(INTERACTIVE_DRAFT_KEY);
      }
      const serverConfiguration = interactiveAgentStatus.configuration ?? interactiveAgentStatus.preset;
      const sameSources = saved && JSON.stringify(saved.sourceAgents ?? []) === JSON.stringify(serverConfiguration?.sourceAgents ?? []);
      if (saved && !sameSources) {
        saved = null;
        localStorage.removeItem(INTERACTIVE_DRAFT_KEY);
      }
      interactiveAgentConfiguration = cloneJson(saved ?? serverConfiguration);
      interactiveBaselineConfiguration = cloneJson(
        interactiveAgentStatus.configuration ?? interactiveAgentStatus.preset,
      );
      initializeInteractiveHistory();
      interactiveEditorFingerprint = null;
      if (saved) {
        interactivePlanPending = true;
        queueMicrotask(planInteractiveAgentConfiguration);
      }
    }
  } catch (error) {
    interactiveAgentStatus = {
      writeEnabled: false,
      health: "status-unavailable",
      conflicts: [],
      agents: [],
      preset: { globalSettings: {}, agents: [] },
      error: error.message,
    };
  } finally {
    interactiveAgentStatusLoaded = true;
  }
  renderInteractiveAgentConfig();
  refresh();
}

elements.activateButton.addEventListener("click", async () => {
  if (!currentResolution || projectConfigState?.migrationRequired) return;
  if (serverStatus.writeEnabled) {
    elements.activateButton.disabled = true;
    try {
      const result = await requestJson("/api/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: createProfile(),
          content: currentResolution.content,
          allowAgentOverwrite:
            selectedModeId === "interactive" && elements.interactiveAgentOverwrite.checked,
          interactiveAgents:
            selectedModeId === "interactive" ? interactiveAgentConfiguration : undefined,
          projectContext:
            projectConfigState?.initialized && projectConfigState.workspaceId
              ? {
                projectRoot: projectConfigState.projectRoot,
                workspaceId: projectConfigState.workspaceId,
                expectedRevision: projectConfigState.revision,
                configSha256: projectConfigState.configSha256,
              }
            : undefined,
        }),
      });
      serverStatus = result.status;
      if (result.interactiveAgentInstall?.status) {
        interactiveAgentStatus = result.interactiveAgentInstall.status;
        interactiveAgentConfiguration = cloneJson(
          result.interactiveAgentInstall.status.configuration ?? interactiveAgentConfiguration,
        );
        interactiveBaselineConfiguration = cloneJson(interactiveAgentConfiguration);
        localStorage.removeItem(INTERACTIVE_DRAFT_KEY);
        initializeInteractiveHistory();
        interactiveEditorFingerprint = null;
        interactiveAgentStatusLoaded = true;
        elements.interactiveAgentOverwrite.checked = false;
      }
      showToast(modeActivationMessage(selectedModeId, result));
      loadHistory();
    } catch (error) {
      showToast(`激活失败：${error.message}`);
      if (selectedModeId === "interactive") loadInteractiveAgentStatus();
    }
    renderModeCards();
    refresh();
    return;
  }
  savePreviewSelection(selectedModeId);
  if (selectedModeId === "interactive") {
    interactiveBaselineConfiguration = cloneJson(interactiveAgentConfiguration);
  }
  showToast("已保存为当前预览 Skill；尚未写入 Codex。");
  refresh();
});
elements.skillPreview.addEventListener("input", () => {
  if (!currentDefaultResolution || !currentDraftKey) return;
  const content = elements.skillPreview.value;
  if (content === currentDefaultResolution.content) {
    skillDrafts.delete(currentDraftKey);
  } else {
    skillDrafts.set(currentDraftKey, content);
  }
  refresh({ preserveEditor: true });
});
elements.projectConfigCheck.addEventListener("click", () => loadProjectConfig());
elements.projectConfigBrowse.addEventListener("click", chooseProjectDirectory);
elements.projectCurrentActivate.addEventListener("click", () => {
  if (!elements.activateButton.disabled) elements.activateButton.click();
});
elements.projectCurrentRunAction.addEventListener("click", async () => {
  const run = currentWorkspaceRuns()[0];
  if (elements.projectCurrentRunAction.dataset.action === "task-card" || !run) {
    switchView("task-card");
    return;
  }
  elements.projectCurrentRunAction.disabled = true;
  try {
    await openWorkspaceRun(run);
  } catch (error) {
    showToast(`运行记录打开失败：${error.message}`);
  } finally {
    renderProjectHub();
  }
});
elements.projectCurrentIntegrations.addEventListener("click", async () => {
  const root = projectConfigState?.projectRoot;
  if (!root || integrationsLoading) return;
  elements.integrationsProjectRoot.value = root;
  await loadIntegrations();
  showToast(integrationsData?.projectRoot === root ? "集成状态已刷新。" : "集成状态刷新失败，请查看工具与集成页面。");
});
elements.recentProjectRefresh.addEventListener("click", loadRecentProjects);
elements.projectConfigRoot.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadProjectConfig();
});
elements.projectConfigInitialize.addEventListener("click", async () => {
  const projectRoot = elements.projectConfigRoot.value.trim();
  if (!projectRoot || projectConfigLoading) return;
  if (!window.confirm(
    "启用仓库级配置？\n\n这会创建 .agent-control-plane/project.json 和 workflow.json；不会自动提交 Git。",
  )) return;
  projectConfigLoading = true;
  renderProjectConfig();
  try {
    projectConfigState = await requestJson("/api/projects/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });
    elements.projectConfigRoot.value = projectConfigState.projectRoot;
    localStorage.setItem(INTEGRATION_PROJECT_KEY, projectConfigState.projectRoot);
    applyProjectOverrides(projectConfigState.overrides);
    showToast("已启用仓库级配置；尚未写入 Harness 或提交 Git。");
    void loadRecentProjects();
    void loadIntegrations();
  } catch (error) {
    showToast(`仓库级配置启用失败：${error.message}`);
  } finally {
    projectConfigLoading = false;
    renderProjectConfig();
  }
});
elements.projectConfigMigrate.addEventListener("click", async () => {
  if (!projectConfigState?.migrationRequired || projectConfigLoading) return;
  if (!window.confirm(
    "迁移旧项目状态？\n\n仓库中的 history 会在校验后复制到本机 workspace；project.json 和 workflow.json 将升级为声明式配置，旧历史不会被删除。",
  )) return;
  projectConfigLoading = true;
  renderProjectConfig();
  try {
    projectConfigState = await requestJson("/api/projects/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectRoot: projectConfigState.projectRoot }),
    });
    applyProjectOverrides(projectConfigState.overrides);
    showToast(`项目状态迁移完成；已复制 ${projectConfigState.migration?.movedHistory ?? 0} 条历史到本机 workspace。`);
    void loadRecentProjects();
  } catch (error) {
    showToast(`项目状态迁移失败：${error.message}`);
  } finally {
    projectConfigLoading = false;
    renderProjectConfig();
  }
});
elements.projectConfigSave.addEventListener("click", () =>
  writeProjectOverrides(currentProjectOverrides(), "当前模式与 Skill 增量已保存到本机 workspace。", "local")
);
elements.projectConfigClear.addEventListener("click", () =>
  writeProjectOverrides({}, "已清除本机 workspace 覆盖；现在继承仓库配置与全局 Profile。", "local")
);
elements.projectConfigPublish.addEventListener("click", () => {
  if (!window.confirm(
    "将当前配置写入仓库配置？\n\n这会更新 .agent-control-plane/workflow.json，并清除当前 workspace 对它的个人覆盖；不会自动提交 Git。",
  )) return;
  writeProjectOverrides(currentProjectOverrides(), "当前配置已写入仓库配置文件。", "shared");
});
elements.projectConfigRestore.addEventListener("click", async () => {
  const revision = projectConfigState?.history?.[0]?.revision;
  if (!Number.isSafeInteger(revision) || projectConfigLoading) return;
  projectConfigLoading = true;
  renderProjectConfig();
  try {
    projectConfigState = await requestJson("/api/projects/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: projectConfigState.projectRoot,
        expectedRevision: projectConfigState.revision,
        expectedSharedConfigSha256: projectConfigState.sharedConfigSha256,
        revision,
      }),
    });
    applyProjectOverrides(projectConfigState.overrides);
    showToast(`已将项目配置恢复到 r${revision} 的内容。`);
    void loadRecentProjects();
  } catch (error) {
    showToast(`项目配置恢复失败：${error.message}`);
  } finally {
    projectConfigLoading = false;
    renderProjectConfig();
  }
});
elements.projectSkillAppendix.addEventListener("input", () => refresh());
elements.restoreSkillDefault.addEventListener("click", () => {
  if (!currentDefaultResolution || !currentDraftKey) return;
  skillDrafts.delete(currentDraftKey);
  elements.skillPreview.value = currentDefaultResolution.content;
  refresh({ preserveEditor: true });
  showToast("已恢复当前配置的默认 Skill；点击激活后写入。");
});
elements.interactiveAgentOverwrite.addEventListener("change", refresh);
elements.interactiveDefaultModel.addEventListener("change", () => {
  if (!interactiveAgentConfiguration) return;
  interactiveAgentConfiguration.globalSettings.defaultSubagentModel = elements.interactiveDefaultModel.value;
  markInteractiveConfigurationChanged();
});
elements.interactiveDefaultEffort.addEventListener("change", () => {
  if (!interactiveAgentConfiguration) return;
  interactiveAgentConfiguration.globalSettings.defaultSubagentReasoningEffort = elements.interactiveDefaultEffort.value;
  markInteractiveConfigurationChanged();
});
elements.interactiveMaxThreads.addEventListener("input", () => {
  if (!interactiveAgentConfiguration) return;
  const parsed = Number.parseInt(
    elements.interactiveMaxThreads.value,
    10,
  );
  interactiveAgentConfiguration.globalSettings.maxConcurrentThreadsPerSession = Number.isInteger(parsed)
    ? parsed
    : null;
  markInteractiveConfigurationChanged({ historyGroup: "global-max-threads" });
});
elements.interactiveAddRole.addEventListener("click", () => {
  if (!interactiveAgentConfiguration) return;
  const names = new Set(interactiveAgentConfiguration.agents.map((agent) => agent.name));
  let suffix = 1;
  while (names.has(`custom_agent_${suffix}`)) suffix += 1;
  const name = `custom_agent_${suffix}`;
  interactiveAgentConfiguration.agents.push({
    name,
    description: "Custom specialist. Update this description so Codex knows when to use the role.",
    model: null,
    reasoningEffort: null,
    sandboxMode: null,
    developerInstructions: "Define this role's scope, responsibilities, boundaries, and expected report format.",
  });
  interactiveOpenRoles.add(name);
  markInteractiveConfigurationChanged({ rebuild: true });
});
elements.interactiveUndo.addEventListener("click", () => travelInteractiveHistory("undo"));
elements.interactiveRedo.addEventListener("click", () => travelInteractiveHistory("redo"));
elements.interactiveRevert.addEventListener("click", () => {
  if (!interactiveBaselineConfiguration) return;
  interactiveAgentConfiguration = cloneJson(interactiveBaselineConfiguration);
  interactiveOpenRoles.clear();
  markInteractiveConfigurationChanged({ rebuild: true });
  showToast("已回退到最近一次激活或载入的角色配置。");
});
elements.interactiveResetRoles.addEventListener("click", () => {
  if (!interactiveAgentStatus.preset) return;
  const preset = cloneJson(interactiveAgentStatus.preset);
  const sources = cloneJson(interactiveAgentConfiguration?.sourceAgents ?? []);
  const sourceByName = new Map(sources.map((source) => [source.name, source]));
  preset.sourceAgents = sources;
  preset.configurationOrigin = sources.length > 0 ? "existing" : "recommended";
  preset.agents = preset.agents.map((agent) => {
    const source = sourceByName.get(agent.name);
    return source
      ? { ...agent, sourceFileName: source.fileName, sourceHash: source.hash }
      : agent;
  });
  interactiveAgentConfiguration = preset;
  interactiveOpenRoles.clear();
  markInteractiveConfigurationChanged({ rebuild: true });
  showToast("已恢复默认角色草稿；激活后写入 Codex。");
});
document.addEventListener("keydown", (event) => {
  if (
    selectedModeId !== "interactive" ||
    !elements.interactiveConfig.contains(event.target) ||
    !(event.ctrlKey || event.metaKey) ||
    event.altKey
  ) return;
  const key = event.key.toLowerCase();
  if (key === "z" && event.shiftKey && interactiveRedoStack.length > 0) {
    event.preventDefault();
    travelInteractiveHistory("redo");
  } else if (key === "z" && interactiveUndoStack.length > 0) {
    event.preventDefault();
    travelInteractiveHistory("undo");
  } else if (key === "y" && interactiveRedoStack.length > 0) {
    event.preventDefault();
    travelInteractiveHistory("redo");
  }
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
elements.navTaskCard.addEventListener("click", () => switchView("task-card"));
elements.navIntegrations.addEventListener("click", () => switchView("integrations"));
elements.navUsage.addEventListener("click", () => switchView("usage"));
elements.navHistory.addEventListener("click", () => switchView("history"));
elements.coordinationRefresh.addEventListener("click", () => {
  Promise.all([loadCoordination(), loadHistory({ selectEntry: true })])
    .then(refreshSelectedCoordinationDetail);
});
elements.coordinationDetailClose.addEventListener("click", () => {
  coordinationDetailRequest += 1;
  selectedCoordinationRun = null;
  elements.coordinationDetailPanel.hidden = true;
  refreshActivityRunSelections();
});
elements.integrationsRefresh.addEventListener("click", loadIntegrations);
elements.integrationsProjectBrowse.addEventListener("click", chooseProjectDirectory);
elements.workflowSourceDiagnose.addEventListener("click", diagnoseWorkflowSource);
elements.integrationsProjectRoot.addEventListener("change", loadIntegrations);
elements.integrationsProjectRoot.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadIntegrations();
});
elements.integrationList.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-integration-action]");
  if (!button || !elements.integrationList.contains(button)) return;
  runIntegrationAction(button);
});
elements.integrationPlanClose.addEventListener("click", () => {
  elements.integrationPlanPanel.hidden = true;
});
elements.integrationsHarness.addEventListener("change", () => {
  elements.integrationPlanPanel.hidden = true;
});
elements.integrationsScope.addEventListener("change", () => {
  elements.integrationPlanPanel.hidden = true;
});
elements.taskCardEditor.addEventListener("input", () => {
  recordTaskCardHistory(taskCardLastEditorValue, "json-editor");
  taskCardLastEditorValue = elements.taskCardEditor.value;
  try {
    taskCardDraft = JSON.parse(elements.taskCardEditor.value);
  } catch {
    taskCardDraft = null;
  }
  queueTaskCardValidation({ preserveHistoryGroup: true });
});
elements.taskCardEditorSwitch.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-card-editor-view]");
  if (!button || !elements.taskCardEditorSwitch.contains(button)) return;
  setTaskCardEditorView(button.dataset.taskCardEditorView);
});
elements.taskCardForm.addEventListener("input", (event) => {
  const control = event.target.closest("[data-task-path]");
  if (!control || !elements.taskCardForm.contains(control)) return;
  const path = JSON.parse(control.dataset.taskPath);
  let value = control.value;
  if (control.dataset.taskValueType === "boolean") value = control.checked;
  if (control.dataset.taskValueType === "json") {
    try {
      value = JSON.parse(value);
      control.setCustomValidity("");
    } catch (error) {
      control.setCustomValidity(`JSON 语法错误：${error.message}`);
      setTaskCardState("invalid", `extensions JSON 语法错误：${error.message}`);
      validatedTaskCard = null;
      elements.taskCardExport.disabled = true;
      elements.taskCardPreflightRun.disabled = true;
      return;
    }
  }
  const previous = taskCardSnapshot();
  commitTaskCardMutation(
    (task) => setTaskCardValue(task, path, value, {
      removeEmpty: control.dataset.taskRemoveEmpty === "true",
    }),
    `form:${taskCardPathLabel(path)}`,
  );
  if (control.dataset.taskValueType === "json" && taskCardSnapshot() === previous) {
    queueTaskCardValidation({ preserveHistoryGroup: true });
  }
});
elements.taskCardForm.addEventListener("change", (event) => {
  const control = event.target.closest("[data-task-rerender='true']");
  if (control) renderTaskCardForm();
});
elements.taskCardForm.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-action]");
  if (!button || !elements.taskCardForm.contains(button)) return;
  const path = JSON.parse(button.dataset.taskPath);
  if (button.dataset.taskAction === "add") {
    commitTaskCardMutation((task) => {
      let list = taskCardArrayAt(task, path);
      if (!Array.isArray(list)) {
        setTaskCardValue(task, path, []);
        list = taskCardArrayAt(task, path);
      }
      list.push(taskCardAddedValue(button.dataset.taskKind, list.length));
    }, `add:${taskCardPathLabel(path)}`, { render: true });
  }
  if (button.dataset.taskAction === "remove") {
    commitTaskCardMutation((task) => {
      const list = taskCardArrayAt(task, path);
      if (Array.isArray(list)) list.splice(Number(button.dataset.taskIndex), 1);
    }, `remove:${taskCardPathLabel(path)}`, { render: true });
  }
});
elements.taskCardViewSwitch.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-card-view]");
  if (!button || !elements.taskCardViewSwitch.contains(button)) return;
  taskCardProjectionView = button.dataset.taskCardView;
  for (const candidate of elements.taskCardViewSwitch.querySelectorAll("button")) {
    const active = candidate === button;
    candidate.classList.toggle("active", active);
    candidate.setAttribute("aria-pressed", String(active));
  }
  renderTaskCardProjection();
});
elements.taskCardExport.addEventListener("click", exportTaskCard);
elements.taskCardUndo.addEventListener("click", () => restoreTaskCardHistory(taskCardUndoStack, taskCardRedoStack));
elements.taskCardRedo.addEventListener("click", () => restoreTaskCardHistory(taskCardRedoStack, taskCardUndoStack));
elements.taskCardRevert.addEventListener("click", () => {
  if (!taskCardBaseline || taskCardSnapshot() === taskCardBaseline) return;
  recordTaskCardHistory(taskCardSnapshot(), "revert");
  replaceTaskCardSnapshot(taskCardBaseline);
  showToast("已回退到本次载入时的 Task Card。");
});
elements.taskCardImport.addEventListener("click", () => elements.taskCardImportInput.click());
elements.taskCardImportInput.addEventListener("change", async () => {
  const file = elements.taskCardImportInput.files?.[0];
  elements.taskCardImportInput.value = "";
  if (!file) return;
  if (file.size > 1024 * 1024) {
    showToast("导入失败：Task Card 不能超过 1 MiB。");
    return;
  }
  try {
    const imported = await file.text();
    recordTaskCardHistory(taskCardSnapshot(), "import");
    elements.taskCardEditor.value = imported;
    taskCardLastEditorValue = imported;
    taskCardSetBaselineOnValidation = true;
    try {
      taskCardDraft = JSON.parse(imported);
      renderTaskCardForm();
    } catch {
      taskCardDraft = null;
      setTaskCardEditorView("json");
    }
    queueTaskCardValidation({ preserveHistoryGroup: true });
    showToast(`已载入 ${file.name}，正在校验。`);
  } catch (error) {
    showToast(`导入失败：${error.message}`);
  }
});
elements.taskCardReset.addEventListener("click", () => {
  if (!taskCardTemplate) return;
  if (!window.confirm("恢复标准 Task Card 模板？当前浏览器草稿会被替换。")) return;
  recordTaskCardHistory(taskCardSnapshot(), "reset-template");
  const template = JSON.stringify(taskCardTemplate, null, 2);
  elements.taskCardEditor.value = template;
  taskCardLastEditorValue = template;
  taskCardDraft = taskCardClone(taskCardTemplate);
  taskCardSetBaselineOnValidation = true;
  localStorage.removeItem(TASK_CARD_DRAFT_KEY);
  renderTaskCardForm();
  validateTaskCardDraft();
  showToast("已恢复标准 Task Card 模板。");
});
elements.taskCardWorkflowMode.addEventListener("change", () => {
  synchronizeTaskCardStrategy();
  savePreflightConfiguration();
});
elements.taskCardAdapter.addEventListener("change", () => {
  savePreflightConfiguration();
  updateTaskCardConnectivityAvailability();
});
elements.taskCardExecutionEnvironment.addEventListener("change", savePreflightConfiguration);
elements.taskCardProxyMode.addEventListener("change", savePreflightConfiguration);
elements.taskCardEnvironmentIsolation.addEventListener("change", savePreflightConfiguration);
elements.taskCardNetworkDiagnostics.addEventListener("change", savePreflightConfiguration);
elements.taskCardWorktree.addEventListener("input", updateTaskCardConnectivityAvailability);
elements.taskCardWorktree.addEventListener("change", savePreflightConfiguration);
elements.taskCardStrategy.addEventListener("change", savePreflightConfiguration);
elements.taskCardPreflightRun.addEventListener("click", runTaskCardPreflight);
elements.taskCardConnectivityRun.addEventListener("click", runTaskCardConnectivityProbe);
elements.historyRefresh.addEventListener("click", () => {
  Promise.all([
    loadCoordination(),
    loadHistory({ selectEntry: activeView === "history" }),
  ]).then(refreshSelectedCoordinationDetail);
});
elements.historyScopeFilter.addEventListener("change", () => {
  const entries = historyEntriesInScope();
  selectedHistoryId = entries.find((entry) => entry.isActive)?.historyId ?? entries[0]?.historyId ?? null;
  renderHistoryList();
  refreshActivityRunSelections();
  if (selectedHistoryId && activeView === "history") selectHistoryEntry(selectedHistoryId);
});
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
  if (!document.hidden && activeView === "history") {
    Promise.all([loadCoordination(), loadHistory()]).then(refreshSelectedCoordinationDetail);
  }
});

initializeAgentSelectors();
initializeOvernightControls();
initializeBalancedControls();
const storedProjectRoot = localStorage.getItem(INTEGRATION_PROJECT_KEY);
if (storedProjectRoot) elements.projectConfigRoot.value = storedProjectRoot;
renderModeCards();
renderProjectConfig();
refresh();
loadRecentProjects();
loadServerStatus();
serverStatusReady.then(() => {
  if (elements.projectConfigRoot.value.trim()) loadProjectConfig();
});
loadInteractiveAgentStatus();
loadHistory();
loadBalancedRuns();
loadOvernightRuns();
loadTaskCard();
window.setInterval(() => {
  if (!document.hidden && activeView === "usage") loadRuntimeUsage();
  if (!document.hidden && activeView === "history") {
    Promise.all([loadCoordination(), loadHistory()]).then(refreshSelectedCoordinationDetail);
  }
  if (!document.hidden && activeView === "configuration" && selectedModeId === "balanced") {
    loadBalancedRuns();
  }
  if (!document.hidden && activeView === "configuration" && selectedModeId === "overnight") {
    loadOvernightRuns();
  }
}, 5000);
