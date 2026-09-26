import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadRun } from "./loadRun";
import { readRunFile } from "./localRuns";

/**
 * A run's optional calibration.
 *
 * Most runs have none, and that is not a fault: the route answers 204 and
 * the loader goes on with the scale estimated, reporting nothing. A run that
 * does not exist is still 404; a calibration that exists but cannot be
 * fetched, read or understood is reported — in the console and to the
 * workspace — rather than being quietly treated as "not calibrated".
 */

const FIXTURE = new URL("../../../scene/compile/__fixtures__/download-png.intermediate.json", import.meta.url);
const RUN = "20260922T065240Z-2d25a689";

describe("the run file route", () => {
  let dir = "";
  const previous = process.env.DATUM_RECONSTRUCTION_RUNS;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "datum-runs-"));
    mkdirSync(join(dir, "uncalibrated"));
    writeFileSync(join(dir, "uncalibrated", "reconstruction.json"), "{}");
    mkdirSync(join(dir, "calibrated"));
    writeFileSync(join(dir, "calibrated", "calibration.json"), JSON.stringify({ schemaVersion: 1, references: [] }));
    process.env.DATUM_RECONSTRUCTION_RUNS = dir;
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DATUM_RECONSTRUCTION_RUNS;
    else process.env.DATUM_RECONSTRUCTION_RUNS = previous;
  });

  it("answers a run with no calibration with 204: expected, not an error", async () => {
    const response = await readRunFile("uncalibrated", "calibration.json");
    expect(response.status).toBe(204);
    expect(response.ok).toBe(true);
    expect(response.headers.get("X-Run-File")).toBe("absent");
    expect(await response.text()).toBe("");
  });

  it("serves a calibration that exists", async () => {
    const response = await readRunFile("calibrated", "calibration.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, references: [] });
  });

  it("still answers 404 for a run that does not exist, or a file that is not optional", async () => {
    expect((await readRunFile("no-such-run", "calibration.json")).status).toBe(404);
    expect((await readRunFile("uncalibrated", "source.jpg")).status).toBe(404);
    expect((await readRunFile("uncalibrated", "secrets.txt")).status).toBe(404);
    expect((await readRunFile("../escape", "calibration.json")).status).toBe(404);
  });
});

describe("loading a run's calibration", () => {
  const intermediate = readFileSync(FIXTURE, "utf8");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  /** A server that answers the run's reconstruction, and the calibration however the case needs. */
  const serve = (calibration: () => Promise<Response> | Response) =>
    vi.stubGlobal("fetch", async (url: string) => (String(url).endsWith("/reconstruction.json") ? new Response(intermediate, { status: 200 }) : calibration()));

  afterEach(() => {
    vi.unstubAllGlobals();
    errors.mockClear();
  });

  it("opens an uncalibrated run with its scale estimated and nothing reported", async () => {
    serve(() => new Response(null, { status: 204 }));
    const state = await loadRun(RUN);
    expect(state.status).toBe("compiled");
    if (state.status !== "compiled" || !state.result.ok) throw new Error("not compiled");
    expect(state.calibration).toEqual([]);
    expect(state.calibrationProblem).toBeNull();
    expect(state.result.evidence.scale.basis).toBe("estimated");
    expect(errors).not.toHaveBeenCalled();
  });

  it("applies a calibration the run has", async () => {
    serve(() => Response.json({ schemaVersion: 1, references: [{ kind: "room-height", metres: 2.7, label: "ceiling" }] }));
    const state = await loadRun(RUN);
    if (state.status !== "compiled" || !state.result.ok) throw new Error("not compiled");
    expect(state.calibration).toHaveLength(1);
    expect(state.calibrationProblem).toBeNull();
    expect(state.result.evidence.scale.basis).toBe("calibrated");
    expect(state.result.scene.room.height).toBeCloseTo(2.7, 3);
    expect(errors).not.toHaveBeenCalled();
  });

  it("reports a server failure rather than treating it as no calibration", async () => {
    serve(() => Response.json({ code: "unreadable", message: "…" }, { status: 500 }));
    const state = await loadRun(RUN);
    if (state.status !== "compiled") throw new Error("not compiled");
    expect(state.calibrationProblem).toBe("calibration.json could not be read (HTTP 500, unreadable)");
    expect(errors).toHaveBeenCalledWith("[reconstruction] calibration.json could not be read (HTTP 500, unreadable)");
  });

  it("reports a network failure, and still opens the room with its scale estimated", async () => {
    serve(() => Promise.reject(new TypeError("Failed to fetch")));
    const state = await loadRun(RUN);
    if (state.status !== "compiled" || !state.result.ok) throw new Error("not compiled");
    expect(state.calibrationProblem).toBe("calibration.json could not be fetched: Failed to fetch");
    expect(state.result.evidence.scale.basis).toBe("estimated");
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("reports a calibration that is not JSON, or not a calibration", async () => {
    serve(() => new Response("{ not json", { status: 200 }));
    const broken = await loadRun(RUN);
    if (broken.status !== "compiled") throw new Error("not compiled");
    expect(broken.calibrationProblem).toBe("calibration.json is not valid JSON");

    serve(() => Response.json({ schemaVersion: 9, references: [] }));
    const unknown = await loadRun(RUN);
    if (unknown.status !== "compiled") throw new Error("not compiled");
    expect(unknown.calibrationProblem).toBe("calibration.json was ignored: unsupported calibration schemaVersion 9");
    expect(errors).toHaveBeenCalledTimes(2);
  });
});
