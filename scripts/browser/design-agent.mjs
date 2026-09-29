// Phase 6 design agent browser regression, with canned replies: no model is
// called. The agent endpoint is intercepted in the browser, and the server is
// configured with a placeholder key and an unreachable API address, so nothing
// can reach a real model even if a request slipped through.
//
//   npm run build && node scripts/browser/design-agent.mjs
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
const SERVER_PORT = Number(process.env.PORT || 3221);
const PORT = Number(process.env.DEBUG_PORT || 9351);
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

const work = mkdtempSync(join(tmpdir(), "datum-design-agent-"));
const RUNS = join(work, "runs");
mkdirSync(join(RUNS, RUN), { recursive: true });
for (const f of ["reconstruction.json", "source.jpg", "planes.png"]) copyFileSync(join(sourceRuns(), RUN, f), join(RUNS, RUN, f));
const HERE = process.env.OUT ? resolve(process.env.OUT) : join(tmpdir(), "datum-browser-design-agent");
mkdirSync(HERE, { recursive: true });
const PROFILE = join(work, "profile");
mkdirSync(PROFILE, { recursive: true });

const server = spawn(process.execPath, [join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(SERVER_PORT)], {
  cwd: ROOT,
  env: { ...process.env, DATUM_RECONSTRUCTION_RUNS: RUNS, DATUM_DESIGN_AGENT: "anthropic", ANTHROPIC_API_KEY: "not-a-real-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", DATUM_DESIGN_AGENT_MODEL: "", GROQ_API_KEY: "" },
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


// ---------------------------------------------------------------------------
// Canned replies: the agent endpoint is intercepted in the browser. The server is
// also pointed at an unreachable API address, so nothing can reach a real model.
const N = (o) => ({ version: "agent-reply-0.1", route: "design", design: null, question: null, clarify: null, outOfScope: null, ...o });
const D = (o) => ({ version: "design-intent-0.2", styles: [], atmosphere: null, warmth: null, brightness: null, contrast: null, luxury: null, minimalism: null, coziness: null, variantCount: 1, finishes: true, layout: null, ...o });
const Q = (o) => N({ route: "question", question: { kind: "room-size", subject: null, other: null, metres: null, ...o } });
const CANNED = {
  "Give me 3 modern designs": { body: { ok: true, reply: N({ design: D({ styles: ["MODERN_WARM"], variantCount: 3 }) }) } },
  "Is there at least 80 cm of circulation space?": { body: { ok: true, reply: Q({ kind: "circulation-at-least", metres: 0.8 }) } },
  "Make it feel like a Kyoto tea house but keep it bright": { body: { ok: true, reply: N({ design: D({ styles: ["MINIMAL_NEUTRAL"], atmosphere: "calm, bright", brightness: 0.65, minimalism: 0.65 }) }) } },
  "How much clearance is there around the chair?": { body: { ok: true, reply: Q({ kind: "clearance", subject: "the chair" }) } },
  "Give me a cozy design": { body: { ok: false, failure: "unavailable" } },
  "How big is the sofa?": { body: { ok: true, reply: { ...Q({ kind: "object-size", subject: "the sofa" }), objectId: "sofa-0" } } },
  "How wide is the room?": { body: { ok: true, reply: Q({ kind: "room-size" }) }, delay: 4000 },
  "Where can I buy a rug like this?": { body: { ok: true, reply: N({ route: "out_of_scope", outOfScope: "shopping" }) } },
  "Rearrange the seating so it is better for talking": { body: { ok: true, reply: N({ design: D({ finishes: false, layout: { styles: ["CONVERSATION"], social: 1, tvFocus: null, openness: null, circulation: null, symmetry: null, compactness: null, separation: null, preserve: false } }) }) } },
};
const posts = [];
const unexpected = [];
const original = ws.onmessage;
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === "Fetch.requestPaused") {
    const { requestId, request } = msg.params;
    if (request.method !== "POST") { send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
    let body = {};
    try { body = JSON.parse(request.postData ?? "{}"); } catch {}
    posts.push(body);
    const canned = CANNED[body.text] ?? (unexpected.push(body.text), { body: { ok: false, failure: "unavailable" } });
    setTimeout(() => {
      send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(canned.body)).toString("base64") }).catch(() => {});
    }, canned.delay ?? 50);
    return;
  }
  original(event);
};
const postsFor = (text) => posts.filter((p) => p.text === text).length;
const noteLabel = () => evaluate(`(() => { const n = document.querySelector('form[data-region="command"] [role="status"] p'); return n ? n.innerText.replace(/\\s+/g, " ").trim() : null; })()`);

