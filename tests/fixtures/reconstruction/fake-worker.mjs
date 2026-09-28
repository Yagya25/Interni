#!/usr/bin/env node
/**
 * A stand-in for `python -m reconstruction.worker`, for automated tests only.
 * Same command line (--input, --output) and the same contract: it refuses an
 * output folder that already holds anything (exit 3), writes the intermediate
 * atomically (.part, then rename), and stamps the source the way the real
 * intake does (photographId = first 16 hex of the input's SHA-256). The
 * observations themselves are a real worker run committed with the compiler
 * tests, so the workspace compiles a real room.
 *
 * Mode: FAKE_WORKER_MODE, or the contents of FAKE_WORKER_MODE_FILE.
 *   succeeded | degraded | failed | crash | exit2 | hang
 * FAKE_WORKER_DELAY_MS delays the result; FAKE_WORKER_TRACE appends
 * "start <id>" / "end <id>" lines to a file, to observe concurrency.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../../src/scene/compile/__fixtures__/moge-example-house-indoor.intermediate.json");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const input = arg("--input");
const output = arg("--output");
const mode = (process.env.FAKE_WORKER_MODE || (process.env.FAKE_WORKER_MODE_FILE && existsSync(process.env.FAKE_WORKER_MODE_FILE)
  ? readFileSync(process.env.FAKE_WORKER_MODE_FILE, "utf8") : "degraded")).trim();
const delay = Number(process.env.FAKE_WORKER_DELAY_MS || 0);
const trace = (event) => process.env.FAKE_WORKER_TRACE && appendFileSync(process.env.FAKE_WORKER_TRACE, `${event} ${basename(dirname(output))} ${Date.now()}\n`);

if (!input || !output || !existsSync(input)) {
  console.error(`error: ${input} is not a file`);
  process.exit(2);
}
const outDir = dirname(output);
if (existsSync(output) || (existsSync(outDir) && readdirSync(outDir).length)) {
  console.error(`error: ${outDir} already holds results; refusing to overwrite them`);
  process.exit(3);
}
if (mode === "exit2") {
  console.error("error: CUDA is not available. This worker does not fall back to the CPU.");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
trace("start");
console.log(`fake worker: ${mode}, ${input} -> ${output}`);

setTimeout(() => {
  if (mode === "hang") return setInterval(() => {}, 1 << 30);
  if (mode === "crash") {
    writeFileSync(join(outDir, "worker.log"), "Traceback: something went wrong\n");
    trace("end");
    process.exit(1);
  }
  const bytes = readFileSync(input);
  const sha = createHash("sha256").update(bytes).digest("hex");
  const run = JSON.parse(readFileSync(FIXTURE, "utf8"));
  run.jobId = basename(outDir);
  run.createdAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  Object.assign(run.source, { photographId: sha.slice(0, 16), inputSha256: sha, inputBytes: bytes.length });
  const d = run.diagnostics;
  if (mode === "succeeded") {
    d.warnings = [];
    d.status = "succeeded";
  } else if (mode === "failed") {
    d.errors = [{ code: "no-floor", stage: "layout", severity: "error", message: "no floor plane was found" }];
    d.status = "failed";
  } else {
    d.status = "degraded";
  }
  writeFileSync(join(outDir, "source.jpg"), bytes);
  writeFileSync(join(outDir, "worker.log"), `fake worker ${mode}\n`);
  writeFileSync(`${output}.part`, JSON.stringify(run));
  renameSync(`${output}.part`, output);
  trace("end");
  process.exit(mode === "failed" ? 5 : 0);
}, delay);
