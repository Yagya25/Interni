// Phase 8 browser test: evidence, the degraded explanation, and interactive calibration.
//
//   npm run build && node scripts/browser/calibration.mjs
//
// Copies one real run (reconstruction.json, source.jpg, planes.png) into a
// temporary runs folder, so the real run is never written to, then drives
// `next start` in headless Chrome over the DevTools protocol with real mouse
// and keyboard input. The source run is RUN (default the known-good
// 20260922T065240Z-2d25a689) in SOURCE_RUNS, or in DATUM_RECONSTRUCTION_RUNS
// (read from the environment or .env.local; nothing else is read from it).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUN = process.env.RUN || "20260922T065240Z-2d25a689";
const PORT = Number(process.env.PORT || 3218);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9348);
const ORIGIN = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
if (!CHROME) throw new Error("No Chrome found: set CHROME.");
if (!existsSync(join(ROOT, ".next/BUILD_ID"))) throw new Error("No production build: run `npm run build` first.");

function sourceRuns() {
  if (process.env.SOURCE_RUNS) return process.env.SOURCE_RUNS;
  if (process.env.DATUM_RECONSTRUCTION_RUNS) return process.env.DATUM_RECONSTRUCTION_RUNS;
  const env = join(ROOT, ".env.local");
  const line = existsSync(env) && readFileSync(env, "utf8").split(/\r?\n/).find((l) => l.startsWith("DATUM_RECONSTRUCTION_RUNS="));
  if (!line) throw new Error("Set SOURCE_RUNS to a runs folder holding the run to test.");
  return line.slice("DATUM_RECONSTRUCTION_RUNS=".length).trim();
}

/** The source run's files, sizes and times: it must be exactly the same at the end. */
const snapshot = () => readdirSync(join(sourceRuns(), RUN)).sort().map((f) => { const s = statSync(join(sourceRuns(), RUN, f)); return `${f}:${s.size}:${s.mtimeMs}`; }).join("|");
const SOURCE_BEFORE = snapshot();

const work = mkdtempSync(join(tmpdir(), "datum-calibration-e2e-"));
const RUNS = join(work, "runs");
const TARGET = join(RUNS, RUN);
mkdirSync(TARGET, { recursive: true });
for (const f of ["reconstruction.json", "source.jpg", "planes.png"]) copyFileSync(join(sourceRuns(), RUN, f), join(TARGET, f));
const intermediate = JSON.parse(readFileSync(join(TARGET, "reconstruction.json"), "utf8"));
const floor = intermediate.world.planes.find((p) => p.role === "floor");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const step = (id, name, pass, evidence) => {
  results.push({ id, pass });
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id}. ${name}`);
  if (evidence !== undefined) console.log("    ", JSON.stringify(evidence));
};

const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DATUM_RECONSTRUCTION_RUNS: RUNS, DATUM_DESIGN_AGENT: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${join(work, "profile")}`,
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
    // Chrome may still hold its profile; the folder is in the temp directory.
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

let send, evaluate;
const problems = [];
async function connect() {
  const target = await until(async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: "PUT" })).json(), 20000, "Chrome");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
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
    if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") problems.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
    if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) problems.push(`HTTP ${msg.params.response.status} ${msg.params.response.url}`);
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
  for (const d of ["Page", "Runtime", "Network"]) await send(`${d}.enable`);
}

const waitFor = (expression, timeout = 20000, label = expression) => until(() => evaluate(expression), timeout, label);

