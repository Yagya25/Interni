import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { LauncherConfig } from "./config";
import { jobDir, originalName } from "./store";

export interface LaunchSpec {
  runsDir: string;
  runId: string;
  ext: string;
}

export interface RunningWorker {
  /** Settles when the process has exited, or could not be started. */
  done: Promise<{ exitCode: number | null; spawnFailed: boolean }>;
  kill(): void;
}

export interface Launcher {
  start(spec: LaunchSpec): RunningWorker;
}

/**
 * The worker's command line, as an argument list: nothing goes through a
 * shell, and every part is either configuration or made by the server.
 */
export function workerArgs(config: LauncherConfig, spec: LaunchSpec): { command: string; args: string[] } {
  const input = originalName(spec.ext);
  if (config.kind === "wsl") {
    const runs = config.linuxRunsDir;
    return {
      command: "wsl.exe",
      args: [
        "-d", config.distro, "--cd", config.workerDir, "--exec",
        ".venv/bin/python", "-m", "reconstruction.worker",
        "--input", `${runs}/.jobs/${spec.runId}/${input}`,
        "--output", `${runs}/${spec.runId}/reconstruction.json`,
      ],
    };
  }
  return {
    command: config.command,
    args: [
      ...config.args,
      "--input", join(/*turbopackIgnore: true*/ jobDir(spec.runsDir, spec.runId), input),
      "--output", join(/*turbopackIgnore: true*/ spec.runsDir, spec.runId, "reconstruction.json"),
    ],
  };
}

/** Starts the existing worker (in WSL, or a configured stand-in) and keeps its console output beside the job. */
export function processLauncher(config: LauncherConfig): Launcher {
  return {
    start(spec) {
      const { command, args } = workerArgs(config, spec);
      const log = createWriteStream(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ jobDir(spec.runsDir, spec.runId), "process.log"));
      log.on("error", () => {});
      log.write(`$ ${command} ${args.join(" ")}\n`);
      // The worker is outside the project; nothing here should be traced into the build.
      const child = spawn(/*turbopackIgnore: true*/ command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout?.pipe(log, { end: false });
      child.stderr?.pipe(log, { end: false });
      const done = new Promise<{ exitCode: number | null; spawnFailed: boolean }>((settle) => {
        let started = false;
        child.once("spawn", () => (started = true));
        child.once("error", (error) => {
          log.write(`\n[launcher] ${error.message}\n`);
          if (!started) {
            log.end();
            settle({ exitCode: null, spawnFailed: true });
          }
        });
        child.once("close", (code) => {
          log.end(`\n[launcher] exit ${code}\n`);
          settle({ exitCode: code, spawnFailed: false });
        });
      });
      return { done, kill: () => void child.kill() };
    },
  };
}
