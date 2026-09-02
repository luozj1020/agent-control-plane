import assert from "node:assert/strict";
import test from "node:test";

import { createDirectoryPicker, DirectoryPickerError } from "../directory-picker.mjs";

const directoryStat = { isDirectory: () => true };

test("selects and canonicalizes a directory with a Linux desktop picker", async () => {
  const calls = [];
  const picker = createDirectoryPicker({
    platform: "linux",
    release: "linux",
    environment: {},
    execute: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "/workspace/project\n", stderr: "" };
    },
    realpath: async (value) => value,
    stat: async () => directoryStat,
  });
  assert.deepEqual(await picker.choose({ initialDirectory: "/workspace" }), {
    selected: true,
    projectRoot: "/workspace/project",
    provider: "linux-zenity",
  });
  assert.equal(calls[0].file, "zenity");
  assert.ok(calls[0].args.includes("--directory"));
});

test("maps a Windows folder selection into the WSL filesystem", async () => {
  const calls = [];
  const picker = createDirectoryPicker({
    platform: "linux",
    wsl: true,
    environment: { WSL_DISTRO_NAME: "Ubuntu" },
    execute: async (file, args) => {
      calls.push({ file, args });
      return file === "wslpath"
        ? { stdout: "/mnt/c/Users/Test/project\n", stderr: "" }
        : { stdout: "C:\\Users\\Test\\project", stderr: "" };
    },
    realpath: async (value) => value,
    stat: async () => directoryStat,
  });
  assert.deepEqual(await picker.choose(), {
    selected: true,
    projectRoot: "/mnt/c/Users/Test/project",
    provider: "windows-folder-browser-wsl",
  });
  assert.deepEqual(calls.map((entry) => entry.file), ["powershell.exe", "wslpath"]);
});

test("cancelling a system dialog leaves project selection unchanged", async () => {
  const picker = createDirectoryPicker({
    platform: "darwin",
    execute: async () => { throw Object.assign(new Error("cancelled"), { code: 1 }); },
  });
  assert.deepEqual(await picker.choose(), { selected: false, reason: "cancelled" });
});

test("fails explicitly when no supported desktop picker is installed", async () => {
  const picker = createDirectoryPicker({
    platform: "linux",
    release: "linux",
    environment: {},
    execute: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  await assert.rejects(
    picker.choose(),
    (error) => error instanceof DirectoryPickerError && error.code === "picker.unavailable" && error.status === 501,
  );
});
