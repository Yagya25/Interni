// Phase 4A browser regression: finish designs ("Give me 3 modern designs"),
// preview, exit, apply as one history step, undo/redo, and the Phase 5 title
// block staying as found while only finishes change.
//
//   npm run build && node scripts/browser/finish-designs.mjs
//
// Copies one real run (reconstruction.json, source.jpg, planes.png) into a
// temporary runs folder, so the real run is never written to, then drives
// `next start` in headless Chrome over the DevTools protocol with real mouse
// and keyboard input; it reads the running store only. The source run is RUN
// (default the known-good 20260922T065240Z-2d25a689) in SOURCE_RUNS, or in
// DATUM_RECONSTRUCTION_RUNS (read from the environment or .env.local; nothing
// else is read from it). Screenshots, the log and result JSON go to OUT
// (default a folder in the system temp directory, printed at the end).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUN = process.env.RUN || "20260922T065240Z-2d25a689";
const SERVER_PORT = Number(process.env.PORT || 3220);
const PORT = Number(process.env.DEBUG_PORT || 9350);
const ORIGIN = `http://localhost:${SERVER_PORT}`;
const URL_ = `${ORIGIN}/workspace/reconstruction/${RUN}`;
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

const work = mkdtempSync(join(tmpdir(), "datum-finish-designs-"));
const RUNS = join(work, "runs");
mkdirSync(join(RUNS, RUN), { recursive: true });
for (const f of ["reconstruction.json", "source.jpg", "planes.png"]) copyFileSync(join(sourceRuns(), RUN, f), join(RUNS, RUN, f));
const HERE = process.env.OUT ? resolve(process.env.OUT) : join(tmpdir(), "datum-browser-finish-designs");
mkdirSync(HERE, { recursive: true });
const PROFILE = join(work, "profile");
mkdirSync(PROFILE, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(SERVER_PORT)], {
  cwd: ROOT,
  env: { ...process.env, DATUM_RECONSTRUCTION_RUNS: RUNS, DATUM_DESIGN_AGENT: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; ; i++) {
  try { if ((await fetch(ORIGIN + "/")).ok) break; } catch {}
  if (i > 400) { server.kill(); throw new Error("next start never answered:\n" + serverLog.slice(-2000)); }
  await new Promise((r) => setTimeout(r, 150));
}

const log = [];
const say = (...a) => {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  log.push(line);
  console.log(line);
};
const results = [];
const step = (n, name, pass, evidence) => {
  results.push({ n, name, pass, evidence });
  say(`\n[${pass ? "PASS" : "FAIL"}] ${n}. ${name}`);
  if (evidence !== undefined) say("   ", evidence);
};

const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  "--enable-unsafe-swiftshader",
  "--use-angle=swiftshader",
  "--window-size=1440,900",
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, method = "GET") {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
      if (res.ok) return await res.json();
    } catch {}
    await sleep(200);
  }
  throw new Error(`DevTools endpoint ${path} never answered`);
}

// ---------------------------------------------------------------------------
// CDP

