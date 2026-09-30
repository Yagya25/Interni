// Stale-poll regression: a replaced photograph's old job must never open its run.
//
//   npm run build && node scripts/browser/stale-poll.mjs    (production build, `next start`)
//   DEV=1 node scripts/browser/stale-poll.mjs               (`next dev`: React Strict Mode on)
//
// Photo A (a warm orange room) starts a reconstruction; before it finishes,
// the photograph is replaced with photo B (a cold navy room). Every
// navigation and every job request the page makes is recorded over the
// DevTools protocol, so "A never navigated" is checked against the browser's
// own record, not the page's. The status request can be held in flight with
// the Fetch domain, to replace the photograph while it is outstanding and
// release it only once A has finished. The fake worker stands in for the GPU
// worker (tests/fixtures/reconstruction/fake-worker.mjs). Installs nothing.
// CHROME may point at a Chrome or Edge executable; PORT and DEBUG_PORT pick
// the ports.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FAKE_WORKER = join(ROOT, "tests/fixtures/reconstruction/fake-worker.mjs");
const DEV = process.env.DEV === "1";
const PORT = Number(process.env.PORT || 3218);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9348);
const ORIGIN = `http://localhost:${PORT}`;
/** How long the fake worker takes: long enough to replace the photograph mid-job. */
const WORKER_MS = 12000;
/** How long to keep watching once A has finished: several poll intervals. */
const WATCH_MS = 6000;
const CHROME = process.env.CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
if (!CHROME) throw new Error("No Chrome found: set CHROME to a Chrome or Edge executable.");
if (!DEV && !existsSync(join(ROOT, ".next/BUILD_ID"))) throw new Error("No production build: run `npm run build` first, or set DEV=1.");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const work = mkdtempSync(join(tmpdir(), "datum-stale-poll-"));
const RUNS = join(work, "runs");
const PROFILE = join(work, "profile");

