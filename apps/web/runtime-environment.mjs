const PROXY_VARIABLES = Object.freeze([
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]);

const SAFE_ENVIRONMENT_NAMES = new Set([
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP",
  "LANG", "LANGUAGE", "LC_ALL", "TZ", "COLORTERM",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR",
  "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV",
  "CODEX_SANDBOX_NETWORK_DISABLED",
]);

const EXECUTION_ENVIRONMENTS = new Set(["auto", "host", "sandbox"]);
const PROXY_MODES = new Set(["direct", "inherit"]);
const ISOLATION_MODES = new Set(["inherit", "provider-scoped"]);
const NETWORK_DIAGNOSTICS = new Set(["off", "metadata"]);

export const DEFAULT_RUNTIME_ENVIRONMENT = Object.freeze({
  executionEnvironment: "auto",
  proxyMode: "direct",
  isolationMode: "provider-scoped",
  networkDiagnostics: "metadata",
});

export class RuntimeEnvironmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RuntimeEnvironmentError";
    this.code = code;
    this.status = 400;
    this.details = details;
  }
}

function booleanMarker(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
}

function allowedProviderVariable(name, prefixes) {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

function enumValue(value, allowed, fallback, path) {
  const candidate = value ?? fallback;
  if (!allowed.has(candidate)) {
    throw new RuntimeEnvironmentError(
      "runtime.environment_invalid",
      `${path} must be one of: ${[...allowed].join(", ")}.`,
      { path },
    );
  }
  return candidate;
}

export function normalizeRuntimeEnvironment(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeEnvironmentError(
      "runtime.environment_invalid",
      "runtimeEnvironment must be an object.",
      { path: "runtimeEnvironment" },
    );
  }
  const known = new Set([
    "executionEnvironment", "proxyMode", "isolationMode", "networkDiagnostics",
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new RuntimeEnvironmentError(
        "runtime.environment_invalid",
        `Unknown runtimeEnvironment field '${key}'.`,
        { path: `runtimeEnvironment.${key}` },
      );
    }
  }
  return Object.freeze({
    executionEnvironment: enumValue(
      value.executionEnvironment,
      EXECUTION_ENVIRONMENTS,
      DEFAULT_RUNTIME_ENVIRONMENT.executionEnvironment,
      "runtimeEnvironment.executionEnvironment",
    ),
    proxyMode: enumValue(
      value.proxyMode,
      PROXY_MODES,
      DEFAULT_RUNTIME_ENVIRONMENT.proxyMode,
      "runtimeEnvironment.proxyMode",
    ),
    isolationMode: enumValue(
      value.isolationMode,
      ISOLATION_MODES,
      DEFAULT_RUNTIME_ENVIRONMENT.isolationMode,
      "runtimeEnvironment.isolationMode",
    ),
    networkDiagnostics: enumValue(
      value.networkDiagnostics,
      NETWORK_DIAGNOSTICS,
      DEFAULT_RUNTIME_ENVIRONMENT.networkDiagnostics,
      "runtimeEnvironment.networkDiagnostics",
    ),
  });
}

