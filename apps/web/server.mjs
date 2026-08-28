import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BUILTIN_MODE_CATALOG,
  EXAMPLE_AGENTS,
  resolveEffectiveSkill,
} from "../../packages/contracts/dist/index.js";
import { createCcSwitchUsageSource } from "./cc-switch-usage-source.mjs";
import { createClaudeUsageSource } from "./claude-usage-source.mjs";
import { createPreferredUsageSource } from "./preferred-usage-source.mjs";
import { createSkillStore, SkillStoreError } from "./skill-store.mjs";
import { createUsageMonitor } from "./usage-monitor.mjs";

const PUBLIC_ROOT = fileURLToPath(new URL("./public/", import.meta.url));
const CONTRACTS_ROOT = fileURLToPath(
  new URL("../../packages/contracts/dist/", import.meta.url),
);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function securityHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function sendJson(response, status, value, headOnly = false) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "content-length": Buffer.byteLength(body),
  });
  response.end(headOnly ? undefined : body);
}

function trustedMutationOrigin(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) return false;
  return origin === `http://${host}`;
}

async function readJsonBody(request) {
  if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new SkillStoreError("request.content_type", "Content-Type must be application/json.", 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) {
      throw new SkillStoreError("request.too_large", "Request body exceeds 64 KiB.", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SkillStoreError("request.invalid_json", "Request body is not valid JSON.");
  }
}

function resolveWithin(root, relativePath) {
  const normalizedRoot = resolve(root);
  const candidate = resolve(normalizedRoot, relativePath);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${sep}`)) {
    return null;
  }
  return candidate;
}

async function serveFile(request, response, root, relativePath) {
  const filePath = resolveWithin(root, relativePath);
  if (!filePath) {
    response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
    response.end("Invalid path");
    return;
  }

  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Not a file");
    const contentType = MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, {
      ...securityHeaders(contentType),
      "content-length": metadata.size,
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
    response.end("Not found");
  }
}

export function createAppServer(options = {}) {
  const store = options.store ?? createSkillStore({ skillsDir: options.skillsDir });
  let usageMonitor = options.usageMonitor;
  if (!usageMonitor) {
    let usageSources = options.usageSources;
    if (!usageSources) {
      const downstreamSources = [];
      if (process.env.AGENT_WORKFLOW_CLAUDE_USAGE !== "off") {
        downstreamSources.push(
          createClaudeUsageSource({ projectsDir: options.claudeProjectsDir }),
        );
      }
      if (process.env.AGENT_WORKFLOW_CC_SWITCH_USAGE !== "off") {
        downstreamSources.push(
          createCcSwitchUsageSource({ databasePath: options.ccSwitchDatabasePath }),
        );
      }
      usageSources = [
        createPreferredUsageSource({
          id: "claude-downstream",
          lane: "downstream",
          sources: downstreamSources,
        }),
      ];
    }
    usageMonitor = createUsageMonitor({ sessionsDir: options.sessionsDir, sources: usageSources });
  }
  return createServer(async (request, response) => {
    let requestUrl;
    let pathname;
    try {
      requestUrl = new URL(request.url ?? "/", "http://local");
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
      response.end("Invalid URL");
      return;
    }

    try {
      if (pathname === "/api/health" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          { status: "ok", product: "agent-workflow-switch" },
          request.method === "HEAD",
        );
        return;
      }

      if (pathname === "/api/status" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await store.status(), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/usage" && (request.method === "GET" || request.method === "HEAD")) {
        const range = requestUrl.searchParams.get("range") ?? "24h";
        sendJson(response, 200, await usageMonitor.collect(range), request.method === "HEAD");
        return;
      }

      if (pathname === "/api/history" && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(response, 200, await store.history(), request.method === "HEAD");
        return;
      }

      const historyDetail = pathname.match(/^\/api\/history\/([^/]+)$/);
      if (historyDetail && (request.method === "GET" || request.method === "HEAD")) {
        sendJson(
          response,
          200,
          await store.historyDetail(historyDetail[1]),
          request.method === "HEAD",
        );
        return;
      }

      const historyRestore = pathname.match(/^\/api\/history\/([^/]+)\/restore$/);
      if (historyRestore && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        sendJson(response, 200, await store.restoreHistory(historyRestore[1]));
        return;
      }

      if (pathname === "/api/activate" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        const resolution = resolveEffectiveSkill({
          profile: body?.profile,
          agents: EXAMPLE_AGENTS,
          catalog: BUILTIN_MODE_CATALOG,
        });
        if (!resolution.ok) {
          sendJson(response, 422, { error: "profile.invalid", issues: resolution.issues });
          return;
        }
        sendJson(response, 200, await store.activate(resolution.value));
        return;
      }

      if (pathname === "/api/rollback" && request.method === "POST") {
        if (!trustedMutationOrigin(request)) {
          sendJson(response, 403, { error: "request.untrusted_origin" });
          return;
        }
        const body = await readJsonBody(request);
        sendJson(response, 200, await store.rollback(body?.backupId));
        return;
      }
    } catch (error) {
      if (error instanceof SkillStoreError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      if (typeof error?.status === "number" && typeof error?.code === "string") {
        sendJson(response, error.status, { error: error.code, message: error.message });
        return;
      }
      sendJson(response, 500, { error: "server.internal" });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        ...securityHeaders("text/plain; charset=utf-8"),
        allow: "GET, HEAD",
      });
      response.end("Method not allowed");
      return;
    }

    if (pathname.startsWith("/contracts/")) {
      await serveFile(request, response, CONTRACTS_ROOT, pathname.slice("/contracts/".length));
      return;
    }

    const publicPath = pathname === "/" ? "index.html" : pathname.slice(1);
    await serveFile(request, response, PUBLIC_ROOT, publicPath);
  });
}

function isEntryPoint() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isEntryPoint()) {
  const host = process.env.AGENT_WORKFLOW_HOST ?? "127.0.0.1";
  const parsedPort = Number.parseInt(process.env.AGENT_WORKFLOW_PORT ?? "4173", 10);
  const port = Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : 4173;
  if (
    process.env.AGENT_WORKFLOW_SKILLS_DIR &&
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1"
  ) {
    throw new Error("Filesystem activation may only listen on a loopback host.");
  }
  const server = createAppServer({ skillsDir: process.env.AGENT_WORKFLOW_SKILLS_DIR });
  server.listen(port, host, () => {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`Agent Workflow Switch: http://${host}:${activePort}\n`);
  });
}
