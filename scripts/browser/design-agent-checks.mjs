// Phase 9 design agent browser regression: checks on a design's new
// directions, and questions about the directions on screen, with canned
// replies: no model is called. The agent endpoint is intercepted in the
// browser, and the server is configured with a placeholder key and an
// unreachable API address, so nothing can reach a real model even if a
// request slipped through.
//
//   npm run build && node scripts/browser/design-agent-checks.mjs
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
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUN = process.env.RUN || "20260922T065240Z-2d25a689";
const SERVER_PORT = Number(process.env.PORT || 3222);
const PORT = Number(process.env.DEBUG_PORT || 9352);
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

const work = mkdtempSync(join(tmpdir(), "datum-design-agent-checks-"));
const RUNS = join(work, "runs");
mkdirSync(join(RUNS, RUN), { recursive: true });
for (const f of ["reconstruction.json", "source.jpg", "planes.png"]) copyFileSync(join(sourceRuns(), RUN, f), join(RUNS, RUN, f));
const HERE = process.env.OUT ? resolve(process.env.OUT) : join(tmpdir(), "datum-browser-design-agent-checks");
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
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
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
// Canned replies: the agent endpoint is intercepted in the browser. The server is
// also pointed at an unreachable API address, so nothing can reach a real model.
// Every reply is 0.2 (Phase 9) but one, which is 0.1 (Phase 6) and must still read.
const R = (o) => ({ version: "agent-reply-0.2", route: "design", design: null, checks: null, question: null, directions: null, clarify: null, outOfScope: null, ...o });
const R01 = (o) => ({ version: "agent-reply-0.1", route: "design", design: null, question: null, clarify: null, outOfScope: null, ...o });
const D = (o) => ({ version: "design-intent-0.2", styles: [], atmosphere: null, warmth: null, brightness: null, contrast: null, luxury: null, minimalism: null, coziness: null, variantCount: 1, finishes: true, layout: null, ...o });
const Q = (kind, o = {}) => ({ kind, subject: null, other: null, metres: null, ...o });
// Exactly the rules' own reading of "Give me three furniture layouts".
const LAYOUTS = D({ variantCount: 3, finishes: false, layout: { styles: [], social: null, tvFocus: null, openness: null, circulation: null, symmetry: null, compactness: null, separation: null, preserve: false } });