async function clickAt(x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
}
async function click(finder, label) {
  const rect = await evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!el.disabled }; })()`);
  if (!rect) throw new Error(`could not find ${label}`);
  if (rect.disabled) throw new Error(`${label} is disabled`);
  await clickAt(rect.x, rect.y);
}
async function typeInto(selector, text) {
  await click(`() => document.querySelector(${JSON.stringify(selector)})`, selector);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.insertText", { text });
}
const byText = (tag, re) => `() => [...document.querySelectorAll(${JSON.stringify(tag)})].find((el) => ${re}.test(el.textContent.trim()))`;
const panelText = (id) => evaluate(`document.getElementById(${JSON.stringify(id)})?.innerText ?? ""`);
const titleBlock = () => evaluate(`[...document.querySelectorAll("dl")].find((d) => /Extent/.test(d.textContent))?.innerText ?? ""`);
/** The room as the workspace holds it, read from the store behind the command bar. */
const room = () => evaluate(`(() => {
  const el = document.querySelector('textarea[aria-label="Ask about your space"]');
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  for (let f = el && el[key]; f; f = f.return) {
    const v = f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && v.getState().doc) {
      const s = v.getState().doc.scene;
      const xs = s.room.footprint.map((p) => p[0]);
      return { width: Math.max(...xs) - Math.min(...xs), height: s.room.height, sofa: s.objects.find((o) => o.id === "sofa-0")?.dimensions, past: v.getState().doc.past.length, sourceImageId: s.provenance.sourceImageId };
    }
  }
  return null;
})()`);
const workspaceOpen = `!!document.querySelector('textarea[aria-label="Ask about your space"]') && !!document.querySelector('[data-region="rail"]')`;

/** Where a canonical-image pixel is on screen, in the calibration panel's photograph. */
const photoPoint = ([x, y]) => evaluate(`(() => { const el = document.querySelector("[data-calibration-photo]"); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + (${x} / ${intermediate.source.width}) * r.width, y: r.y + (${y} / ${intermediate.source.height}) * r.height }; })()`);
async function mark(pixel) {
  const p = await photoPoint(pixel);
  // What is under the pointer must be the photograph, as it would be for a person.
  const hit = await evaluate(`!!document.elementFromPoint(${p.x}, ${p.y})?.closest("[data-calibration-photo]")`);
  if (!hit) throw new Error("the photograph is covered where it would be clicked");
  await clickAt(p.x, p.y);
  await sleep(150);
}

try {
  await until(async () => (await fetch(ORIGIN + "/")).ok, 60000, "server");
  await connect();
  await send("Page.navigate", { url: `${ORIGIN}/workspace/reconstruction/${RUN}` });
  await waitFor(workspaceOpen, 60000, "workspace");
  await waitFor(`[...document.querySelectorAll("dl")].some((d) => /Extent/.test(d.textContent))`, 60000, "title block");
  await sleep(1500);
  const r0 = await room();

  // C1: the degraded run explains itself and offers the next step.
  const block = await titleBlock();
  step("C1", "The title block says the run is degraded, why, and offers calibration",
    /Reconstruction completed with estimated camera calibration\./.test(block) && /GeoCalib's field of view \(\d+\.\d°\) and MoGe-2's \(\d+\.\d°\) disagree/.test(block) && /CALIBRATE A KNOWN DISTANCE/i.test(block) && /estimated, not calibrated/.test(block),
    block.split("\n").filter((l) => /Status|Reconstruction completed|GeoCalib|Calibrate/i.test(l)));

  // C2: the evidence panel.
  await click(`() => document.querySelector('button[aria-controls="panel-evidence"]')`, "Evidence tool");
  await waitFor(`!!document.getElementById("panel-evidence")`, 5000, "evidence panel");
  const evidence = await panelText("panel-evidence");
  const sections = ["ROOM", "CAMERA", "PLANES", "DEPTH AND SCALE", "MATERIALS", "LIGHTING", "OBJECTS"].filter((s) => evidence.includes(s));
  step("C2", "The evidence panel shows room, camera, planes, depth and scale, materials, lighting and objects, with bases and sources",
    sections.length === 7 && /59\.1° vertical/.test(evidence) && /MoGe-2 depth and geometry/.test(evidence) && /default/.test(evidence) && !/confidence/i.test(evidence),
    { sections });

  // C3: a piece's evidence in the inspector.
  await click(byText("#panel-evidence button", "/^Sofa/"), "Sofa in the evidence list");
  await waitFor(`!!document.getElementById("inspector") && /EVIDENCE/.test(document.getElementById("inspector").innerText)`, 5000, "inspector evidence");
  const inspector = await panelText("inspector");
  step("C3", "The inspector gives the sofa's detection, mask, depth, placement, scale and representation",
    ["Detection", "Mask", "Depth", "Placement", "Size", "Scale", "Drawn as"].every((l) => inspector.includes(l)) && /raw score 0\.695/.test(inspector) && /not a probability/.test(inspector) && /parametric sofa/.test(inspector));
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

  // C4: calibrate from the title block's action; mark two points on the floor.
  await click(byText("button", "/^Calibrate a known distance$/i"), "Calibrate a known distance");
  await waitFor(`!!document.querySelector("[data-calibration-photo] img")?.complete`, 10000, "calibration photograph");
  await sleep(800);
  const [x0, y0, x1, y1] = floor.pixelBox;
  const a = [x0 + (x1 - x0) * 0.35, y0 + (y1 - y0) * 0.55];
  const b = [x0 + (x1 - x0) * 0.65, y0 + (y1 - y0) * 0.55];
  await mark(a);
  await mark(b);
  const read = await evaluate(`document.querySelector("[data-marks]").textContent`);
  const estimate = Number(/reads ([\d.]+) m/.exec(read)?.[1]);
  step("C4", "Two marks on the floor resolve to the floor and read its uncalibrated length", /^On the floor · the reconstruction reads [\d.]+ m \(uncalibrated\)$/.test(read) && estimate > 0.1, { read });

  // C5: invalid input is refused.
  await typeInto('input[aria-label="Real length in metres"]', "0.01");
  await sleep(200);
  const invalid = await panelText("panel-calibrate");
  const disabled = await evaluate(`(${byText("#panel-calibrate button", "/^Apply calibration$/")})().disabled`);
  step("C5", "An impossible length is refused before anything is saved", /between 0\.05 and 50 m/.test(invalid) && disabled === true);

  // C6: a real length 10% longer than the reconstruction's reading: every length × 1.1.
  const real = (estimate * 1.1).toFixed(3);
  await typeInto('input[aria-label="Real length in metres"]', real);
  await typeInto('input[aria-label="What the length is"]', "floor span");
  await sleep(200);
  const preview = await evaluate(`document.querySelector("[data-preview]")?.textContent ?? ""`);
  step("C6", "The preview gives the factor the compiler will apply", /Every length × 1\.1\d\d \(\+1\d\.\d%\)/.test(preview), { preview });

  await click(byText("#panel-calibrate button", "/^Apply calibration$/"), "Apply calibration");
  await waitFor(`/calibrated to your measurement/.test(document.body.innerText)`, 20000, "calibrated room");
  await waitFor(workspaceOpen, 20000, "workspace after recompile");
  await sleep(1500);
  const r1 = await room();
  const factor = r1.width / r0.width;
  const saved = JSON.parse(readFileSync(join(TARGET, "calibration.json"), "utf8"));
  step("C7", "Applying saves calibration.json in the compiler's schema and recompiles the room by one factor",
    saved.schemaVersion === 1 && saved.references.length === 1 && saved.references[0].kind === "on-plane" && saved.references[0].planeId === floor.id && saved.references[0].label === "floor span" &&
      Math.abs(factor - Number(real) / estimate) < 0.01 && Math.abs(r1.height / r0.height - factor) < 0.01 && r1.sourceImageId === r0.sourceImageId,
    { factor: factor.toFixed(4), width: [r0.width, r1.width], reference: saved.references[0] });

  const after = await titleBlock();
  const calibratePanel = await panelText("panel-calibrate");
  step("C8", "The room says it is calibrated, claims no more, and the panel stays open with the reference listed",
    /calibrated to your measurement/.test(after) && /not its proportions/.test(after) && !/CALIBRATE A KNOWN DISTANCE/i.test(after) && /floor span: [\d.]+ m/.test(calibratePanel) && r1.past === 0);

  // C9: measurements follow — the free floor is recomputed on the calibrated room.
  const freeOf = (text) => Number(/([\d.]+) m² free/.exec(text)?.[1]);
  step("C9", "Floor measurements are recomputed on the calibrated room", freeOf(after) > freeOf(block) * 1.1, { before: freeOf(block), after: freeOf(after) });

  // C10: the evidence panel shows the calibrated scale.
  await click(`() => document.querySelector('button[aria-controls="panel-evidence"]')`, "Evidence tool");
  await waitFor(`!!document.getElementById("panel-evidence")`, 5000, "evidence panel");
  const evidence2 = await panelText("panel-evidence");
  step("C10", "Evidence now reads the scale as calibrated from your reference", /× 1\.1\d\d from 1 reference/.test(evidence2) && /floor span: [\d.]+ m/.test(evidence2));

  // C11: it persists: a reload opens the room calibrated.
  await send("Page.reload");
  await sleep(500);
  await waitFor(workspaceOpen, 60000, "workspace after reload");
  await sleep(1500);
  const r2 = await room();
  step("C11", "The calibration persists with the run across a reload", Math.abs(r2.width - r1.width) < 1e-9 && /calibrated to your measurement/.test(await titleBlock()));

  // C12: removing it returns the estimated room exactly, keeping the replaced file.
  await click(`() => document.querySelector('button[aria-controls="panel-calibrate"]')`, "Calibrate tool");
  await waitFor(`!!document.getElementById("panel-calibrate")`, 5000, "calibration panel");
  await click(byText("#panel-calibrate button", "/^Remove calibration$/"), "Remove calibration");
  await waitFor(`/estimated, not calibrated/.test(document.body.innerText)`, 20000, "estimated room");
  await waitFor(workspaceOpen, 20000, "workspace");
  await sleep(1000);
  const r3 = await room();
  const files = readdirSync(TARGET).filter((f) => f.startsWith("calibration"));
  step("C12", "Removing the calibration returns the estimated room exactly, and keeps the file it replaced",
    r3.width === r0.width && JSON.stringify(r3.sofa) === JSON.stringify(r0.sofa) && !files.includes("calibration.json") && files.includes("calibration.1.json"), { files });

  // C13: two marks on different surfaces are refused.
  await mark([floor.pixelBox[0] + 50, floor.pixelBox[1] + 200]);
  const wall = intermediate.world.planes.find((p) => p.role === "wall");
  await mark([(wall.pixelBox[0] + wall.pixelBox[2]) / 2, (wall.pixelBox[1] + wall.pixelBox[3]) / 2]);
  const refused = await evaluate(`document.querySelector("[data-marks]").textContent`);
  step("C13", "Marks on two different surfaces are refused", /same surface/.test(refused), { refused });

  // C14: the real run itself was never touched.
  step("C14", "The source run folder was not written to", snapshot() === SOURCE_BEFORE);
  step("C15", "No console errors or failed requests", problems.length === 0, problems.slice(0, 5));
} catch (error) {
  step("X", "Unexpected error", false, String(error?.stack ?? error));
  console.log(serverLog.slice(-3000));
}

console.log(`\nSUMMARY ${results.map((r) => `${r.id}:${r.pass ? "PASS" : "FAIL"}`).join(" ")}`);
await finish(results.every((r) => r.pass) ? 0 : 1);