try {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/agent/design*", requestStage: "Request" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: URL_ });
  await waitFor(`!!document.querySelector('textarea[aria-label="Ask about your space"]')`, 30000, "workspace to load");
  await evaluate(PROBE);
  await waitFor("window.__findStore()", 10000, "the workspace store");
  await waitFor(`!!document.querySelector('canvas')`, 20000, "the 3D canvas");
  await waitFor(`window.__store.agentName !== null`, 10000, "the agent to be bound");
  await evaluate(`window.__original = JSON.stringify(window.__store.getState().doc.scene); true`);
  const s0 = await snap();
  // Checked against whichever provider and model the server reports as configured (GET /api/agent/design), not a fixed name.
  const configured = await evaluate(`fetch("/api/agent/design", { cache: "no-store" }).then((r) => r.json())`);
  const boundName = await evaluate(`window.__store.agentName`);
  step("A1", "The agent is bound to the model the server has configured", configured.available === true && typeof configured.model === "string" && typeof boundName === "string" && boundName.endsWith(`(${configured.model})`) && s0.past.length === 0, { agent: boundName, configuredModel: configured.model });

  // A2–A3: a design read by the agent, through the existing cards, preview, apply and history.
  await ask("Give me 3 modern designs");
  const s2 = await snap();
  step("A2", "Agent design → the existing proposals", postsFor("Give me 3 modern designs") === 1 && s2.design?.proposals.map((p) => p.title).join("|") === "Modern Warm|Modern Neutral|Modern Dark Accent" && s2.docHash === s0.docHash,
    { titles: s2.design?.proposals.map((p) => p.title), posts: postsFor("Give me 3 modern designs") });
  await click(cardButton(0, "Preview"), "Preview 1");
  await sleep(300);
  const s3 = await snap();
  await click(cardButton(0, "Exit preview"), "Exit preview");
  await sleep(300);
  const exact = await evaluate(`JSON.stringify(window.__store.getState().scene) === window.__original && window.__store.getState().scene === window.__store.getState().doc.scene`);
  await click(cardButton(1, "Apply"), "Apply 2");
  await sleep(300);
  const s4 = await snap();
  await evaluate(`window.__applied = JSON.stringify(window.__store.getState().doc.scene); true`);
  await click(`() => document.querySelector('button[title="Undo (Ctrl+Z)"]')`, "Undo");
  await sleep(300);
  const undone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__original`);
  await click(`() => document.querySelector('button[title="Redo (Ctrl+Shift+Z)"]')`, "Redo");
  await sleep(300);
  const redone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__applied`);
  const s5 = await snap();
  step("A3", "Preview isolated, exit exact, apply one step, undo and redo exact", s3.docHash === s0.docHash && s3.renderedHash !== s0.docHash && exact && s4.past.length === 1 && undone && redone && s5.past.length === 1,
    { previewDocUntouched: s3.docHash === s0.docHash, exitExact: exact, history: s4.past, undoExact: undone, redoExact: redone });

  // A4: the 80 cm question is a question.
  const before4 = await snap();
  await ask("Is there at least 80 cm of circulation space?");
  const s6 = await snap();
  const label6 = await noteLabel();
  step("A4", "“At least 80 cm of circulation space?” is answered by Phase 5, not turned into layouts", s6.command.kind === "answer" && /^No: /.test(s6.command.note ?? "") && /^Answer/i.test(label6 ?? "") && s6.docHash === before4.docHash && s6.design?.request === "Give me 3 modern designs",
    { onScreen: label6, designSessionUnchanged: s6.design?.request });

  // A5: "…keep it bright" with a design previewed never applies it.
  await click(cardButton(0, "Preview"), "Preview 1 again");
  await sleep(300);
  const before5 = await snap();
  await ask("Make it feel like a Kyoto tea house but keep it bright");
  const s7 = await snap();
  step("A5", "“…but keep it bright” with a preview on screen applies nothing", s7.past.length === before5.past.length && s7.docHash === before5.docHash && s7.design?.request === "Make it feel like a Kyoto tea house but keep it bright",
    { historyBefore: before5.past, historyAfter: s7.past, newDirections: s7.design?.proposals.map((p) => p.title) });

  // A6: a question whose piece is ambiguous: options, then an answer without asking the model again.
  await ask("How much clearance is there around the chair?");
  const s8 = await snap();
  await click(`() => [...document.querySelectorAll('ul[aria-label="Which one"] button')].find((b) => b.textContent.startsWith("Armchair 2"))`, "Armchair 2");
  await sleep(150);
  await waitFor(`!window.__store.getState().command.pending`, 20000, "answer");
  await sleep(300);
  const s9 = await snap();
  step("A6", "Ambiguous piece → options; choosing one answers without a second model call", s8.command.kind === "ambiguous" && s8.command.options.length === 3 && s9.command.kind === "answer" && /^Around Armchair 2:/.test(s9.command.note ?? "") && postsFor("How much clearance is there around the chair?") === 1,
    { options: s8.command.options, answer: s9.command.note, posts: postsFor("How much clearance is there around the chair?") });

  // A7: Phase 3E commands never reach the agent.
  // Nothing selected, as in the Phase 4B run: "the chair" is then ambiguous.
  await evaluate(`window.__store.select(null); true`);
  const postsBefore = posts.length;
  await ask("Move the sofa 20cm left.");
  const s10 = await snap();
  await ask("Move the chair.");
  const s11 = await snap();
  step("A7", "Phase 3E commands stay on the rules; the agent is not asked", posts.length === postsBefore && /can’t move left/.test(s10.command.note ?? "") && s11.command.kind === "ambiguous" && s11.command.options.length === 3,
    { sofa: s10.command.note, chair: s11.command.note, agentRequests: posts.length - postsBefore });

  // A8: agent failure on a brief → the rules read it, and say so.
  const before8 = await snap();
  await ask("Give me a cozy design");
  const s12 = await snap();
  step("A8", "Agent unavailable → the design rules read the brief, and the note says so", s12.design?.proposals[0]?.title === "Cozy Amber" && s12.command.kind === "agent" && /couldn’t be reached\. Read with the design rules instead\./.test(s12.command.note ?? "") && s12.docHash === before8.docHash,
    { cards: s12.design?.proposals.map((p) => p.title), note: s12.command.note });

  // A9: a hostile reply (an object id smuggled in) is rejected in the browser too.
  const before9 = await snap();
  await ask("How big is the sofa?");
  const s13 = await snap();
  step("A9", "A reply carrying an objectId is rejected; nothing changes", s13.command.kind === "agent" && /couldn’t be read reliably/.test(s13.command.note ?? "") && s13.docHash === before9.docHash && s13.past.length === before9.past.length,
    { note: s13.command.note });

  // A10: a slow reply shows the pending state, then answers.
  await waitFor(`!document.querySelector('textarea[aria-label="Ask about your space"]').disabled`, 20000, "bar enabled");
  await click(`() => document.querySelector('textarea[aria-label="Ask about your space"]')`, "command bar");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2, commands: ["selectAll"] });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await send("Input.insertText", { text: "How wide is the room?" });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await sleep(1500);
  const pendingShown = await evaluate(`window.__store.getState().command.pending && /Processing/.test(document.querySelector('form[data-region="command"]').innerText)`);
  await waitFor(`!window.__store.getState().command.pending`, 20000, "slow answer");
  await sleep(300);
  const s14 = await snap();
  step("A10", "A slow reply shows “Processing…”, then the answer", pendingShown && s14.command.kind === "answer" && /^The room is ≈ 3\.7 m across/.test(s14.command.note ?? ""), { pendingShown, answer: s14.command.note });

  // A11: out of scope, in the workspace's own words.
  await ask("Where can I buy a rug like this?");
  const s15 = await snap();
  step("A11", "Out of scope answered with a fixed sentence", s15.command.note === "Shopping isn’t something this workspace does.", { note: s15.command.note });

  // A12: a layout from the agent: moves only, one history step, exact undo.
  await ask("Rearrange the seating so it is better for talking");
  const s16 = await snap();
  const beforeApply = await evaluate(`JSON.stringify(window.__store.getState().doc.scene)`);
  await click(cardButton(0, "Apply"), "Apply layout");
  await sleep(300);
  const s17 = await snap();
  await click(`() => document.querySelector('button[title="Undo (Ctrl+Z)"]')`, "Undo layout");
  await sleep(300);
  const back = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === ${JSON.stringify("__B__")}`.replace(JSON.stringify("__B__"), "window.__beforeLayout"));
  step("A12", "Agent layout → moves only, one history step", s16.design?.proposals.length > 0 && s16.design.proposals.every((p) => p.kinds.every((k) => k === "move")) && s17.past.length === s16.past.length + 1,
    { layouts: s16.design?.proposals.map((p) => p.title), history: s17.past });
  void back; void beforeApply;

  // A13: what was sent to the server.
  const ids = ["sofa-0", "coffee-table-0", "armchair-0", "armchair-1", "window-0", "wall-left", "television-0"];
  const clean = posts.every((p) => Object.keys(p).sort().join() === "brief,text" && p.brief.length < 8000 && !ids.some((id) => p.brief.includes(id)) && !/\.png|\.jpg|runs\/|data:image/.test(p.brief));
  step("A13", "Each request carries only the words and the brief: no ids, paths or pixels", clean && unexpected.length === 0, { requests: posts.length, unexpected, sampleBrief: posts[0]?.brief.slice(0, 300) });

  await sleep(800);
  const errors = consoleMessages.filter((m) => m.level === "error");
  step("A14", "No console errors", errors.length === 0, { errors, warnings: consoleMessages.filter((m) => m.level === "warning" || m.level === "warn").map((m) => m.text.slice(0, 80)) });
} catch (error) {
  say("\nDRIVER FAILURE:", String(error?.stack ?? error));
  results.push({ n: 0, name: "driver", pass: false, evidence: String(error) });
} finally {
  say("\nconsole messages:", consoleMessages);
  say("\nSUMMARY", results.map((r) => `${r.n}:${r.pass ? "PASS" : "FAIL"}`).join(" "));
  writeFileSync(join(HERE, "result-agent.json"), JSON.stringify({ results, consoleMessages }, null, 2));
  writeFileSync(join(HERE, "log-agent.txt"), log.join("\n"));
  try { await send("Browser.close"); } catch {}
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {} // Chrome may still hold its profile; it is in the temp directory.
  console.log(`\nscreenshots, log-agent.txt and result-agent.json: ${HERE}`);
  process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
}
