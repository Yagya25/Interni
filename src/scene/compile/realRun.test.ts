import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { summarizeScene } from "@/scene/model/summary";
import { compileRoomShell } from "./compileRoomShell";
import { parseIntermediate, type ReconstructionIntermediate } from "./intermediate";

/**
 * Real worker output: GeoCalib + MoGe-2 on the example photograph that ships
 * with the MoGe repository (example_images/01_HouseIndoor.jpg, MIT). It is
 * what the pipeline actually wrote, committed so the compiler is tested on
 * real observations without a GPU.
 */
const FIXTURE = new URL("./__fixtures__/moge-example-house-indoor.intermediate.json", import.meta.url);

function load(): ReconstructionIntermediate {
  const parsed = parseIntermediate(JSON.parse(readFileSync(FIXTURE, "utf8")));
  if (parsed.kind !== "run") throw new Error(`fixture did not parse: ${JSON.stringify(parsed)}`);
  return parsed.intermediate;
}

describe("compiling a real worker run", () => {
  it("produces a room shell whose every surface traces to a plane or a rule", () => {
    const result = compileRoomShell(load());
    if (!result.ok) throw new Error(result.problem.code);
    const { scene, report, evidence } = result;

    expect(scene.provenance).toMatchObject({ kind: "reconstruction" });
    expect(report.sides.far.status).toBe("observed");
    expect(report.sides.left.status).toBe("observed");
    expect(scene.surfaces.find((s) => s.id === "ceiling")?.evidence).toBe("observed");
    for (const surface of scene.surfaces) {
      const e = evidence.entities[surface.id];
      expect(e, surface.id).toBeDefined();
      expect(e.observations.length > 0 || e.presence.basis !== "estimated", surface.id).toBe(true);
    }
    const summary = summarizeScene(scene);
    expect(summary.objects).toBe(0);
    expect(summary.dimensions.height).toBeGreaterThan(2);
  });

  it("compiles to the same bytes every time", async () => {
    const a = JSON.stringify(compileRoomShell(load()));
    expect(JSON.stringify(compileRoomShell(load()))).toBe(a);
    await expect(JSON.stringify(JSON.parse(a), null, 2) + "\n").toMatchFileSnapshot(
      "./__fixtures__/moge-example-house-indoor.compiled.json",
    );
  });
});
