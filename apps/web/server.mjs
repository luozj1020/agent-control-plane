import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
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

export function createAppServer() {
  return createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, {
        ...securityHeaders("text/plain; charset=utf-8"),
        allow: "GET, HEAD",
      });
      response.end("Method not allowed");
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? "/", "http://local").pathname);
    } catch {
      response.writeHead(400, securityHeaders("text/plain; charset=utf-8"));
      response.end("Invalid URL");
      return;
    }

    if (pathname === "/api/health") {
      const body = JSON.stringify({ status: "ok", product: "agent-workflow-switch" });
      response.writeHead(200, {
        ...securityHeaders("application/json; charset=utf-8"),
        "content-length": Buffer.byteLength(body),
      });
      response.end(request.method === "HEAD" ? undefined : body);
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
  const server = createAppServer();
  server.listen(port, host, () => {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    process.stdout.write(`Agent Workflow Switch: http://${host}:${activePort}\n`);
  });
}
