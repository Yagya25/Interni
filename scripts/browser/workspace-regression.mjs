// Main workspace browser regression (Phases 3E, 4B and 5): layouts, preview,
// apply, undo/redo, direct and ambiguous commands, the title block, the
// inspector, and the rail and title block at six viewport sizes.
//
//   npm run build && node scripts/browser/workspace-regression.mjs
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
const SERVER_PORT = Number(process.env.PORT || 3219);
const PORT = Number(process.env.DEBUG_PORT || 9349);
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

const work = mkdtempSync(join(tmpdir(), "datum-workspace-regression-"));
const RUNS = join(work, "runs");
mkdirSync(join(RUNS, RUN), { recursive: true });
for (const f of ["reconstruction.json", "source.jpg", "planes.png"]) copyFileSync(join(sourceRuns(), RUN, f), join(RUNS, RUN, f));
const HERE = process.env.OUT ? resolve(process.env.OUT) : join(tmpdir(), "datum-browser-workspace-regression");
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

  // 1. Open the reconstructed room.
  await send("Page.navigate", { url: URL_ });
  await waitFor(`!!document.querySelector('textarea[aria-label="Ask about your space"]')`, 30000, "workspace to load");
  await evaluate(PROBE);
  await waitFor("window.__findStore()", 10000, "the workspace store");
  await waitFor(`!!document.querySelector('canvas')`, 20000, "the 3D canvas");
  await evaluate(`window.__original = JSON.stringify(window.__store.getState().doc.scene); true`);
  const s1 = await snap();
  const room = await evaluate(`(() => { const sc = window.__store.getState().doc.scene; return { provenance: sc.provenance, objects: sc.objects.length, openings: sc.openings.map((o) => o.label), relationships: sc.relationships.length, footprint: sc.room.footprint, height: sc.room.height }; })()`);
  const shot0 = await screenshot("01-original");
  step(1, "Open the reconstructed room", room.provenance.kind === "reconstruction" && room.objects === 16 && room.relationships === 21 && s1.renderedIsDoc && s1.past.length === 0,
    { room, docHash: s1.docHash, renderedIsDoc: s1.renderedIsDoc, history: s1.past });

  // P5-1. The title block: honest extent, and two floors that are not the same thing.
  await sleep(600);
  const title0 = await evaluate(TITLE);
  step("P5-1", "Title block: extent no finer than known, free floor and circulation distinct", /^≈ 3\.7 × 6\.4 × 3\.0 m/.test(title0.Extent.text) && /estimated, not calibrated/.test(title0.Extent.text) && /depth is a stated default/.test(title0.Extent.text)
    && /^≈ 18 m² free · ≈ 7\.5 m² circulation/.test(title0.Floor.text) && /free: not under furniture/.test(title0.Floor.text) && !/as edited/.test(title0.Floor.text) && !/\d\.\d{2} m/.test(title0.Extent.text), title0);

  // P5-2. The inspector: sizes and space, for pieces seen whole, in part, not at all, and hung on a wall.
  const sofa = await inspect("sofa-0");
  const chair = await inspect("armchair-0");
  const tv = await inspect("television-0");
  const table = await inspect("coffee-table-0");
  await evaluate(`window.__store.select(null); true`);
  await sleep(300);
  const sAfterInspect = await snap();
  step("P5-2", "Inspector: honest sizes and a short Space section", sofa.sections.Identity.rows.Size.startsWith("≈ 2.2 × 0.90 × 0.95 m") && /width at least this/.test(sofa.sections.Identity.rows.Size)
    && sofa.sections.Space?.rows["In front"] && sofa.sections.Space.rows.Wall === "against the left wall estimated" && /at its narrowest, from the glazed door/.test(sofa.sections.Space.rows["Way in"] ?? "")
    && /typical \(not seen\)/.test(chair.sections.Identity.rows.Size) && /inferred/.test(chair.sections.Identity.rows.Size)
    && /^on the right wall/.test(tv.sections.Space?.rows.Wall ?? "") && !!tv.sections.Space.rows["Off floor"] && !tv.sections.Space.rows["Way in"]
    && !table.sections.Space.rows["In front"] && Object.keys(sofa.sections.Space.rows).length <= 4
    && sAfterInspect.docHash === s1.docHash && sAfterInspect.past.length === 0,
    { sofa: sofa.sections, armchair1: chair.sections.Identity.rows.Size, tv: tv.sections.Space, table: table.sections.Space, documentUntouched: sAfterInspect.docHash === s1.docHash, history: sAfterInspect.past });

  // 2–3. Three furniture layouts.
  await ask("Give me three furniture layouts.");
  const s2 = await snap();
  step(2, "Ask \"Give me three furniture layouts.\"", !!s2.design && s2.design.request === "Give me three furniture layouts.", { request: s2.design?.request, note: s2.command.note });
  const cards = await evaluate(`[...document.querySelectorAll('aside[aria-label="Design directions"] article')].map((a) => ({ title: a.querySelector('h3').textContent, measures: a.querySelector('p:nth-of-type(2)')?.textContent }))`);
  // The baseline for every pixel comparison below: the original room, with the cards now on screen.
  const base = await screenshot("01b-original-with-cards");
  const distinctPlans = new Set(s2.design.proposals.map((p) => p.changes.join("|"))).size;
  step(3, "Three proposals appear", cards.length === 3 && s2.design.proposals.length === 3 && distinctPlans === 3 && s2.design.proposals.every((p) => p.kinds.length === 1 && p.kinds[0] === "move") && s2.docHash === s1.docHash,
    { cardsOnScreen: cards, proposals: s2.design.proposals.map((p) => ({ title: p.title, changes: p.changes })), documentUntouched: s2.docHash === s1.docHash });

  // 4–5. Preview layout 1.
  await click(cardButton(0, "Preview"), "Preview on layout 1");
  await sleep(300);
  const s4 = await snap();
  const moves1 = await evaluate(`window.__moves(window.__original, JSON.stringify(window.__store.getState().scene))`);
  const shot1 = await screenshot("02-preview-layout-1");
  const pixels1 = changed(base, shot1);
  step(4, "Preview layout 1", s4.design.previewId === s4.design.proposals[0].id && s4.design.proposals[0].status === "preview", { previewId: s4.design.previewId, statuses: s4.design.proposals.map((p) => p.status) });
  step(5, "Furniture visibly moves/rotates; the document is untouched", moves1.length > 0 && s4.renderedHash !== s1.docHash && s4.docHash === s1.docHash && s4.past.length === 0 && pixels1 > 0.5,
    { piecesMovedInRenderedScene: moves1, screenPixelsChanged: `${pixels1}%`, documentHashUnchanged: s4.docHash === s1.docHash, renderedDiffersFromDocument: s4.renderedHash !== s4.docHash, history: s4.past });

  await sleep(700);
  const titlePreview = await evaluate(TITLE);
  step("P5-3", "Previewing a layout: the floor is measured on the design, and says so", /measured on the room as edited/.test(titlePreview.Floor.text) && !titlePreview.Floor.settling && titlePreview.Extent.text === title0.Extent.text, { before: title0.Floor.text, during: titlePreview.Floor.text });

  // 6–7. Exit preview.
  await click(cardButton(0, "Exit preview"), "Exit preview on layout 1");
  await sleep(300);
  const s6 = await snap();
  const exact = await evaluate(`JSON.stringify(window.__store.getState().scene) === window.__original && window.__store.getState().scene === window.__store.getState().doc.scene`);
  const shot2 = await screenshot("03-exit-preview");
  const pixelsBack = changed(base, shot2);
  step(6, "Exit preview", s6.design.previewId === null && s6.design.proposals.every((p) => p.status === "draft"), { previewId: s6.design.previewId, statuses: s6.design.proposals.map((p) => p.status) });
  step(7, "The original arrangement is restored exactly", exact && s6.renderedIsDoc && s6.renderedHash === s1.docHash && s6.docHash === s1.docHash,
    { renderedSceneIsTheDocumentsSceneObject: s6.renderedIsDoc, serializedEqualToOriginal: exact, screenPixelsDifferentFromOriginal: `${pixelsBack}%` });

  await sleep(700);
  const titleExit = await evaluate(TITLE);
  step("P5-4", "Exit preview: the floor reads as found again", titleExit.Floor.text === title0.Floor.text, { after: titleExit.Floor.text });

  // 8–10. Preview layout 2, apply it.
  await click(cardButton(1, "Preview"), "Preview on layout 2");
  await sleep(300);
  await evaluate(`window.__preview2 = JSON.stringify(window.__store.getState().scene); true`);
  const s8 = await snap();
  const moves2 = await evaluate(`window.__moves(window.__original, window.__preview2)`);
  step(8, "Preview layout 2", s8.design.previewId === s8.design.proposals[1].id && moves2.length > 0 && s8.docHash === s1.docHash, { title: s8.design.proposals[1].title, piecesMoved: moves2, documentUntouched: s8.docHash === s1.docHash });

  await click(cardButton(1, "Apply"), "Apply on layout 2");
  await sleep(300);
  await evaluate(`window.__applied = JSON.stringify(window.__store.getState().doc.scene); true`);
  const s9 = await snap();
  const appliedEqualsPreview = await evaluate(`window.__applied === window.__preview2`);
  const receiptText = await evaluate(`[...document.querySelectorAll('[role="status"]')].map((e) => e.textContent.trim()).filter(Boolean)`);
  step(9, "Apply layout 2: one history step", s9.past.length === 1 && s9.past[0] === s9.design.proposals[1].title && s9.future.length === 0 && appliedEqualsPreview && s9.design.appliedId === s9.design.proposals[1].id,
    { history: s9.past, documentEqualsWhatWasPreviewed: appliedEqualsPreview, statuses: s9.design.proposals.map((p) => `${p.title}: ${p.status}`), receipt: s9.receipt, onScreen: receiptText });

  const shot3 = await screenshot("04-layout-2-applied");
  const s10 = await snap();
  const stillApplied = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__applied && window.__store.getState().scene === window.__store.getState().doc.scene`);
  step(10, "Layout 2 remains applied", stillApplied && s10.past.length === 1 && s10.renderedIsDoc && s10.docHash !== s1.docHash, { documentStillLayout2: stillApplied, renderedIsDocument: s10.renderedIsDoc, screenPixelsChangedFromOriginal: `${changed(base, shot3)}%` });

  // 11–14. Undo and redo, with the toolbar buttons.
  await click(`() => document.querySelector('button[title="Undo (Ctrl+Z)"]')`, "Undo");
  await sleep(300);
  const s11 = await snap();
  step(11, "Undo", s11.past.length === 0 && s11.future.length === 1 && s11.future[0] === s9.past[0], { history: s11.past, redoable: s11.future });
  const undone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__original && window.__store.getState().scene === window.__store.getState().doc.scene`);
  const shot4 = await screenshot("05-undo");
  step(12, "The original arrangement returns exactly", undone && s11.docHash === s1.docHash, { serializedEqualToOriginal: undone, docHash: s11.docHash, originalHash: s1.docHash, screenPixelsDifferentFromOriginal: `${changed(base, shot4)}%` });

  await sleep(700);
  const titleUndo = await evaluate(TITLE);
  step("P5-5", "Undo: the floor reads as found again", titleUndo.Floor.text === title0.Floor.text, { afterUndo: titleUndo.Floor.text });

  await click(`() => document.querySelector('button[title="Redo (Ctrl+Shift+Z)"]')`, "Redo");
  await sleep(300);
  const s13 = await snap();
  step(13, "Redo", s13.past.length === 1 && s13.future.length === 0, { history: s13.past, redoable: s13.future });
  const redone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__applied && window.__store.getState().scene === window.__store.getState().doc.scene`);
  const shot5 = await screenshot("06-redo");
  step(14, "Layout 2 returns exactly", redone && s13.docHash === s10.docHash, { serializedEqualToApplied: redone, screenPixelsMatchingApplied: `${(100 - changed(shot3, shot5)).toFixed(2)}%` });

  // 15–16. More social.
  await evaluate(`window.__beforeSocial = JSON.stringify(window.__store.getState().doc.scene); true`);
  await ask("Make the seating more social.");
  const s15 = await snap();
  step(15, "Ask \"Make the seating more social.\"", !!s15.design && s15.design.request === "Make the seating more social." && s15.design.proposals.length > 0,
    { request: s15.design?.request, note: s15.command.note, proposals: s15.design?.proposals.map((p) => ({ title: p.title, kinds: p.kinds, changes: p.changes })), rejected: s15.design?.rejected });
  await click(cardButton(0, "Preview"), "Preview on the social layout");
  await sleep(300);
  const socialMoves = await evaluate(`window.__moves(window.__beforeSocial, JSON.stringify(window.__store.getState().scene))`);
  const s16 = await snap();
  const shot6 = await screenshot("07-social-preview");
  const socialPixels = changed(shot5, shot6);
  const docStill = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__beforeSocial`);
  step(16, "The social proposal changes the actual spatial arrangement", socialMoves.length > 0 && s16.design.proposals[0].kinds.every((k) => k === "move") && docStill && socialPixels > 0.5,
    { title: s16.design.proposals[0].title, piecesMoved: socialMoves, screenPixelsChanged: `${socialPixels}%`, documentUntouchedByPreview: docStill });
  await click(cardButton(0, "Exit preview"), "Exit the social preview");
  await sleep(300);

  // 17–18. A direct command stays a direct command.
  const designBefore = JSON.stringify((await snap()).design);
  const historyBefore = (await snap()).past;
  await ask("Move the sofa 20cm left.");
  const s17 = await snap();
  const noteOnScreen = await evaluate(`[...document.querySelectorAll('form[data-region="command"] [role="status"]')].map((e) => e.textContent.trim())`);
  step(17, "Ask \"Move the sofa 20cm left.\"", s17.command.note !== null, { commandAnswer: s17.command, onScreen: noteOnScreen });
  step(18, "It remains a direct Phase 3E command", JSON.stringify(s17.design) === designBefore && /can’t move left/.test(s17.command.note ?? "") && JSON.stringify(s17.past) === JSON.stringify(historyBefore),
    { answeredBy: "the Phase 3E interpreter (spatial.directional)", kind: s17.command.kind, note: s17.command.note, designSessionUnchanged: JSON.stringify(s17.design) === designBefore, historyUnchanged: s17.past });

  // 19–20. Ambiguity.
  await ask("Move the chair.");
  const s19 = await snap();
  const optionsOnScreen = await evaluate(`[...document.querySelectorAll('ul[aria-label="Which one"] button')].map((b) => b.textContent.trim())`);
  step(19, "Ask \"Move the chair.\"", s19.command.note !== null, { commandAnswer: s19.command });
  step(20, "Ambiguity handling intact", s19.command.kind === "ambiguous" && s19.command.options.length === 3 && optionsOnScreen.length === 3 && JSON.stringify(s19.design) === designBefore,
    { kind: s19.command.kind, note: s19.command.note, options: s19.command.options, buttonsOnScreen: optionsOnScreen });

  // Beyond the 21: a direct command that can be carried out is still offered as a command proposal.
  await ask("Move the sofa forward 20 cm");
  const extra = await snap();
  say("\n[extra] \"Move the sofa forward 20 cm\":", { proposal: extra.proposal, designSessionUnchanged: JSON.stringify(extra.design) === designBefore });

  // Layout: the rail and the title block, at desktop and phone widths, with directions on screen.
  const LAYOUT = `(() => {
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right), shown: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0 }; };
    const rail = document.querySelector('aside[aria-label="Design directions"]');
    const block = document.querySelector('main[data-region="stage"] dl');
    const stage = document.querySelector('main[data-region="stage"]');
    const canvas = document.querySelector('main[data-region="stage"] canvas');
    const r = rect(rail), b = rect(block), s = rect(stage);
    const overlap = r && b && r.shown && b.shown ? Math.max(0, Math.min(r.right, b.right) - Math.max(r.x, b.x)) * Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.y, b.y)) : 0;
    // Readable: at nine points spread over the block, nothing is drawn above it.
    let coveredBy = [];
    if (b && b.shown) {
      for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
        const at = document.elementsFromPoint(b.x + b.w * fx, b.y + b.h * fy);
        const i = at.findIndex((e) => e === block || block.contains(e));
        const above = at.slice(0, i < 0 ? 0 : i).filter((e) => !block.contains(e));
        for (const e of above) if (!coveredBy.includes(e.tagName + "." + e.className)) coveredBy.push(e.tagName + "." + e.className);
      }
    }
    const cards = rail ? [...rail.querySelectorAll("article")].map((a) => { const x = a.getBoundingClientRect(); const list = rail.querySelector("ul").getBoundingClientRect(); return { title: a.querySelector("h3").textContent, fullyVisible: x.top >= list.top - 1 && x.bottom <= list.bottom + 1 }; }) : [];
    return { viewport: [innerWidth, innerHeight], stage: s, rail: r, titleBlock: b, overlapPx: overlap, coveredBy, cards, railShareOfStageWidth: r && s ? +(r.w / s.w * 100).toFixed(1) : null, horizontalScroll: document.documentElement.scrollWidth > innerWidth, blockText: block ? block.innerText.replace(/\\s+/g, " ").slice(0, 160) : null };
  })()`;
  const layouts = {};
  for (const [label, width, height, mobile] of [["desktop 1440×900", 1440, 900, false], ["desktop 1280×720", 1280, 720, false], ["desktop 1920×1080", 1920, 1080, false], ["tablet 820×1180", 820, 1180, true], ["phone 390×844", 390, 844, true], ["phone 360×740", 360, 740, true]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await sleep(1800);
    layouts[label] = await evaluate(LAYOUT);
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(HERE, `layout-${label.replace(/[^a-z0-9]+/gi, "-")}.png`), Buffer.from(data, "base64"));
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const [label, l] of Object.entries(layouts)) {
    const desktop = !label.startsWith("phone") && !label.startsWith("tablet");
    const ok = l.overlapPx === 0 && l.coveredBy.length === 0 && !l.horizontalScroll && (desktop ? l.titleBlock?.shown && l.rail?.shown : l.rail?.shown && !l.titleBlock?.shown);
    say(`\n[${ok ? "PASS" : "FAIL"}] layout ${label}`, { rail: l.rail, titleBlock: l.titleBlock, overlapPx: l.overlapPx, coveredBy: l.coveredBy, railShareOfStageWidth: l.railShareOfStageWidth, cards: l.cards, horizontalScroll: l.horizontalScroll, blockText: l.blockText });
    results.push({ n: `layout ${label}`, name: label, pass: ok, evidence: l });
  }

  // 21. Console.
  await sleep(1000);
  const errors = consoleMessages.filter((m) => m.level === "error");
  const warnings = consoleMessages.filter((m) => m.level === "warning" || m.level === "warn");
  step(21, "No console errors", errors.length === 0, { errors, warnings, allMessages: consoleMessages.length });
} catch (error) {
  say("\nDRIVER FAILURE:", String(error?.stack ?? error));
  results.push({ n: 0, name: "driver", pass: false, evidence: String(error) });
} finally {
  say("\nconsole messages:", consoleMessages);
  say("\nSUMMARY", results.map((r) => `${r.n}:${r.pass ? "PASS" : "FAIL"}`).join(" "));
  writeFileSync(join(HERE, "result.json"), JSON.stringify({ results, consoleMessages }, null, 2));
  writeFileSync(join(HERE, "log.txt"), log.join("\n"));
  try { await send("Browser.close"); } catch {}
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {} // Chrome may still hold its profile; it is in the temp directory.
  console.log(`\nscreenshots, log.txt and result.json: ${HERE}`);
  process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
}
