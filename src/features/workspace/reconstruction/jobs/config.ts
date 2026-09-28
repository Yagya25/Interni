/**
 * How this machine reaches the reconstruction worker, read from the
 * environment. Everything is derived from DATUM_RECONSTRUCTION_RUNS, the
 * folder the worker writes to as Windows sees it:
 *
 *   \\wsl.localhost\<distro>\<linux path>   (or \\wsl$\<distro>\...)
 *
 * The worker project is the runs folder's parent, as in the worker's own
 * default (~/datum-recon/runs). Each part can be overridden. Server-only:
 * nothing here is ever sent to the browser.
 */

export type LauncherConfig =
  | { kind: "wsl"; distro: string; linuxRunsDir: string; workerDir: string }
  /** A stand-in worker with the same CLI, for automated tests only. */
  | { kind: "command"; command: string; args: string[] };

export interface JobConfig {
  runsDir: string;
  /** Null when the worker cannot be reached from here: uploads answer "worker-unavailable". */
  launcher: LauncherConfig | null;
  maxBytes: number;
  maxQueued: number;
  timeoutMs: number;
  retainFailedDays: number;
  /** Days to keep the preserved original of a finished run; null keeps it indefinitely. */
  retainOriginalsDays: number | null;
}

export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const UNC = /^(?:\\\\|\/\/)wsl(?:\.localhost|\$)[\\/]([^\\/]+)((?:[\\/][^\\/]+)+)[\\/]?$/i;

export function parseWslPath(path: string): { distro: string; linuxPath: string } | null {
  const match = UNC.exec(path.trim());
  if (!match) return null;
  return { distro: match[1], linuxPath: match[2].replace(/\\/g, "/") };
}

function number(value: string | undefined, fallback: number, min: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= min ? n : fallback;
}

export function jobConfig(env: Readonly<Record<string, string | undefined>> = process.env): JobConfig | null {
  const runsDir = env.DATUM_RECONSTRUCTION_RUNS?.trim();
  if (!runsDir) return null;

  let launcher: LauncherConfig | null = null;
  const command = env.DATUM_RECONSTRUCTION_WORKER_COMMAND?.trim();
  const testWorkerAllowed = env.NODE_ENV !== "production" || env.DATUM_RECONSTRUCTION_ALLOW_TEST_WORKER === "1";
  if (command && testWorkerAllowed) {
    // A JSON array keeps paths with spaces intact; a plain string is split on whitespace.
    const parts: unknown = command.startsWith("[") ? JSON.parse(command) : command.split(/\s+/);
    const [head, ...args] = Array.isArray(parts) ? parts.map(String) : [];
    if (head) launcher = { kind: "command", command: head, args };
  } else {
    const parsed = parseWslPath(runsDir);
    const distro = env.DATUM_RECONSTRUCTION_WSL_DISTRO?.trim() || parsed?.distro;
    const linuxRunsDir = env.DATUM_RECONSTRUCTION_LINUX_RUNS?.trim() || parsed?.linuxPath;
    if (distro && linuxRunsDir) {
      const workerDir = env.DATUM_RECONSTRUCTION_WORKER_DIR?.trim() || linuxRunsDir.replace(/\/[^/]+\/?$/, "") || "/";
      launcher = { kind: "wsl", distro, linuxRunsDir: linuxRunsDir.replace(/\/$/, ""), workerDir };
    }
  }

  const originals = env.DATUM_RECONSTRUCTION_RETAIN_ORIGINALS_DAYS?.trim();
  return {
    runsDir,
    launcher,
    maxBytes: MAX_UPLOAD_BYTES,
    maxQueued: 5,
    timeoutMs: number(env.DATUM_RECONSTRUCTION_TIMEOUT_MS, 5 * 60 * 1000, 1000),
    retainFailedDays: number(env.DATUM_RECONSTRUCTION_RETAIN_FAILED_DAYS, 7, 0),
    retainOriginalsDays: originals ? number(originals, 0, 0) : null,
  };
}