const results = [];
const step = (id, name, pass, evidence) => {
  results.push({ id, pass });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id}. ${name}`);
  if (evidence !== undefined) console.log("    ", JSON.stringify(evidence));
};

// --- The server -------------------------------------------------------------
const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), DEV ? "dev" : "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATUM_RECONSTRUCTION_RUNS: RUNS,
    DATUM_RECONSTRUCTION_WORKER_COMMAND: JSON.stringify([process.execPath, FAKE_WORKER]),
    DATUM_RECONSTRUCTION_ALLOW_TEST_WORKER: "1",
    FAKE_WORKER_MODE: "succeeded",
    FAKE_WORKER_DELAY_MS: String(WORKER_MS),
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

/** `next dev` runs the server in a child process: end the whole tree, not just the launcher. */
const killTree = (child) => {
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
};

async function finish(code) {
  killTree(chrome);
  killTree(server);
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

// --- DevTools protocol, with a record of navigations and job requests --------
/** Every URL the page's main frame showed, in order. */
const navigations = [];
/** Every request to a job endpoint: its CDP id, URL, when it was sent (ms), and whether it was cancelled. */
const requests = new Map();
/** Fetch-domain holds: while `holdRunId` is set, the next status request for it is paused and kept here. */
let holdRunId = null;
let held = null;

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
      return;
    }
    const p = msg.params;
    if (msg.method === "Page.frameNavigated" && !p.frame.parentId) navigations.push(p.frame.url);
    if (msg.method === "Page.navigatedWithinDocument") navigations.push(p.url);
    if (msg.method === "Network.requestWillBeSent" && p.request.url.includes("/api/reconstructions/local/jobs")) {
      requests.set(p.requestId, { url: p.request.url, method: p.request.method, at: p.wallTime * 1000, canceled: false });
    }
    if (msg.method === "Network.loadingFailed" && requests.has(p.requestId)) requests.get(p.requestId).canceled = !!p.canceled;
    if (msg.method === "Fetch.requestPaused") {
      if (holdRunId && !held && p.request.url.endsWith(`/jobs/${holdRunId}`)) held = { id: p.requestId, networkId: p.networkId, url: p.request.url };
      else send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
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
  await send("Network.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/reconstructions/local/jobs/*", requestStage: "Request" }] });
}

const waitFor = (expression, timeout = 20000, label = expression) => until(() => evaluate(expression), timeout, label);
const url = () => evaluate("location.pathname");
async function go(path) {
  await send("Page.navigate", { url: ORIGIN + path });
  await waitFor(`document.readyState === "complete"`, 90000, "page load");
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
const pipeline = `document.querySelector('[aria-labelledby="pipeline-title"]')?.textContent ?? ""`;
const followedRunId = () => evaluate(`localStorage.getItem("datum.reconstruction.job")`);
const workspaceOpen = `!!document.querySelector('textarea[aria-label="Ask about your space"]')`;

/**
 * Choose a photograph through whichever file input the page shows (the drop
 * zone, or "Replace photograph" once one is held). A and B are drawn to be
 * unmistakable: A a warm room with round lamps, B a cold one with tall
 * windows; the file name is written into the pixels so every file is new.
 * Returns the SHA-256 the browser computed and the page's clock at the change.
 */
async function choosePhoto(kind, name) {
  await waitFor(`!!document.querySelector('input[type="file"]')`, 90000, "file input");
  const chosen = await evaluate(`(async () => {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 800;
    const g = c.getContext("2d");
    if (${JSON.stringify(kind)} === "A") {
      g.fillStyle = "#e0703a"; g.fillRect(0, 0, 1200, 520);
      g.fillStyle = "#8c1d18"; g.fillRect(0, 520, 1200, 280);
      g.fillStyle = "#fff6e0"; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(160 + i * 220, 180, 70, 0, Math.PI * 2); g.fill(); }
    } else {
      g.fillStyle = "#14234f"; g.fillRect(0, 0, 1200, 520);
      g.fillStyle = "#c9d3dc"; g.fillRect(0, 520, 1200, 280);
      g.fillStyle = "#39d0e6"; for (let i = 0; i < 6; i++) g.fillRect(60 + i * 190, 80, 90, 360);
    }
    g.fillStyle = "#000"; g.font = "48px sans-serif"; g.fillText(${JSON.stringify(name)}, 40, 760);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const dt = new DataTransfer(); dt.items.add(new File([blob], ${JSON.stringify(name)}, { type: "image/jpeg" }));
    const input = document.querySelector('input[type="file"]');
    input.files = dt.files;
    const at = Date.now();
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { sha, at };
  })()`);
  await waitFor(`[...document.querySelectorAll("dl dd")].some((d) => d.textContent === ${JSON.stringify(name)})`, 20000, `${name} measured`);
  return { kind, name, ...chosen };
}

/** What the entry page shows now: its button, whether it follows a job, and the photograph on screen (hashed). */
const entry = () => evaluate(`(async () => {
  const b = (${reconstructButton})();
  const img = document.querySelector("figure img");
  const bytes = img?.src ? new Uint8Array(await (await fetch(img.src)).arrayBuffer()) : null;
  const shown = bytes ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("") : null;
  return { path: location.pathname, button: b?.textContent ?? null, disabled: !!b?.disabled, pipeline: ${pipeline}, followed: localStorage.getItem("datum.reconstruction.job"), shown };
})()`);

const jobStatus = (runId) => {
  try {
    return JSON.parse(readFileSync(join(RUNS, ".jobs", runId, "job.json"), "utf8")).status;
  } catch {
    return null;
  }
};
const finished = (runId) => ["complete", "degraded", "failed"].includes(jobStatus(runId));

/** Choose `kind`, send it, and wait until the page is following its job. */
async function startJob(kind, name) {
  const photo = await choosePhoto(kind, name);
  await click(reconstructButton, "Reconstruct this room");
  const runId = await until(followedRunId, 15000, "run id");
  await waitFor(`/Waiting for the worker|Reconstructing/.test(${pipeline})`, 15000, "processing state");
  return { ...photo, runId };
}

/** Status requests for a run sent after `since` (page clock, ms), split into live and cancelled. */
const statusRequests = (runId, since = 0) => {
  const all = [...requests.values()].filter((r) => r.method === "GET" && r.url.endsWith(`/jobs/${runId}`) && r.at > since);
  return { live: all.filter((r) => !r.canceled), canceled: all.filter((r) => r.canceled) };
};
const openedRun = (runId) => navigations.some((u) => u.includes(`/workspace/reconstruction/${runId}`));

/**
 * After the photograph was replaced: wait for A's job to finish on the
 * server, keep watching, and report whether A did anything to the page.
 */
async function watchStale(a, b) {
  await until(() => finished(a.runId), WORKER_MS * 4, `job ${a.runId} to finish`);
  await sleep(WATCH_MS);
  const after = statusRequests(a.runId, b.at + 100);
  const shown = await entry();
  return {
    aStatus: jobStatus(a.runId),
    aOpened: openedRun(a.runId),
    aPollsAfterReplace: after.live.length + after.canceled.length,
    page: { path: shown.path, button: shown.button, disabled: shown.disabled, followed: shown.followed, showsB: shown.shown === b.sha },
  };
}
const staleHarmless = (w) =>
  w.aStatus === "complete" && !w.aOpened && w.aPollsAfterReplace === 0 && w.page.path === "/workspace" &&
  w.page.button === "Reconstruct this room" && !w.page.disabled && w.page.followed === null && w.page.showsB;

/** Send B and check the opened workspace is B's run, with B's own bytes all the way through. */
async function reconstructB(b, a) {
  await click(reconstructButton, "Reconstruct this room");
  const runId = await until(followedRunId, 15000, "run id");
  await waitFor(`location.pathname.startsWith("/workspace/reconstruction/")`, WORKER_MS * 5, "navigation");
  const path = await url();
  await waitFor(workspaceOpen, 90000, "workspace");
  await waitFor(`[...document.querySelectorAll("img")].some((i) => (i.getAttribute("src") || "").endsWith("/source.jpg"))`, 30000, "the run's photograph");
  const opened = await evaluate(`(async () => {
    const el = document.querySelector('textarea[aria-label="Ask about your space"]');
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    let prov = null;
    for (let f = el[key]; f && !prov; f = f.return) {
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v.getState === "function" && v.getState().doc) prov = v.getState().doc.scene.provenance;
    }
    const img = [...document.querySelectorAll("img")].find((i) => (i.getAttribute("src") || "").endsWith("/source.jpg"));
    const bytes = img ? new Uint8Array(await (await fetch(img.getAttribute("src"), { cache: "no-store" })).arrayBuffer()) : null;
    const photo = bytes ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("") : null;
    return { sourceImageId: prov?.sourceImageId ?? null, photoSrc: img?.getAttribute("src") ?? null, photo };
  })()`);
  const kept = sha256(readFileSync(join(RUNS, ".jobs", runId, "original.jpg")));
  const workerSaw = sha256(readFileSync(join(RUNS, runId, "source.jpg")));
  const ok = path === `/workspace/reconstruction/${runId}` && runId !== a.runId && !openedRun(a.runId) &&
    opened.sourceImageId === b.sha.slice(0, 16) && opened.photo === b.sha && kept === b.sha && workerSaw === b.sha;
  return { ok, evidence: { runId, path, sourceImageId: opened.sourceImageId, photoSrc: opened.photoSrc, photoIsB: opened.photo === b.sha, keptIsB: kept === b.sha, workerSawB: workerSaw === b.sha, aOpened: openedRun(a.runId) } };
}

/** Run one scenario; an error fails that scenario only, so the rest still report. */
async function scenario(id, run) {
  try {
    await run();
  } catch (error) {
    step(id, "Unexpected error", false, String(error?.stack ?? error).slice(0, 600));
  }
}

/** Consecutive live status requests closer together than one loop allows mean two loops. */
const gaps = (list) => list.map((r) => r.at).sort((x, y) => x - y).map((t, i, all) => (i ? Math.round(t - all[i - 1]) : null)).slice(1);

try {
  await until(async () => (await fetch(ORIGIN + "/")).ok, 120000, "server");
  await connect();
  console.log(`mode: ${DEV ? "next dev (Strict Mode)" : "next start (production build)"}`);

  // S1: replace the photograph while A's job is running.
  await scenario("S1", async () => {
    await go("/workspace");
    const a1 = await startJob("A", "photo-A-1.jpg");
    await sleep(1000);
    const b1 = await choosePhoto("B", "photo-B-1.jpg");
    const w1 = await watchStale(a1, b1);
    step("S1", "Photo B replaces A mid-job: A finishes but never navigates, polls or takes the page back", staleHarmless(w1), w1);
    const f1 = await reconstructB(b1, a1);
    step("S1b", "Reconstructing B opens B's run, with B's bytes from upload to workspace", f1.ok, f1.evidence);
  });

  // S2: replace the photograph while A's status request is actually in flight,
  // held until A has finished so that its answer is "open the run".
  await scenario("S2", async () => {
    await go("/workspace");
    const a2 = await startJob("A", "photo-A-2.jpg");
    holdRunId = a2.runId;
    held = null;
    await until(() => held, 10000, "a held status request");
    await until(() => finished(a2.runId), WORKER_MS * 4, "A to finish while its request is held");
    const b2 = await choosePhoto("B", "photo-B-2.jpg");
    const released = await send("Fetch.continueRequest", { requestId: held.id }).then(() => "released", (e) => `not released (${e.message})`);
    holdRunId = null;
    const w2 = await watchStale(a2, b2);
    const heldRequest = [...requests.entries()].find(([id]) => id === held.networkId)?.[1];
    step("S2", "Photo B replaces A while A's status request is in flight and A has finished: A never navigates",
      staleHarmless(w2), { ...w2, heldRequest: { released, canceledByPage: heldRequest?.canceled ?? null } });
    const f2 = await reconstructB(b2, a2);
    step("S2b", "Reconstructing B opens B's run", f2.ok, f2.evidence);
  });

  // S3: reload while A is pending (Strict Mode mounts twice in dev), then replace.
  await scenario("S3", async () => {
    await go("/workspace");
    const a3 = await startJob("A", "photo-A-3.jpg");
    const reloadAt = await evaluate("Date.now()");
    await send("Page.reload");
    await sleep(300);
    await waitFor(`document.readyState === "complete"`, 90000, "reload");
    await waitFor(`/Waiting for the worker|Reconstructing/.test(${pipeline})`, 30000, "resumed state");
    await sleep(4000);
    const resumed = statusRequests(a3.runId, reloadAt);
    const resumedGaps = gaps(resumed.live);
    step("S3", "Reloading while A is pending resumes exactly one poll loop",
      resumed.live.length >= 2 && resumedGaps.every((g) => g >= 1000), { live: resumed.live.length, cancelledAtMount: resumed.canceled.length, gapsMs: resumedGaps });
    const b3 = await choosePhoto("B", "photo-B-3.jpg");
    const w3 = await watchStale(a3, b3);
    step("S3b", "After the reload, photo B replaces A: A never navigates", staleHarmless(w3), w3);
    const f3 = await reconstructB(b3, a3);
    step("S3c", "Reconstructing B opens B's run", f3.ok, f3.evidence);
  });

  // S4: reload while A is pending and leave it: the job is still followed, once, to its run.
  await scenario("S4", async () => {
    await go("/workspace");
    const a4 = await startJob("A", "photo-A-4.jpg");
    const reload4 = await evaluate("Date.now()");
    await send("Page.reload");
    await sleep(300);
    await waitFor(`document.readyState === "complete"`, 90000, "reload");
    await waitFor(`location.pathname === "/workspace/reconstruction/${a4.runId}"`, WORKER_MS * 5, "navigation to A after reload");
    await waitFor(workspaceOpen, 90000, "workspace");
    const followed = statusRequests(a4.runId, reload4);
    const followedGaps = gaps(followed.live);
    step("S4", "Reloading mid-job without replacing still opens A, followed by one loop",
      followed.live.length >= 1 && followedGaps.every((g) => g >= 1000), { path: await url(), live: followed.live.length, cancelledAtMount: followed.canceled.length, gapsMs: followedGaps });
  });
} catch (error) {
  step("X", "Unexpected error", false, String(error?.stack ?? error));
  console.log(serverLog.slice(-3000));
}

console.log(`\nSUMMARY ${results.map((r) => `${r.id}:${r.pass ? "PASS" : "FAIL"}`).join(" ")}`);
await finish(results.every((r) => r.pass) ? 0 : 1);
