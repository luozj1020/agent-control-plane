import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const required = [
  new URL("../server.mjs", import.meta.url),
  new URL("../public/index.html", import.meta.url),
  new URL("../public/app.js", import.meta.url),
  new URL("../public/styles.css", import.meta.url),
];

await Promise.all(required.map((file) => access(file)));
for (const script of [required[0], required[2]]) {
  const result = spawnSync(process.execPath, ["--check", fileURLToPath(script)], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(`Validated ${required.length} web assets.\n`);
