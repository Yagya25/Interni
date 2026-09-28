// Phase 7 browser test: upload → job → worker → status → reconstruction workspace.
//
//   npm run build && node scripts/browser/upload-pipeline.mjs
//
// Runs the production build (`next start`) against a temporary runs folder,
// with the fake worker (tests/fixtures/reconstruction/fake-worker.mjs) in
// place of the GPU worker, and drives headless Chrome over the DevTools
// protocol with real mouse input. Installs nothing. CHROME may point at a
// Chrome or Edge executable; PORT and DEBUG_PORT pick the ports.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FAKE_WORKER = join(ROOT, "tests/fixtures/reconstruction/fake-worker.mjs");
const PORT = Number(process.env.PORT || 3217);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9347);
const ORIGIN = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
if (!CHROME) throw new Error("No Chrome found: set CHROME to a Chrome or Edge executable.");
if (!existsSync(join(ROOT, ".next/BUILD_ID"))) throw new Error("No production build: run `npm run build` first.");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const work = mkdtempSync(join(tmpdir(), "datum-upload-e2e-"));
const RUNS = join(work, "runs");
const MODE_FILE = join(work, "mode");
const TRACE = join(work, "trace.txt");
const PROFILE = join(work, "profile");
const setMode = (mode) => writeFileSync(MODE_FILE, mode);
setMode("succeeded");

const results = [];
const step = (id, name, pass, evidence) => {
  results.push({ id, pass });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id}. ${name}`);
  if (evidence !== undefined) console.log("    ", JSON.stringify(evidence));
};

// --- The server -------------------------------------------------------------
const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATUM_RECONSTRUCTION_RUNS: RUNS,
    DATUM_RECONSTRUCTION_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
    DATUM_RECONSTRUCTION_ALLOW_TEST_WORKER: "1",
    FAKE_WORKER_MODE_FILE: MODE_FILE,
    FAKE_WORKER_DELAY_MS: "2500",
    FAKE_WORKER_TRACE: TRACE,
    DATUM_DESIGN_AGENT: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${PROFILE}`,
  "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--window-size=1440,900",
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

async function finish(code) {
  chrome.kill();
  server.kill();
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // Chrome may still hold its profile for a moment; the folder is in the temp directory.
  }
  process.exit(code);
}

