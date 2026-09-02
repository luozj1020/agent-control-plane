import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { platform as hostPlatform, release as hostRelease } from "node:os";
import { isAbsolute } from "node:path";

const MAX_PATH_BYTES = 16 * 1024;
const PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const POWERSHELL_SCRIPT = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Select project directory'",
  "$dialog.ShowNewFolderButton = $false",
  "if ($env:ACP_DIRECTORY_PICKER_INITIAL) { $dialog.SelectedPath = $env:ACP_DIRECTORY_PICKER_INITIAL }",
  "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
  "  [Console]::Out.Write($dialog.SelectedPath)",
  "  exit 0",
  "}",
  "exit 2",
].join("; ");

export class DirectoryPickerError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.name = "DirectoryPickerError";
    this.code = code;
    this.status = status;
  }
}

function defaultExecute(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: "utf8",
      maxBuffer: MAX_PATH_BYTES,
      timeout: PICKER_TIMEOUT_MS,
      windowsHide: false,
      ...options,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function candidates(platform, wsl, environment, initialDirectory) {
  const powershell = (executable) => ({
    executable,
    args: ["-NoLogo", "-NoProfile", "-STA", "-Command", POWERSHELL_SCRIPT],
    environment: {
      ...environment,
      ...(initialDirectory && !wsl
        ? { ACP_DIRECTORY_PICKER_INITIAL: initialDirectory }
        : {}),
    },
    provider: wsl ? "windows-folder-browser-wsl" : "windows-folder-browser",
    windowsPath: wsl,
  });
  if (platform === "win32") return [powershell("powershell.exe"), powershell("powershell")];
  if (platform === "darwin") {
    return [{
      executable: "osascript",
      args: ["-e", "POSIX path of (choose folder with prompt \"Select project directory\")"],
      environment,
      provider: "macos-finder",
      windowsPath: false,
    }];
  }
  const linux = [
    {
      executable: "zenity",
      args: ["--file-selection", "--directory", "--title=Select project directory"],
      environment,
      provider: "linux-zenity",
      windowsPath: false,
    },
    {
      executable: "kdialog",
      args: ["--getexistingdirectory", initialDirectory || ".", "--title", "Select project directory"],
      environment,
      provider: "linux-kdialog",
      windowsPath: false,
    },
  ];
  return wsl ? [powershell("powershell.exe"), ...linux] : linux;
}

function selectedPath(stdout) {
  if (typeof stdout !== "string") return "";
  const value = stdout.replace(/[\r\n]+$/, "");
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) {
    throw new DirectoryPickerError("picker.invalid_result", "The selected directory path is invalid.", 502);
  }
  return value;
}

function cancelled(error) {
  return error?.code === 1 || error?.code === 2;
}

export function createDirectoryPicker(options = {}) {
  const platform = options.platform ?? hostPlatform();
  const release = options.release ?? hostRelease();
  const environment = options.environment ?? process.env;
  const wsl = options.wsl ?? (
    platform === "linux" &&
    (Boolean(environment.WSL_DISTRO_NAME) || /microsoft/i.test(release))
  );
  const execute = options.execute ?? defaultExecute;
  const canonicalize = options.realpath ?? realpath;
  const inspect = options.stat ?? stat;

  async function verifiedInitialDirectory(value) {
    if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return null;
    if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES || !isAbsolute(value)) return null;
    try {
      const metadata = await inspect(value);
      return metadata.isDirectory() ? await canonicalize(value) : null;
    } catch {
      return null;
    }
  }

  async function choose(input = {}) {
    const initialDirectory = await verifiedInitialDirectory(input.initialDirectory);
    let missingProviders = 0;
    for (const candidate of candidates(platform, wsl, environment, initialDirectory)) {
      let result;
      try {
        result = await execute(candidate.executable, candidate.args, {
          env: candidate.environment,
        });
      } catch (error) {
        if (error?.code === "ENOENT") {
          missingProviders += 1;
          continue;
        }
        if (cancelled(error)) return { selected: false, reason: "cancelled" };
        if (error?.killed || error?.code === "ETIMEDOUT") {
          throw new DirectoryPickerError("picker.timeout", "Directory selection timed out.", 504);
        }
        throw new DirectoryPickerError("picker.launch_failed", "The system directory picker failed to open.", 502);
      }
      let value = selectedPath(result.stdout);
      if (!value) return { selected: false, reason: "cancelled" };
      if (candidate.windowsPath) {
        try {
          value = selectedPath((await execute("wslpath", ["-u", value], { env: environment })).stdout);
        } catch {
          throw new DirectoryPickerError(
            "picker.path_conversion_failed",
            "The selected Windows directory could not be mapped into WSL.",
            502,
          );
        }
      }
      if (!isAbsolute(value)) {
        throw new DirectoryPickerError("picker.invalid_result", "The picker returned a non-absolute path.", 502);
      }
      try {
        const canonical = await canonicalize(value);
        const metadata = await inspect(canonical);
        if (!metadata.isDirectory()) throw new Error("not-directory");
        return { selected: true, projectRoot: canonical, provider: candidate.provider };
      } catch {
        throw new DirectoryPickerError(
          "picker.directory_unavailable",
          "The selected directory is not accessible to the control plane.",
          422,
        );
      }
    }
    if (missingProviders > 0) {
      throw new DirectoryPickerError(
        "picker.unavailable",
        "No supported system directory picker is available on this host.",
        501,
      );
    }
    throw new DirectoryPickerError("picker.unavailable", "Directory selection is unavailable.", 501);
  }

  return Object.freeze({ choose });
}