export function resolveRuntimeEnvironment(value, options = {}) {
  const profile = normalizeRuntimeEnvironment(value);
  const baseEnvironment = options.environment ?? process.env;
  const providerPrefixes = options.providerEnvironmentPrefixes ?? [];
  const detectedRestricted = booleanMarker(baseEnvironment.CODEX_SANDBOX_NETWORK_DISABLED);
  const resolvedExecutionEnvironment = profile.executionEnvironment === "auto"
    ? (detectedRestricted ? "sandbox" : "host")
    : profile.executionEnvironment;
  const networkRestricted = resolvedExecutionEnvironment === "sandbox" || detectedRestricted;
  const requiresNetwork = options.requiresNetwork !== false;
  const hostHandoffRequired = requiresNetwork && networkRestricted;

  const childEnvironment = {};
  for (const [name, entry] of Object.entries(baseEnvironment)) {
    if (entry === undefined) continue;
    if (
      profile.isolationMode === "inherit" ||
      SAFE_ENVIRONMENT_NAMES.has(name) ||
      PROXY_VARIABLES.includes(name) ||
      allowedProviderVariable(name, providerPrefixes)
    ) {
      childEnvironment[name] = entry;
    }
  }
  for (const [name, entry] of Object.entries(options.adapterEnvironment ?? {})) {
    if (entry !== undefined) childEnvironment[name] = String(entry);
  }
  if (profile.proxyMode === "direct") {
    for (const name of PROXY_VARIABLES) delete childEnvironment[name];
  }

  const inheritedProxyVariables = PROXY_VARIABLES.filter((name) => Boolean(baseEnvironment[name]));
  const effectiveProxyVariables = PROXY_VARIABLES.filter((name) => Boolean(childEnvironment[name]));
  const authConfigured = Object.keys(childEnvironment).some((name) =>
    allowedProviderVariable(name, providerPrefixes) &&
    /(AUTH|API_KEY|TOKEN|CREDENTIAL)/i.test(name) &&
    Boolean(childEnvironment[name]),
  );

  return Object.freeze({
    profile,
    environment: Object.freeze(childEnvironment),
    evidence: Object.freeze({
      executionEnvironmentRequested: profile.executionEnvironment,
      executionEnvironmentResolved: resolvedExecutionEnvironment,
      sandboxMarkerDetected: detectedRestricted,
      networkRestricted,
      requiresNetwork,
      needsHostExecution: hostHandoffRequired,
      hostHandoffRequired,
      proxyMode: profile.proxyMode,
      inheritedProxyVariables:
        profile.networkDiagnostics === "metadata" ? inheritedProxyVariables : [],
      effectiveProxyVariables:
        profile.networkDiagnostics === "metadata" ? effectiveProxyVariables : [],
      isolationMode: profile.isolationMode,
      networkDiagnostics: profile.networkDiagnostics,
      authConfigured,
      filesystemIsolation: "not-enforced-by-process-adapter",
    }),
  });
}

export function classifyDownstreamFailure(input = {}) {
  if (input.environment?.hostHandoffRequired) return "sandbox-network-host-handoff";
  if (input.spawnErrorCode === "ENOENT") return "adapter-unavailable";
  if (input.timedOut) return "probe-timeout";
  const diagnostic = String(input.diagnosticText ?? "").toLowerCase();
  if (/workspace.{0,40}(trust|trusted)|not.{0,20}trusted.{0,20}workspace/.test(diagnostic)) {
    return "workspace-not-trusted";
  }
  if (/proxyconnect|proxy error|proxy authentication|tunnel connection failed/.test(diagnostic)) {
    return "proxy-failure";
  }
  if (/could not resolve|name resolution|enotfound|eai_again|dns/.test(diagnostic)) {
    return "dns-failure";
  }
  if (/certificate|self.signed|unable to verify|tls|ssl/.test(diagnostic)) return "tls-failure";
  if (/unauthori[sz]ed|forbidden|authentication|invalid api key|login required|not logged in/.test(diagnostic)) {
    return "authentication-failure";
  }
  if (/rate.?limit|quota|billing|credit|insufficient/.test(diagnostic)) return "provider-limit";
  if (
    /failedtoopensocket|unable to connect|network is unreachable|socket|connection (refused|reset|aborted)|timed out/.test(diagnostic)
  ) {
    return "transport-failure";
  }
  if (input.error) return "adapter-error";
  if (input.exitCode === 0 && (input.activity?.stdoutBytes ?? 0) === 0) return "no-response";
  if (input.signal) return "terminated";
  if (input.exitCode !== null && input.exitCode !== undefined && input.exitCode !== 0) {
    return "cli-error";
  }
  return null;
}

export function runtimeEnvironmentOptions() {
  return {
    executionEnvironments: [
      { id: "auto", displayName: "自动检测" },
      { id: "host", displayName: "宿主机进程" },
      { id: "sandbox", displayName: "受限沙箱" },
    ],
    proxyModes: [
      { id: "direct", displayName: "直连（清除代理变量）" },
      { id: "inherit", displayName: "继承系统代理" },
    ],
    isolationModes: [
      { id: "provider-scoped", displayName: "供应商范围环境变量" },
      { id: "inherit", displayName: "继承全部环境变量" },
    ],
    networkDiagnostics: [
      { id: "metadata", displayName: "元数据诊断" },
      { id: "off", displayName: "关闭" },
    ],
    defaults: DEFAULT_RUNTIME_ENVIRONMENT,
  };
}