const target = await json(`/json/new?about:blank`, "PUT");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
const consoleMessages = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    consoleMessages.push({ source: "console", level: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ") });
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleMessages.push({ source: "exception", level: "error", text: d.exception?.description ?? d.text });
  } else if (msg.method === "Log.entryAdded") {
    consoleMessages.push({ source: `log:${msg.params.entry.source}`, level: msg.params.entry.level, text: msg.params.entry.text + (msg.params.entry.url ? ` (${msg.params.entry.url})` : "") });
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
async function waitFor(expression, timeout = 20000, label = expression) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A real mouse click on the centre of an element found in the page. */
async function click(finder, label) {
  const rect = await evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: !!el.disabled }; })()`);
  if (!rect) throw new Error(`could not find ${label}`);
  if (rect.disabled) throw new Error(`${label} is disabled`);
  // What is actually under the pointer must be the element (or inside it): nothing covering it.
  const hit = await evaluate(`(() => { const el = (${finder})(); const at = document.elementFromPoint(${rect.x}, ${rect.y}); return !!at && (at === el || el.contains(at)); })()`);
  if (!hit) throw new Error(`${label} is covered by another element`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
  }
}

/** Type into the command bar like a person: click it, clear it, type, press Enter. */
async function ask(text) {
  await waitFor(`!document.querySelector('textarea[aria-label="Ask about your space"]').disabled`, 20000, "command bar enabled");
  await click(`() => document.querySelector('textarea[aria-label="Ask about your space"]')`, "command bar");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.insertText", { text });
  const typed = await evaluate(`document.querySelector('textarea[aria-label="Ask about your space"]').value`);
  if (typed !== text) throw new Error(`command bar holds ${JSON.stringify(typed)}, not ${JSON.stringify(text)}`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(150);
  await waitFor(`!window.__store.getState().command.pending`, 30000, "command answered");
  await sleep(400);
}

const cardButton = (index, text) => `() => { const card = document.querySelectorAll('aside[aria-label="Design directions"] article')[${index}]; return card ? [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}) : null; }`;

// ---------------------------------------------------------------------------
// Screenshots, and how much of the picture changed

async function screenshot(name) {
  await sleep(2500); // let the renderer settle any transition
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(data, "base64");
  writeFileSync(join(HERE, `${name}.png`), buf);
  return decodePng(buf);
}
function decodePng(buf) {
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
    } else if (type === "IDAT") idat.push(body);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, pixels: out };
}
function changed(a, b) {
  let n = 0;
  const total = a.width * a.height;
  for (let i = 0; i < total; i++) {
    const o = i * a.bpp;
    if (Math.abs(a.pixels[o] - b.pixels[o]) + Math.abs(a.pixels[o + 1] - b.pixels[o + 1]) + Math.abs(a.pixels[o + 2] - b.pixels[o + 2]) > 24) n++;
  }
  return +(n / total * 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Reading the running store (read-only)

const PROBE = `
window.__findStore = () => {
  if (window.__store) return true;
  const el = document.querySelector('textarea[aria-label="Ask about your space"]');
  if (!el) return false;
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  for (let f = el[key]; f; f = f.return) {
    const v = f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.applyDesign === "function") { window.__store = v; return true; }
  }
  return false;
};
window.__hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
window.__snap = () => {
  const s = window.__store.getState();
  const doc = JSON.stringify(s.doc.scene);
  const rendered = JSON.stringify(s.scene);
  return {
    docHash: window.__hash(doc), docLength: doc.length,
    renderedHash: window.__hash(rendered),
    renderedIsDoc: s.scene === s.doc.scene,
    past: s.doc.past.map((e) => e.label), future: s.doc.future.map((e) => e.label),
    design: s.design && { request: s.design.request, previewId: s.design.previewId, appliedId: s.design.appliedId, rejected: s.design.rejected,
      proposals: s.design.proposals.map((p) => ({ id: p.id, title: p.title, status: p.status, moved: p.preview.movedObjectCount, operations: p.operations.length, kinds: [...new Set(p.operations.map((o) => o.kind))], changes: p.changes.map((c) => c.target + ": " + c.detail) })) },
    command: { pending: s.command.pending, kind: s.command.kind, note: s.command.note, options: s.command.options.map((o) => o.label + (o.description ? " — " + o.description : "")) },
    proposal: s.proposal && { title: s.proposal.title, changes: s.proposal.changes.map((c) => ({ group: c.group, target: c.target, detail: c.detail })) },
    receipt: s.receipt,
  };
};
/** Pieces whose position or turn differs between two serialized scenes. */
window.__moves = (a, b) => {
  const A = JSON.parse(a).objects, B = JSON.parse(b).objects;
  const out = [];
  for (const o of A) {
    const p = B.find((x) => x.id === o.id);
    if (!p) { out.push({ id: o.id, gone: true }); continue; }
    const d = Math.hypot(p.transform.position[0] - o.transform.position[0], p.transform.position[2] - o.transform.position[2]);
    const t = ((p.transform.rotation[1] - o.transform.rotation[1]) * 180) / Math.PI;
    if (d > 0.0005 || Math.abs(t) > 0.01) out.push({ id: o.id, label: o.label, movedCm: Math.round(d * 100), turnedDeg: Math.round(t), to: [+p.transform.position[0].toFixed(3), +p.transform.position[2].toFixed(3)] });
  }
  return out;
};
true;
`;
const snap = () => evaluate("window.__snap()");


// ---------------------------------------------------------------------------
// Phase 5: what the title block and the inspector say

const TITLE = `(() => { const b = document.querySelector('main[data-region="stage"] dl'); if (!b) return null; const rows = {}; for (const r of b.querySelectorAll(':scope > div')) { const k = r.querySelector('dt')?.textContent.trim(); const dd = r.querySelector('dd'); if (k && k !== "Photo") rows[k] = { text: dd.innerText.replace(/\\s+/g, " ").trim(), settling: r.hasAttribute('data-settling') }; } return rows; })()`;
const INSPECTOR = `(() => { const p = document.querySelector('aside#inspector'); if (!p) return null; const out = { title: p.querySelector('h2')?.textContent, sections: {} }; for (const s of p.querySelectorAll('section')) { const t = s.querySelector('h3')?.textContent; const rows = {}; for (const r of s.querySelectorAll('dl > div')) { rows[r.querySelector('dt').textContent.trim()] = r.querySelector('dd').innerText.replace(/\\s+/g, " ").trim(); } out.sections[t] = { rows, settling: !!s.querySelector('dl[data-settling]') }; } return out; })()`;
async function inspect(id) {
  await evaluate(`window.__store.select(${JSON.stringify(id)}); true`);
  await waitFor(`!!document.querySelector('aside#inspector')`, 5000, "the inspector");
  await sleep(500);
  return evaluate(INSPECTOR);
}

// ---------------------------------------------------------------------------

try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: URL_ });
  await waitFor(`!!document.querySelector('textarea[aria-label="Ask about your space"]')`, 30000, "workspace to load");
  await evaluate(PROBE);
  await waitFor("window.__findStore()", 10000, "the workspace store");
  await waitFor(`!!document.querySelector('canvas')`, 20000, "the 3D canvas");
  await evaluate(`window.__original = JSON.stringify(window.__store.getState().doc.scene); true`);
  const s1 = await snap();
  await waitFor("!!document.querySelector('main[data-region=\"stage\"] dl')", 20000, "the title block");
  await sleep(600);
  const title0 = await evaluate(TITLE);

  // 4A-1. A finish direction, not a layout.
  await ask("Give me 3 modern designs");
  const s2 = await snap();
  const base = await screenshot("4a-01-original-with-cards");
  step("4A-1", "Ask \"Give me 3 modern designs\": three finish proposals, document untouched",
    !!s2.design && s2.design.proposals.length === 3 && s2.design.proposals.every((p) => p.kinds.length > 0 && !p.kinds.includes("move")) && s2.docHash === s1.docHash,
    { request: s2.design?.request, proposals: s2.design?.proposals.map((p) => ({ title: p.title, kinds: p.kinds, changes: p.changes.length })), documentUntouched: s2.docHash === s1.docHash });

  // 4A-2. Preview.
  await click(cardButton(0, "Preview"), "Preview on design 1");
  await sleep(300);
  const s3 = await snap();
  const shot1 = await screenshot("4a-02-preview-1");
  const px = changed(base, shot1);
  step("4A-2", "Preview design 1: the room changes on screen, the document does not",
    s3.design.previewId === s3.design.proposals[0].id && s3.docHash === s1.docHash && s3.renderedHash !== s1.docHash && s3.past.length === 0 && px > 0.5,
    { previewId: s3.design.previewId, screenPixelsChanged: `${px}%`, documentHashUnchanged: s3.docHash === s1.docHash, renderedDiffersFromDocument: s3.renderedHash !== s3.docHash });

  // P5. A finish changes no geometry: the floor readings stay as found, not "as edited".
  const trace = [];
  for (let i = 0; i < 30; i++) {
    const st = await evaluate(`(() => { const stage = document.querySelector('main[data-region="stage"]'); const loading = stage?.querySelector('[role="status"]'); const err = stage?.querySelector('[data-status="error"], [status="error"]'); return { dl: !!stage?.querySelector('dl'), loading: loading ? loading.textContent.trim().slice(0, 80) : null, canvas: !!stage?.querySelector('canvas'), text: stage ? stage.innerText.replace(/\s+/g, " ").slice(0, 120) : null }; })()`);
    trace.push({ t: i * 500, ...st });
    if (st.dl) break;
    await sleep(500);
  }
  say("   trace", trace.slice(0, 3), "...", trace.at(-1), "samples", trace.length);
  await sleep(700);
  const titleP = await evaluate(TITLE);
  step("4A-P5", "Previewing finishes leaves the floor measured as found", titleP.Floor.text === title0.Floor.text && titleP.Extent.text === title0.Extent.text,
    { before: title0.Floor.text, during: titleP.Floor.text });

  // 4A-3. Exit preview.
  await click(cardButton(0, "Exit preview"), "Exit preview on design 1");
  await sleep(300);
  const s4 = await snap();
  const exact = await evaluate(`JSON.stringify(window.__store.getState().scene) === window.__original && window.__store.getState().scene === window.__store.getState().doc.scene`);
  step("4A-3", "Exit preview: the original room exactly", exact && s4.design.previewId === null && s4.renderedIsDoc, { serializedEqualToOriginal: exact, previewId: s4.design.previewId });

  // 4A-4. Apply design 2: one history step.
  await click(cardButton(1, "Preview"), "Preview on design 2");
  await sleep(300);
  await evaluate(`window.__preview2 = JSON.stringify(window.__store.getState().scene); true`);
  await click(cardButton(1, "Apply"), "Apply on design 2");
  await sleep(300);
  await evaluate(`window.__applied = JSON.stringify(window.__store.getState().doc.scene); true`);
  const s5 = await snap();
  const same = await evaluate(`window.__applied === window.__preview2`);
  step("4A-4", "Apply design 2: one history step, the document is what was previewed",
    s5.past.length === 1 && s5.past[0] === s5.design.proposals[1].title && same && s5.docHash !== s1.docHash && s5.design.appliedId === s5.design.proposals[1].id,
    { history: s5.past, documentEqualsWhatWasPreviewed: same, receipt: s5.receipt });

  // 4A-5. Undo, redo.
  await click(`() => document.querySelector('button[title="Undo (Ctrl+Z)"]')`, "Undo");
  await sleep(300);
  const s6 = await snap();
  const undone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__original`);
  await click(`() => document.querySelector('button[title="Redo (Ctrl+Shift+Z)"]')`, "Redo");
  await sleep(300);
  const s7 = await snap();
  const redone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__applied`);
  step("4A-5", "Undo returns the original exactly; redo returns design 2 exactly",
    undone && s6.past.length === 0 && s6.future.length === 1 && redone && s7.past.length === 1 && s7.future.length === 0,
    { undoToOriginal: undone, redoToApplied: redone, afterUndo: { past: s6.past, future: s6.future }, afterRedo: { past: s7.past, future: s7.future } });

  await sleep(1000);
  const errors = consoleMessages.filter((m) => m.level === "error");
  step("4A-6", "No console errors", errors.length === 0, { errors, warnings: consoleMessages.filter((m) => m.level === "warning" || m.level === "warn").map((m) => m.text.slice(0, 80)) });
} catch (error) {
  say("\nDRIVER FAILURE:", String(error?.stack ?? error));
  results.push({ n: 0, name: "driver", pass: false, evidence: String(error) });
} finally {
  say("\nconsole messages:", consoleMessages);
  say("\nSUMMARY", results.map((r) => `${r.n}:${r.pass ? "PASS" : "FAIL"}`).join(" "));
  writeFileSync(join(HERE, "result-4a.json"), JSON.stringify({ results, consoleMessages }, null, 2));
  writeFileSync(join(HERE, "log-4a.txt"), log.join("\n"));
  try { await send("Browser.close"); } catch {}
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {} // Chrome may still hold its profile; it is in the temp directory.
  console.log(`\nscreenshots, log-4a.txt and result-4a.json: ${HERE}`);
  process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
}
