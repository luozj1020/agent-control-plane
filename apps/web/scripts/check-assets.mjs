import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = [
  new URL("../server.mjs", import.meta.url),
  new URL("../skill-store.mjs", import.meta.url),
  new URL("../usage-monitor.mjs", import.meta.url),
  new URL("../cc-switch-usage-source.mjs", import.meta.url),
  new URL("../claude-usage-source.mjs", import.meta.url),
  new URL("../preferred-usage-source.mjs", import.meta.url),
  new URL("../skill-diff.mjs", import.meta.url),
  new URL("../public/app.js", import.meta.url),
  new URL("../public/mode-switch-coordinator.js", import.meta.url),
];
const required = [
  ...scripts,
  new URL("../public/index.html", import.meta.url),
  new URL("../public/styles.css", import.meta.url),
];

await Promise.all(required.map((file) => access(file)));
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(script)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`Validated ${required.length} web assets.\n`);