async function until(fn, timeout, label) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// --- DevTools protocol ------------------------------------------------------
let send, evaluate;
async function connect() {
  const target = await until(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" })).json(), 20000, "Chrome");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  let next = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) fail(new Error(msg.error.message));
      else ok(msg.result);
    }
  };
  send = (method, params = {}) => new Promise((ok, fail) => {
    const id = next++;
    pending.set(id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
}

const waitFor = (expression, timeout = 20000, label = expression) => until(() => evaluate(expression), timeout, label);
const url = () => evaluate("location.pathname");
async function go(path) {
  await send("Page.navigate", { url: ORIGIN + path });
  await waitFor(`document.readyState === "complete"`, 20000, "page load");
}

async function click(finder, label) {
  const rect = await evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!el.disabled }; })()`);
  if (!rect) throw new Error(`could not find ${label}`);
  if (rect.disabled) throw new Error(`${label} is disabled`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
}

const reconstructButton = `() => [...document.querySelectorAll("button")].find((b) => /Reconstruct this room|Try again|Reconstructing/.test(b.textContent))`;

/**
 * Choose a photograph, as a file input would receive it: a JPEG made in the
 * page (1200 × 800, varied by `seed` so every upload is a different file).
 * Returns its SHA-256 as the browser computed it.
 */
async function choosePhoto(seed) {
  await waitFor(`!!document.querySelector('input[type="file"]')`, 20000, "file input");
  const sha = await evaluate(`(async () => {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 800;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 1200, 800);
    grad.addColorStop(0, "hsl(${(seed * 47) % 360} 30% 70%)"); grad.addColorStop(1, "hsl(${(seed * 91) % 360} 25% 35%)");
    g.fillStyle = grad; g.fillRect(0, 0, 1200, 800);
    for (let i = 0; i < 40; i++) { g.fillStyle = "hsl(" + ((i * 37 + ${seed}) % 360) + " 40% 50%)"; g.fillRect((i * 131 + ${seed}) % 1100, (i * 71) % 700, 60, 90); }
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const dt = new DataTransfer(); dt.items.add(new File([blob], "room-${seed}.jpg", { type: "image/jpeg" }));
    const input = document.querySelector('input[type="file"]');
    input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    return digest;
  })()`);
  await waitFor(`!!(${reconstructButton})() && !(${reconstructButton})().disabled`, 20000, "Reconstruct button");
  return sha;
}

/** The run id the page is following, from its own storage. */
const followedRunId = () => evaluate(`localStorage.getItem("datum.reconstruction.job")`);

const jobFiles = (runId) => {
  const dir = join(RUNS, ".jobs", runId);
  return { dir, original: readdirSync(dir).find((f) => f.startsWith("original.") && !f.endsWith(".part")) };
};

// Opened workspace: the command bar is there and the room has been compiled.
const workspaceOpen = `!!document.querySelector('textarea[aria-label="Ask about your space"]')`;
const provenance = () => evaluate(`(() => {
  const el = document.querySelector('textarea[aria-label="Ask about your space"]');
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  for (let f = el[key]; f; f = f.return) {
    const v = f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && v.getState().doc) return v.getState().doc.scene.provenance;
  }
  return null;
})()`);

async function reconstructAndOpen(id, mode, seed) {
  setMode(mode);
  await go("/workspace");
  const sha = await choosePhoto(seed);
  await click(reconstructButton, "Reconstruct this room");
  const processing = await waitFor(`/Waiting for the worker|Reconstructing/.test(document.querySelector('[aria-labelledby="pipeline-title"]').textContent) && (${reconstructButton})().disabled`, 10000, "processing state");
  const runId = await until(followedRunId, 5000, "run id");
  await waitFor(`location.pathname.startsWith("/workspace/reconstruction/")`, 30000, "navigation");
  const path = await url();
  await waitFor(workspaceOpen, 30000, "workspace");
  const prov = await provenance();
  const { dir, original } = jobFiles(runId);
  const kept = readFileSync(join(dir, original));
  const workerSaw = readFileSync(join(RUNS, runId, "source.jpg"));
  const log = readFileSync(join(dir, "process.log"), "utf8");
  const run = JSON.parse(readFileSync(join(RUNS, runId, "reconstruction.json"), "utf8"));
  return { id, sha, runId, path, processing, prov, kept, workerSaw, log, run };
}

try {
  await until(async () => (await fetch(ORIGIN + "/api/reconstructions/local")).ok || true, 60000, "server");
  await until(async () => (await fetch(ORIGIN + "/")).ok, 60000, "server");
  await connect();

  // U1–U4: a successful reconstruction, from upload to the workspace.
  const a = await reconstructAndOpen("U1", "succeeded", 1);
  step("U1", "Upload shows a processing state while the worker runs", a.processing === true);
  step("U2", "Completion navigates to /workspace/reconstruction/[runId]", a.path === `/workspace/reconstruction/${a.runId}`, { path: a.path });
  step("U3", "The uploaded bytes are kept exactly and are what the worker received",
    sha256(a.kept) === a.sha && sha256(a.workerSaw) === a.sha && a.log.includes(join(".jobs", a.runId, "original.jpg")),
    { upload: a.sha.slice(0, 16), kept: sha256(a.kept).slice(0, 16), worker: sha256(a.workerSaw).slice(0, 16) });
  step("U4", "sourceImageId in the opened Scene is the upload's own", a.prov?.kind === "reconstruction" && a.prov?.sourceImageId === a.sha.slice(0, 16) && a.run.diagnostics.status === "succeeded",
    { sourceImageId: a.prov?.sourceImageId });

  // U5: degraded opens, and says its scale is estimated.
  const b = await reconstructAndOpen("U5", "degraded", 2);
  const estimated = await waitFor(`/estimated/.test(document.body.textContent)`, 15000, "estimated scale").catch(() => false);
  step("U5", "A degraded run opens in the workspace, shown as estimated", b.path.endsWith(b.runId) && b.run.diagnostics.status === "degraded" && estimated && b.prov?.sourceImageId === b.sha.slice(0, 16));

  // U6: a failed run stays on the entry page with the worker's reason.
  setMode("failed");
  await go("/workspace");
  await choosePhoto(3);
  await click(reconstructButton, "Reconstruct this room");
  await waitFor(`!!document.querySelector('[aria-labelledby="pipeline-title"] [role="alert"]')`, 30000, "failure message");
  const failure = await evaluate(`document.querySelector('[aria-labelledby="pipeline-title"] [role="alert"]').textContent`);
  const retry = await evaluate(`(${reconstructButton})()?.textContent`);
  step("U6", "A failed run shows the worker's reason and offers to try again", (await url()) === "/workspace" && /floor isn.t visible/.test(failure) && retry === "Try again", { failure, retry });

  // U7: what the worker must never be sent.
  await go("/workspace");
  const clientSide = await evaluate(`(async () => {
    const dt = new DataTransfer(); dt.items.add(new File([new TextEncoder().encode("%PDF-1.7 not an image")], "room.jpg", { type: "application/pdf" }));
    const input = document.querySelector('input[type="file"]'); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 800));
    return document.body.textContent;
  })()`);
  const direct = await evaluate(`(async () => {
    const f = new FormData(); f.append("photo", new File([new TextEncoder().encode("%PDF-1.7 not an image")], "room.jpg", { type: "image/jpeg" }));
    const r = await fetch("/api/reconstructions/local/jobs", { method: "POST", body: f });
    return { status: r.status, body: await r.text() };
  })()`);
  step("U7", "A PDF named room.jpg is refused, in the page and by the server", /isn.t a photograph this can read/.test(clientSide) && direct.status === 415 && JSON.parse(direct.body).code === "wrong-type", direct);

  // U8: reloading mid-reconstruction keeps following the job.
  setMode("succeeded");
  await go("/workspace");
  const c = await choosePhoto(4);
  await click(reconstructButton, "Reconstruct this room");
  const cRun = await until(followedRunId, 5000, "run id");
  await waitFor(`/Reconstructing/.test(document.querySelector('[aria-labelledby="pipeline-title"]').textContent)`, 10000, "running");
  await send("Page.reload");
  await sleep(300);
  await waitFor(`document.readyState === "complete"`, 20000, "reload");
  const afterReload = await until(async () => (await url()).startsWith("/workspace/reconstruction/") || (await evaluate(`/Waiting for the worker|Reconstructing/.test(document.body.textContent)`)), 10000, "state after reload");
  await waitFor(`location.pathname === "/workspace/reconstruction/${cRun}"`, 30000, "navigation after reload");
  await waitFor(workspaceOpen, 30000, "workspace");
  step("U8", "Reloading during reconstruction resumes polling and still opens the run", afterReload && (await provenance())?.sourceImageId === c.slice(0, 16));

  // U9: concurrent uploads are isolated, and only one worker runs at a time.
  writeFileSync(TRACE, "");
  const burst = await evaluate(`(async () => {
    const make = async (seed) => {
      const c = document.createElement("canvas"); c.width = 800; c.height = 700;
      const g = c.getContext("2d"); g.fillStyle = "hsl(" + seed * 50 + " 40% 50%)"; g.fillRect(0, 0, 800, 700);
      return new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    };
    const same = await make(1);
    const blobs = [same, same, await make(2)];
    const answers = await Promise.all(blobs.map(async (b, i) => {
      const f = new FormData(); f.append("photo", b, "burst-" + i + ".jpg");
      const r = await fetch("/api/reconstructions/local/jobs", { method: "POST", body: f });
      return { status: r.status, text: await r.text() };
    }));
    const ids = answers.map((a) => JSON.parse(a.text).runId);
    const seen = [];
    for (;;) {
      const views = await Promise.all(ids.map(async (id) => (await fetch("/api/reconstructions/local/jobs/" + id)).text()));
      seen.push(...views);
      if (views.every((v) => ["complete", "degraded", "failed"].includes(JSON.parse(v).status))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return { answers, ids, seen, running: seen.map((v) => JSON.parse(v)).filter((v) => v.status === "running").length };
  })()`);
  const events = readFileSync(TRACE, "utf8").trim().split("\n").map((l) => l.split(" "));
  const order = events.map(([e]) => e).join(",");
  const distinct = new Set(burst.ids).size === 3 && burst.ids.every((id) => existsSync(join(RUNS, id, "reconstruction.json")) && JSON.parse(readFileSync(join(RUNS, id, "reconstruction.json"), "utf8")).jobId === id);
  step("U9", "Three simultaneous uploads get separate runs and run one at a time", burst.answers.every((x) => x.status === 202) && distinct && order === "start,end,start,end,start,end", { ids: burst.ids, order });

  // U10: nothing the browser receives names a path on this machine.
  const bodies = [...burst.answers.map((x) => x.text), ...burst.seen, direct.body];
  const leaked = bodies.filter((t) => t.includes("\\") || t.includes(RUNS) || /\/home\/|wsl|\.jobs|original\./i.test(t));
  step("U10", "Job responses carry no server or WSL paths", leaked.length === 0, leaked.slice(0, 2));
} catch (error) {
  step("X", "Unexpected error", false, String(error?.stack ?? error));
  console.log(serverLog.slice(-3000));
}

console.log(`\nSUMMARY ${results.map((r) => `${r.id}:${r.pass ? "PASS" : "FAIL"}`).join(" ")}`);
await finish(results.every((r) => r.pass) ? 0 : 1);