const T = {
  plain: "Give me three furniture layouts",
  checked: "Give me three layouts that keep at least 80 cm of circulation, and tell me which leaves the most circulation area",
  compare: "Which layout leaves the most circulation area?",
  one: "Does the third layout keep at least 80 cm to every seat?",
  chair: "Which layout leaves the widest way to the chair?",
  check: "Check the second one",
  modern: "Give me 3 modern designs",
  floor: "Which design leaves the most free floor?",
};
const CANNED = {
  [T.plain]: { body: { ok: true, reply: R({ design: LAYOUTS }) } },
  [T.checked]: { body: { ok: true, reply: R({ design: LAYOUTS, checks: [Q("circulation-at-least", { metres: 0.8 }), Q("circulation-area")] }) } },
  [T.compare]: { body: { ok: true, reply: R({ route: "question", question: Q("circulation-area"), directions: [1, 2, 3] }) } },
  [T.one]: { body: { ok: true, reply: R({ route: "question", question: Q("circulation-at-least", { metres: 0.8 }), directions: [3] }) } },
  [T.chair]: { body: { ok: true, reply: R({ route: "question", question: Q("walkway", { subject: "the chair" }), directions: [1, 2, 3] }) } },
  [T.check]: { body: { ok: true, reply: R({ route: "question", question: Q("free-floor"), directions: [2] }) } },
  [T.modern]: { body: { ok: true, reply: R01({ design: D({ styles: ["MODERN_WARM"], variantCount: 3 }) }) } },
  [T.floor]: { body: { ok: true, reply: R({ route: "question", question: Q("free-floor"), directions: [1, 2, 3] }) } },
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

/** What each card shows under "Measured on this direction", by card. */
const CARD_CHECKS = `[...document.querySelectorAll('aside[aria-label="Design directions"] article')].map((a) => [...a.querySelectorAll('ul[aria-label="Measured on this direction"] li')].map((li) => li.textContent.trim()))`;
const STALE = `document.querySelector('aside[aria-label="Design directions"] p[role="note"]')?.textContent.trim() ?? null`;
const STALE_TEXT = "What was measured on each direction described the room before its last change, so it is no longer shown. Ask again to measure the room as it is now.";
const opsOf = `JSON.stringify(window.__store.getState().design.proposals.map((p) => [p.id, p.title, p.operations]))`;

async function shot(name) {
  await sleep(1500);
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(HERE, `${name}.png`), Buffer.from(data, "base64"));
}

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
  const configured = await evaluate(`fetch("/api/agent/design", { cache: "no-store" }).then((r) => r.json())`);
  const boundName = await evaluate(`window.__store.agentName`);
  step("P1", "The agent is bound to the model the server has configured", configured.available === true && boundName.endsWith(`(${configured.model})`) && s0.past.length === 0, { agent: boundName });

  // P2: a plain layout request: three cards, nothing measured on them.
  await ask(T.plain);
  const s2 = await snap();
  const plainOps = await evaluate(opsOf);
  const plainChecks = await evaluate(CARD_CHECKS);
  step("P2", "A plain request: the three layouts, with nothing measured on the cards", s2.design?.proposals.map((p) => p.title).join("|") === "Around the television|Conversation around the coffee table|Open floor" && plainChecks.every((c) => c.length === 0),
    { titles: s2.design?.proposals.map((p) => p.title), checks: plainChecks });

  // P3: the same layouts with checks: byte-identical plans, a line per check on each card, the room untouched.
  await ask(T.checked);
  const s3 = await snap();
  const checkedOps = await evaluate(opsOf);
  const cards = await evaluate(CARD_CHECKS);
  const noCheckInProposal = await evaluate(`window.__store.getState().design.proposals.every((p) => !("checks" in p))`);
  const label3 = await noteLabel();
  const expectedCards = [
    ["At least 80 cm to every seat: no (narrowest ≈ 0.55 m)", "Circulation area ≈ 8 m²"],
    ["At least 80 cm to every seat: no (narrowest ≈ 0.55 m)", "Circulation area ≈ 8 m²"],
    ["At least 80 cm to every seat: too close to call (narrowest ≈ 0.8 m)", "Circulation area ≈ 9 m²"],
  ];
  step("P3", "Checks: the same plans byte for byte, each card's measured lines, the note, and nothing applied",
    checkedOps === plainOps && noCheckInProposal && JSON.stringify(cards) === JSON.stringify(expectedCards) && /^Answer/i.test(label3 ?? "") &&
      /^Measured on each new direction: At least 80 cm to every seat: no for 1 and 2; too close to call for 3\. Open floor leaves the most circulation area; the others cannot be meaningfully told apart\./.test(s3.command.note ?? "") &&
      s3.docHash === s0.docHash && s3.past.length === 0 && s3.design.previewId === null,
    { samePlans: checkedOps === plainOps, cards, note: s3.command.note, label: label3 });
  await shot("p9-01-checked-cards");

  // P4: preview works as before, and the lines stay while the room is the room they were measured on.
  await click(cardButton(2, "Preview"), "Preview 3");
  await sleep(300);
  const s4 = await snap();
  const cards4 = await evaluate(CARD_CHECKS);
  step("P4", "Preview lays the direction over the room; the document is untouched; the lines stay", s4.design.previewId === s4.design.proposals[2].id && s4.renderedHash !== s0.docHash && s4.docHash === s0.docHash && JSON.stringify(cards4) === JSON.stringify(expectedCards),
    { previewId: s4.design.previewId });
  await shot("p9-02-preview-with-checks");

  // P5: a question about every direction, asked during a preview: answered, and nothing else moves.
  await evaluate(`window.__design = window.__store.getState().design; window.__doc = window.__store.getState().doc; true`);
  await ask(T.compare);
  const s5 = await snap();
  const same5 = await evaluate(`window.__store.getState().design === window.__design && window.__store.getState().doc === window.__doc`);
  step("P5", "“Which layout leaves the most circulation area?”: measured on each; the session, preview, document and history untouched",
    postsFor(T.compare) === 1 && same5 && s5.design.previewId === s4.design.previewId && s5.docHash === s0.docHash && s5.past.length === 0 && s5.command.kind === "answer" &&
      (s5.command.note ?? "").includes("3. Open floor ≈ 9 m² (default, as edited). Open floor leaves the most circulation area; the others cannot be meaningfully told apart."),
    { note: s5.command.note, sessionAndDocumentSameObjects: same5 });

  // P6: one direction: Phase 5's own sentence, measured on it.
  await ask(T.one);
  const s6 = await snap();
  step("P6", "One direction: Phase 5's own answer, on that direction", /^3\. Open floor, laid over the room as its preview shows it: Too close to call against 80 cm/.test(s6.command.note ?? ""), { note: s6.command.note });

  // P7: a name that fits several pieces: asked back, then measured without asking the model again.
  await ask(T.chair);
  const s7 = await snap();
  const options = await evaluate(`[...document.querySelectorAll('ul[aria-label="Which one"] button')].map((b) => b.textContent.trim())`);
  await click(`() => [...document.querySelectorAll('ul[aria-label="Which one"] button')].find((b) => b.textContent.startsWith("Armchair 2"))`, "Armchair 2");
  await sleep(150);
  await waitFor(`!window.__store.getState().command.pending`, 20000, "answer");
  await sleep(300);
  const s7b = await snap();
  step("P7", "Ambiguous piece → options; choosing one measures every direction without a second model call",
    s7.command.kind === "ambiguous" && options.length === 3 && /^Way to Armchair 2, with each direction laid over the room/.test(s7b.command.note ?? "") && postsFor(T.chair) === 1,
    { options, note: s7b.command.note, posts: postsFor(T.chair) });

  // P8: "check the second one" is measured, not previewed.
  await evaluate(`window.__store.select(null); true`);
  await click(cardButton(2, "Exit preview"), "Exit preview");
  await sleep(300);
  const before8 = await snap();
  await ask(T.check);
  const s8 = await snap();
  step("P8", "“Check the second one” goes to the agent and is measured, not previewed", before8.design.previewId === null && s8.design.previewId === null && postsFor(T.check) === 1 && /^2\. Conversation around the coffee table, laid over the room as its preview shows it: Free floor/.test(s8.command.note ?? ""),
    { note: s8.command.note, previewId: s8.design.previewId });

  // P9: applying a checked direction: one history step, exact undo; the lines no longer describe the room, and say so.
  await click(cardButton(2, "Apply"), "Apply 3");
  await sleep(300);
  const s9 = await snap();
  const cards9 = await evaluate(CARD_CHECKS);
  const stale9 = await evaluate(STALE);
  await click(`() => document.querySelector('button[title="Undo (Ctrl+Z)"]')`, "Undo");
  await sleep(300);
  const undone = await evaluate(`JSON.stringify(window.__store.getState().doc.scene) === window.__original`);
  step("P9", "Apply: one history step and exact undo; the lines are withdrawn once the room has changed, with a note saying why",
    s9.past.length === 1 && s9.past[0] === "Open floor" && undone && cards9.every((c) => c.length === 0) && stale9 === STALE_TEXT,
    { history: s9.past, undoExact: undone, stale: stale9 });

  // P10: a Phase 6 (0.1) reply still reads: finish designs, no lines, no stale note.
  await ask(T.modern);
  const s10 = await snap();
  step("P10", "A Phase 6 (agent-reply-0.1) reply reads exactly as before", s10.design?.proposals.map((p) => p.title).join("|") === "Modern Warm|Modern Neutral|Modern Dark Accent" && (await evaluate(CARD_CHECKS)).every((c) => c.length === 0) && (await evaluate(STALE)) === null,
    { titles: s10.design?.proposals.map((p) => p.title) });

  // P11: finish directions leave the floor as it was: said to be indistinguishable, never ranked.
  await ask(T.floor);
  const s11 = await snap();
  step("P11", "Directions that cannot be told apart are said to be so", (s11.command.note ?? "").includes("No one direction can be meaningfully told apart from all the others on free floor") && !/\b(best|better|score|rank)/i.test(s11.command.note ?? ""),
    { note: s11.command.note });

  // P12: the lines at desktop and phone widths: no overflow, no horizontal scroll, the rail clear of the title block.
  await ask(T.checked);
  const LAYOUT = `(() => {
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, shown: cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0 }; };
    const rail = rect(document.querySelector('aside[aria-label="Design directions"]'));
    const block = rect(document.querySelector('main[data-region="stage"] dl'));
    const overlap = rail && block && rail.shown && block.shown ? Math.max(0, Math.min(rail.right, block.right) - Math.max(rail.x, block.x)) * Math.max(0, Math.min(rail.bottom, block.bottom) - Math.max(rail.y, block.y)) : 0;
    const lists = [...document.querySelectorAll('ul[aria-label="Measured on this direction"]')];
    return { lists: lists.length, overflowing: lists.filter((l) => l.scrollWidth > l.clientWidth + 1).length, horizontalScroll: document.documentElement.scrollWidth > innerWidth, overlap: Math.round(overlap), railShown: !!rail?.shown };
  })()`;
  const layouts = {};
  for (const [label, width, height, mobile] of [["desktop 1440×900", 1440, 900, false], ["desktop 1280×720", 1280, 720, false], ["phone 390×844", 390, 844, true]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
    await sleep(1500);
    layouts[label] = await evaluate(LAYOUT);
    await shot(`p9-layout-${label.replace(/[^a-z0-9]+/gi, "-")}`);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  step("P12", "The measured lines fit their cards at desktop and phone widths, with no overlap or horizontal scroll",
    Object.values(layouts).every((l) => l.railShown && l.lists === 3 && l.overflowing === 0 && !l.horizontalScroll && l.overlap === 0), layouts);

  // P13: what was sent to the server.
  const ids = ["sofa-0", "coffee-table-0", "armchair-0", "armchair-1", "window-0", "wall-left", "television-0"];
  const clean = posts.every((p) => Object.keys(p).sort().join() === "brief,text" && p.brief.length < 8000 && !ids.some((id) => p.brief.includes(id)) && !/\.png|\.jpg|runs\/|data:image/.test(p.brief));
  const compareBrief = posts.find((p) => p.text === T.compare)?.brief ?? "";
  step("P13", "Each request carries only the words and the brief — the directions on screen by title, no ids, paths or pixels",
    clean && unexpected.length === 0 && compareBrief.includes("Directions on screen now: 1. Around the television; 2. Conversation around the coffee table; 3. Open floor."),
    { requests: posts.length, unexpected });

  await sleep(800);
  const errors = consoleMessages.filter((m) => m.level === "error");
  step("P14", "No console errors", errors.length === 0, { errors, warnings: consoleMessages.filter((m) => m.level === "warning" || m.level === "warn").map((m) => m.text.slice(0, 80)) });
} catch (error) {
  say("\nDRIVER FAILURE:", String(error?.stack ?? error));
  results.push({ n: 0, name: "driver", pass: false, evidence: String(error) });
} finally {
  say("\nconsole messages:", consoleMessages);
  say("\nSUMMARY", results.map((r) => `${r.n}:${r.pass ? "PASS" : "FAIL"}`).join(" "));
  writeFileSync(join(HERE, "result-checks.json"), JSON.stringify({ results, consoleMessages }, null, 2));
  writeFileSync(join(HERE, "log-checks.txt"), log.join("\n"));
  try { await send("Browser.close"); } catch {}
  ws.close();
  chrome.kill();
  server.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch {} // Chrome may still hold its profile; it is in the temp directory.
  console.log(`\nscreenshots, log-checks.txt and result-checks.json: ${HERE}`);
  process.exit(results.length > 0 && results.every((r) => r.pass) ? 0 : 1);
}
