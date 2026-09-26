# Current state, after Phase 5

What is actually implemented, as of 26 September 2026. Nothing here is planned
work: every claim is read from the code in this repository and from the
reconstruction worker in WSL. The design document for where this is going is
`docs/reconstruction-architecture.md`; this file is the inventory.

Repository: branch `landing-workspace-refinement`, HEAD `af38165`. Committed:
the reconstruction compiler and the AI command layer in `20eff6c`, the design
proposal engine (Phase 4A) in `59a4bcc`, and this file's Phase 4A version in
`af38165`. **Phase 4B (spatial layout) and Phase 5 (measurement) are complete
and verified but not committed**: they are working-tree changes on top of
`af38165` (§22).

Stack: Next.js 16.3.5 (App Router), React 19.2.8, three 0.186, TypeScript 5,
vitest 4.1.11. The reconstruction worker is a separate Python 3.12 package in
WSL, not part of this repository.

The product is two pipelines that change one Scene, and one layer that reads
it:

```
photograph → worker → intermediate → SceneCompiler → Scene (+ SceneEvidence) → workspace
                                                       │
                          words → intent → command → operations → history   (3E: do this)
                          words → design intent → proposals → operations → history  (4A: finishes; 4B: layouts)
                          Scene + evidence → measurements (read-only, derived)   (5: measure this)
```

---

## 1. Reconstruction pipeline (the worker)

`~/datum-recon` in WSL (`wsl -d Ubuntu`, user `datum`) — package
`datum-reconstruction` 0.1.0, ~3,200 lines of `reconstruction/*.py` plus
~560 lines of tests. It takes one photograph and writes what it **observed**;
it never writes a Scene and never decides what the room is.

Stages, as the worker records them (`reconstruction/worker.py`):

| Stage | What runs |
| --- | --- |
| S0 intake | EXIF orientation applied, metadata stripped, long edge ≤ 1600 px |
| S1 camera | GeoCalib pinhole: intrinsics, roll, pitch, gravity, vertical FOV |
| S2 geometry | MoGe-2 ViT-L normal: metric points, normals, validity |
| S4 layout | plane fitting (floor / ceiling / wall / other), deterministic |
| S3 detection | Grounding DINO boxes, SAM 2.1 masks |
| S5 objects | per-instance geometry: visible boxes, yaw candidates, wall contact |
| S6 appearance and light | SigLIP 2 zero-shot material class per region; colour, palette, rectified-plane texture, floor reflections; light colour, shading direction, gradient, daylight through openings, sun patches, lamp emission, exposure |

Every model is pinned by repository revision and weight SHA-256, loaded from
`weights/`, one at a time, fp16; nothing is fetched at run time. A stage that
is turned off is recorded as `skipped`, never faked.

Output per run, in `runs/<UTC timestamp>-<sha8>/`: `reconstruction.json` (the
intermediate), `source.jpg`, `depth.png`, `normals.png`, `valid-mask.png`,
`planes.png`, two previews, `instances.json`, `worker.log`. A run directory is
never overwritten. `python -m reconstruction.calibrate` writes a
`calibration.json` beside it — a real measurement, applied later by the
compiler, with no model re-run.

The contract between worker and app is `ReconstructionIntermediate` v1,
mirrored in TypeScript at `src/scene/compile/intermediate.ts`, with
`parseIntermediate()` refusing anything malformed by field name and refusing
an unknown `schemaVersion` outright.

## 2. Scene model

`src/scene/model/types.ts` — the single source of truth for a room. Metres,
right-handed, +Y up, floor at y = 0, radians, sRGB hex, stable ids.

`Scene` = `provenance` + `room` (type, label, footprint, height) + `camera`
(the estimated capture pose) + `surfaces` + `openings` + `objects` +
`materials` + `lights` + `relationships`.

- `SceneProvenance` is `demo` or `reconstruction` (source image id, pipeline
  version, created-at). The UI labels scenes from it.
- `Surface` is a floor/ceiling plane or a wall (start, end, thickness), each
  with `evidence: "observed" | "inferred"`.
- `SceneObject`: category (26 categories), label, transform, dimensions,
  named material slots, `support` (floor / wall / ceiling / object), optional
  `form` and `metadata`.
- `Light` is `daylight` (opening ids, optional `timeOfDay`, optional
  `direct`), `ambient`, or `artificial` (fixture id, emitter offset, colour
  temperature, optional intensity and switch).
- `Relationship`: subject, predicate (`faces`, `beside`, `in-front-of`, `on`,
  `under`, `above`, `against`, `lit-by`, `opposite`), object.

Helpers: `queries.ts` (room bounds, walls, wall frames, opening centres, used
material ids, object centre/radius), `summary.ts` (`summarizeScene` for the
title block), `editing.ts`, `colour.ts` (sRGB arithmetic — mix, scale,
luminance, warmth — shared by the command layer and the design engine so both
shift a finish the same way), and `operations.ts` (below).

## 3. Compiler (`src/scene/compile/`)

`compileRoomShell(intermediate, { calibration, objects })` →
`{ scene, evidence, report }` or a named problem. Pure and deterministic: the
same intermediate always gives the same Scene, byte for byte; every length is
rounded to the millimetre. `COMPILER_VERSION = "room-shell-0.2.0"`,
`PRIORS.version = "priors-0.1"`. It runs in the browser, in Node and in tests.

What it decides:

- **Frame**: area-weighted Manhattan yaw from the walls (±45°), then the
  calibration scale factor, then the footprint centred on the origin.
- **Walls**: each observed wall bounds the side its normal faces; the largest
  wall wins a side; a wall more than `axisSnapDeg` (12°) off an axis is
  reported and not used. An unseen side is closed at the smallest extent the
  evidence allows (floor points and wall ends inside, the camera a stated
  clearance inside) and marked `inferred`; the wall behind the camera is
  omitted from the surfaces while the footprint stays closed.
- **Height**: from the ceiling if seen, else the highest wall top, else the
  2.5 m default.
- **Camera**: position, orbit target (where the principal ray leaves the
  room, held `targetInset` inside), vertical FOV, aspect. Roll is reported,
  not represented.
- **Objects and openings**: `objects.ts` + `vocabulary.ts` (below).
- **Failures**: `no-floor`, `degenerate-room`, `ceiling-below-camera`.
  `checkInvariants()` throws on a compiler bug (duplicate ids, a missing
  material, an object outside the room, a light without a fixture, …).

**Calibration** (`calibration.ts`): references are `on-plane` (two marked
pixels on one fitted plane plus a real distance) or `room-height`. Log-ratios
are averaged with equal weight into one scale factor; residuals are reported;
unusable references are rejected with a reason. Without references the factor
is 1 and the basis stays `estimated`.

**Objects** (`objects.ts`, `vocabulary.ts`): an instance becomes an object
when its detector score ≥ 0.3 (0.25–0.3 is reported as a candidate), its mask
score ≥ 0.8, and its phrase is in `VOCABULARY` (`vocabulary-0.1`). Phrases
map to a category prior, to an opening, to "lamp" (a floor lamp when its top
is ≥ 1.2 m; a table lamp is not modelled), or explicitly to nothing ("seen,
not modelled"). Visible extents are estimates and lower bounds; an unseen
dimension comes from the category's p50 and is labelled `inferred`; facing is
a rule (away from the wall it stands against, otherwise the way its visible
faces point); wall-hung things and openings are measured on the wall plane
from their pixels' rays; small things resting on a piece get
`support: { kind: "object" }`. Ids are content-ordered (`sofa-0`,
`armchair-1`) so they survive a recalibration.

## 4. Evidence and provenance

`SceneEvidence` (`compile/evidence.ts`) is a sidecar keyed by the Scene's own
ids — the Scene contract itself carries no uncertainty. Per entity: `kind`,
`presence.basis`, per-field `Quantity` (`value`, `basis`, `sigma`, `interval`,
`confidence`, `sources`, `note`), the observation ids it was built from,
alternatives, and plain-language notes. `Basis` is `measured` > `calibrated` >
`estimated` > `inferred` > `default`; `sigma`, `interval` and `confidence` are
**null throughout v1** — there is no evaluation set yet, so no calibrated
confidence is claimed.

`CompileReport` records every decision: frame, each side's status and basis,
dimensions, planes used and ignored (with reasons), the objects report
(emitted / candidates / not-modelled / rejected), the materials report, the
lighting report, relationship count, and all problems.

Surfaced in the UI: the photograph and "estimated, not calibrated" vs
"calibrated to your measurement" in `SceneTitleBlock` (with a highlighted line
when a run's calibration exists but could not be used, §14.9), and per-finish
and per-light readings in `Inspector`, `MaterialsPanel` and `LightingPanel`
through `reconstruction/describe.ts`. Evidence reaches components via
`sourceContext.ts`.

**Measurements reuse this model (Phase 5, §15).** A derived measurement is a
`Quantity<number>` with a few fields added; its basis is the weakest basis of
the Scene values it was derived from, and σ, interval and confidence stay null
because nothing upstream provides them. There is no second provenance system.

**A design proposal carries no evidence.** It is a choice, not a measurement,
and the cards say what each direction changes and what it leaves as the
photograph found it (§13.7).

## 5. Object relationships

`compile/relationships.ts`, rules version `relations-0.1`, derived
deterministically from placements alone (sorted, ids `rel-0`…):

- `on` — from `support.kind === "object"`;
- `against` — a floor piece the placement put against a wall;
- `above` — a wall-hung piece over a floor piece on the same wall;
- `in-front-of` — a table within 2.2 m and 35° of a seat's front;
- `faces` — of the lookers its front ray passes over, the one it faces most
  squarely (within 7 m, off-axis within its radius + 0.3 m);
- `beside` — two floor pieces with a footprint gap < 0.6 m, more to the side
  than ahead; the smaller is beside the larger.

The AI layer re-checks a recorded relationship against the current geometry
before trusting it (`holds()` in `ai/rules/spatial.ts`), so a piece dragged
across the room is no longer "beside the sofa". The design analysis reads the
`against` relationships as spatial constraints (§13.2).

Since Phase 4B each rule is also exported on its own (`isAbove`,
`isInFrontOf`, `facedBy`, `isBeside`, `RelationInput`), with behaviour
unchanged. The layout layer's `relationsOf(scene)` (`design/layout/geometry.ts`)
runs the compiler's own rules on the room's *current* geometry: on the room as
reconstructed it gives exactly the recorded list (21 relationships on the
fixture, asserted in a test); after a layout it gives what that layout
actually leaves true. Recomputed relationships are never written back into the
Scene.

## 6. Materials

`compile/materials.ts` (`material-rules-0.1`, class `MaterialBook`). Every
material is one region of the photograph, read four ways, each with its own
basis:

- **class** — SigLIP 2 zero-shot logits restricted to what the surface or
  slot can be (`ALLOWED_CLASSES`, e.g. a sofa's upholstery is fabric or
  leather, a TV screen only glass). `estimated` when the best beats the next
  by 0.5 logit, the slot's typical class (`default`) when it does not,
  `inferred` when only one class is possible.
- **colour** — the median of the region's well-exposed pixels, `estimated`.
  It is the surface *under this photo's light*; the light is deliberately not
  divided out, and the Scene's ambient light is kept neutral instead so the
  warmth is carried exactly once.
- **roughness** — measured only from the opening mirrored in the floor (how
  bright and how blurred the reflection is); otherwise the class's typical
  value, `inferred`. Metalness is always the class's.
- **pattern** — tiles on a ceramic floor, planks on a wooden one, grain and
  weave on pieces; a tile size only when both axes of the rectified floor
  agree.

Walls whose chromaticity agrees (CIE u'v' < 0.012) and whose class matches are
unified into one paint, coloured by the best-lit of them. Names describe and
claim nothing more ("Painted surface, light beige"). Anything not read gets a
plainly named stand-in (`unestimated-floor`, `unestimated-accent`, …).

`ALLOWED_CLASSES` is the one table of what a thing can be made of. Both the
command layer (`validateCommand`) and the design engine (`validateOperations`)
check against it, so no path can make a television's screen fabric.

## 7. Lighting

`compile/lighting.ts` (`light-rules-0.1`) produces exactly three kinds of
light and nothing else:

- **ambient** — neutral `#ffffff`; the measured grey-world colour and its CCT
  are recorded beside it, never applied twice;
- **daylight** — through every glazed opening found; `direct: false` when the
  sunlit-patch fraction is below 1%; the hour is *not* recoverable from a
  photograph, so `timeOfDay` is left unset and the renderer's default (0.18)
  is used, with that said in the notes;
- **artificial** — one per floor lamp, 2700 K, emitter 0.15 m below its top,
  `on: true` only when the shade is seen lit (≥ 1.6× its surroundings or ≥ 5%
  clipped); an unlit lamp keeps no override and follows the daylight.

The shading direction from the pieces is used only as a cross-check against
the openings' bearings and is reported; a direction no opening explains is a
problem, not an invented light. The brightness gradient is a second
cross-check.

## 8. Spatial validation

Three layers now, all geometric, no fixed coordinates anywhere:

- **Compiler**: objects are held inside the room, placed on what carries
  them, snapped against a wall within 0.35 m, and `checkInvariants()` refuses
  a Scene with anything outside the footprint.
- **AI command layer** (`ai/rules/spatial.ts`, 644 lines): footprints as
  oriented rectangles, separating-axis `separation()`, height overlap,
  `insideRoom()`, `heldInside()`, `collision()` against every piece with
  height (a rug is walked over; what a piece carries or stands on is
  ignored), and `settle()` — the nearest free spot, searched **along the
  piece's own wall first** so a sofa keeps its back to the wall, then on rings
  2 cm apart up to 0.4 m. Moves are marched in 2 cm steps and stop at the
  first wall or piece, and a stated distance that was cut short says so.
  `SPACING` holds the clearances (0.3 m between pieces, 0.1 m beside, 0.4 m
  in front, 0.15 m behind and above, 0.1 m against a wall).
- **Design engine** (`design/validate.ts`): re-uses `footprintOf` and
  `insideRoom` to refuse any proposed transform that would leave the room,
  and refuses outright any operation that would add, remove or replace a
  piece (§13.8). Since Phase 4B a plan that moves furniture is also held to
  the layout's hard constraints (`design/layout/validate.ts`, §14.6): what may
  move, walls, collisions, doorways, and whether every seat and way in can
  still be reached.

Phase 5's measurement layer (§15) validates nothing and blocks nothing: it
reads the Scene and reports what it measures.

The photograph's camera defines left/right/front/back (`cameraFrame`,
`squared`, `acrossPhoto`): the one view the person and the reconstruction
share, whatever the on-screen orbit is doing. Forward/backward follow a
piece's own front when it has one (`HAS_FRONT`), the camera when it does not.
Up and down apply only to wall-hung pieces.

## 9. AI command architecture (Phase 3E)

One pipeline, `src/features/workspace/ai/`:

```
text → IntentReader → validateIntent → SceneIntent
     → resolveIntent → StructuredCommand → validateCommand
     → compileCommand → ProposedChange[] (SceneOperation[])
     → preview → apply → history → Scene → renderer
```

- `interpreter.ts` — the boundary types. An interpreter returns exactly one
  of four honest outcomes: `changes`, `unavailable` (understood, not possible
  here; `already: true` when the room is already like that), `clarify`
  (no selection / ambiguous with options / no reference), `unsupported`.
- `roomInterpreter.ts` — `createRoomInterpreter(originalScene, reader?)`.
  The reader is the **only** part that reads words and its output is
  untrusted until `validateIntent` passes it, so a model plugged in here is
  held to exactly what the rules are. It declares `kind: "rules" | "model"`,
  a note and examples, which the UI shows.
- `rules/read.ts` — `ruleReader`, the reader in this build. Deterministic, not
  a language model: normalise (case, punctuation, synonyms, spelled-out
  numbers and units → a canonical vocabulary in `rules/vocabulary.ts`), then
  an ordered list of intent rules (reset, daylight, switch, replace, remove,
  face, turn, move, colour, material class, not-a-finish, warmth and light,
  size, recognised-but-unavailable). Anything outside them returns null.
- `rules/messages.ts` — every sentence the person can be shown.
- **No LLM is configured.** No provider, no API key path, no network call
  anywhere in this layer; with no interpreter passed at all the workspace uses
  `notConnected`, which refuses and says why. Nothing ever fabricates a model
  response.

The command bar is shared with the design engine. `WorkspaceStore.run()` reads
the words for a design request first (`readDesignRequest`, §13.4); only when
they are not one does the text reach the interpreter above. The two paths are
kept apart on purpose and neither can produce the other's result. Layout
requests (§14.4) are read by the same design reader; a sentence that starts by
moving or turning one piece ("move the sofa 20cm left") stays a Phase 3E
command unless it also names a layout.

## 10. Intent schema (`ai/intent.ts`)

`SceneIntent` is words-level and closed: `move_object`, `rotate_object`,
`scale_object`, `remove_object`, `change_material`, `change_lighting`,
`switch_light`, `replace_object`, `reset_room`, `unavailable_edit`.

Notable fields: a move's destination is `{relative, relation, reference}`
(closer_to, away_from, beside, above, in_front_of, behind, against, into,
onto, under) or `{direction}` (left, right, forward, backward, up, down), with
a `degree` and an optional stated `distance`; a rotate is degrees **or** a
`face` reference, never both; a material change is a tone, a named colour, a
material class, or `not_a_finish`; lighting is warmer / cooler / brighter /
dimmer / more_daylight / less_daylight plus `includeSurfaces`.

`EntityRef` is `selection`, `unspecified`, `room`, `lamps`, a surface, an
opening, or an `ObjectRef` carrying the words, the categories they name, the
categories they are only an alias of, `pointed`, `plural`, `sides`, `ordinal`
and `near: { predicate, of }`.

`validateIntent(value, categories)` is the provider boundary: unknown types,
relations, classes, categories or sides are refused **by name**, numbers must
be finite, distance must be > 0 and ≤ `MAX_DISTANCE` (20 m), a scale factor
must be above zero, nothing is coerced.

## 11. Entity resolution (`ai/rules/resolve.ts`)

Words → the scene's own ids, strongest evidence first:

1. the selected piece, for "this"/"it"/"that chair" when it is one;
2. pieces of the named category, then pieces the word is only an alias of;
3. qualifiers — a recorded relationship that still `holds()`, else plainly
   nearest (within 1.5 m, or 0.6 m for "beside", and 30 cm clearer than the
   next); a side as the photograph shows it (`bySides`, 15 cm margin,
   combined diagonal for "front right"); an ordinal ("armchair 2");
4. otherwise a question back, each candidate described by where it stands —
   `describeAmong()` produces "front right", "left, beside the sofa",
   "middle" — never a guess.

Plurals mean every piece that answers. A name nothing answers to is reported
in the person's own words. Openings and surfaces resolve and are then
answered honestly ("the glazed door is part of the wall", "the walls are the
room itself"). `resolveIntent()` returns a `StructuredCommand` or a
clarify / unsupported / unavailable resolution, including the impossible
places (into, onto, under) and "make the TV liquid", which is refused with
what the piece *can* be.

`StructuredCommand` (`ai/command.ts`) is the id-level command —
`MOVE_OBJECT`, `ROTATE_OBJECT`, `SCALE_OBJECT`, `REMOVE_OBJECT`,
`CHANGE_MATERIAL`, `CHANGE_LIGHTING`, `SWITCH_LIGHT`, `REPLACE_OBJECT`,
`RESET_ROOM` — with targets (object, objects, slots, surfaces, lights, room)
and `PlaceRef` references. `validateCommand(scene, cmd)` checks it against the
scene before a single operation exists: every id present and of the right
kind, angles ≤ 360° and non-zero, scale within `SCALE_LIMITS` (⅓–3× per
command, 0.25–4× total), distances within the room's diagonal, finishes
within `ALLOWED_CLASSES`, up/down only for wall-hung, no piece moved relative
to itself. `titleOf()` names the command back ("Move sofa toward glazed
door", "Make the room darker") and that title is the history label.

## 12. SceneOperation mapping (`ai/rules/compile.ts`)

`compileCommand` turns a validated command into operations through the very
same edit helpers a drag uses (`state/edits.ts`), so nothing in the AI path
can reach the renderer:

| Command | Operations |
| --- | --- |
| MOVE_OBJECT | `moveRelative` / `beside` / `inFrontOf` / `above` / `againstWall` / `directional` → `moveObject` → `move` for the piece and everything it carries |
| ROTATE_OBJECT | `planTurn`: turn in place, held inside the room, else settled within 40 cm, else refused with the largest turn that fits |
| SCALE_OBJECT | `scale`, plus a `move` when the piece must shift to stay clear, reporting what it was cleared of |
| REMOVE_OBJECT | `remove` for the piece and, first, everything standing on it |
| CHANGE_MATERIAL | `restyle` per slot / `resurface` per surface, each carrying its `library` entry |
| CHANGE_LIGHTING | `relight` on the daylight hour (±0.18, or ±0.25 for daylight), lamp colour temperature (±500 K) and output (×1.4), plus `resurface` on the walls when the room — not just "the lighting" — is warmed |
| SWITCH_LIGHT | `relight { on }` |
| REPLACE_OBJECT | `replace`, only when `assets/catalogue.ts` has a builder for the asked form; otherwise the structured request is returned as "understood, not available" |
| RESET_ROOM | add / replace / move / scale / restyle / resurface / relight back to the scene as opened, with `"auto"` where a value was never set |

A change that would alter nothing is dropped; a command with nothing left
answers "that's already the case" rather than pretending. Everything is a
pure function of the command and the scene — the same words on the same room
always give the same operations, which is asserted in the tests.

## 13. Design architecture (Phase 4A)

`src/features/workspace/design/` — 2,217 lines of engine and UI plus 588
lines of tests at Phase 4A; with Phase 4B's layout half added to the same
files the top level is now 2,396 lines (tests still 588), and the layout
engine itself lives in `design/layout/` (§14). The product moves from "do what
I tell you" to "help me design this room" **without** a second way to change a
room:

```
Scene → analyseScene → DesignAnalysis
text  → DesignIntentProvider → validateDesignIntent → DesignIntent
        → ProposalGenerator (+ analysis) → validateOperations → DesignProposal[]
        → preview (overlay only) → apply → commit() → the same history
```

A proposal is a **plan**, never a mutation and never a picture: it holds the
`SceneOperation[]` it *would* apply and nothing else. Until someone applies
it, the room it describes exists only as that list.

### 13.1 DesignAnalysis (`analysis.ts`)

`analyseScene(scene)` reads the Scene and nothing else — no priors, no
inference layer, no invented objects. Version `design-analysis-0.2` (Phase 4B
added the `layout` field, §14.2; everything below is unchanged). It returns:

- `room` — type, label, width, depth, height, floor area (bounding rectangle).
- `furniture` — count; categories with counts (most numerous first, then
  alphabetical); `occupiedArea` and `freeArea` in m² from the floor-standing
  pieces' plan rectangles; `density` (occupied ÷ floor area); `seating`;
  `focal` (a television, else the sofa, else null); `wallMounted`;
  `floorStanding`; `carried`; `largest`.
- `materials` — the wall finishes, the floor, the ceiling, every object finish
  slot (`SlotFinish`: object, category, slot, material id, class, colour, and
  whether it is an `unestimated-` stand-in), the `palette` (distinct colours
  by how much they cover), and mean `lightness`, `contrast` and `saturation`.
- `lighting` — the hour (the daylight's `timeOfDay`, else the 0.18 default),
  the daylight and its openings, the ambient, every lamp with its colour
  temperature / intensity / switch, and `unlit`.
- `spatialConstraints` — pieces the room put `against` a wall, what stands on
  what, the openings and their walls, and the relationship count.
- `existingStyleSignals` — where the room already sits on the style axes:
  warmth, brightness, contrast, colourfulness, whether wood and fabric are
  present.
- `layout` — the room as a plan (`analyseLayout`, Phase 4B, §14.2).

Deterministic: the same Scene gives the same analysis field for field.

### 13.2 DesignIntent and the provider boundary (`intent.ts`)

`DesignIntent` is what a *request* asks for, and the only thing the generator
accepts:

```
{ version: "design-intent-0.2",
  styles: DesignStyle[],            // empty means "choose for me"
  atmosphere: string | null,        // the words, for the card
  warmth | brightness | contrast |
  luxury | minimalism | coziness: number | null,   // each −1..1
  variantCount: number,             // 1..MAX_VARIANTS (3)
  finishes: boolean,                // Phase 4B: false for a pure layout request
  layout: LayoutIntent | null }     // Phase 4B: §14.4
```

An intent may ask for finishes, a layout, or both. `finishes: false` with a
style or an atmosphere is refused, and an intent that asks for neither
finishes nor a layout is refused.

`validateDesignIntent(value)` is the provider boundary, and it is as strict as
`validateIntent`: an unknown style is refused **by name**, styles must not
repeat, every axis must be a finite number within −1..1, `variantCount` must
be a whole number between 1 and 3, an unknown `version` is refused, nothing is
coerced. A model placed behind this boundary can ask for a style, an
atmosphere and layout concepts; **it cannot name an operation, an object id, a
colour, a position or an angle**. The generator decides what a style or a
layout means for a room and the validator decides whether the result may be
shown at all.

`DesignIntentProvider` (`read.ts`) is the interface a future
`LLMDesignIntentProvider` implements — `kind: "rules" | "model"`, a name, a
note, examples, and `read(text, signal) → unknown`. The build ships exactly
one: `designRules`, deterministic, with no provider, no credential path and no
network call anywhere in the layer.

### 13.3 Reading a design request (`read.ts`)

Deterministic and rule-based, like the command reader. What makes a sentence a
design request at all is a closed set:

- a **design noun** — design, redesign, makeover, scheme, variant, version,
  option, direction, idea, concept, style, palette, moodboard, atmosphere,
  vibe;
- the word **feel** (or feels / feeling / mood);
- a **style name** — modern, contemporary, scandinavian / scandi / nordic,
  minimal / minimalist, classic, elegant, luxurious / luxury, cozy / cosy,
  snug, inviting, and the compound "dark contemporary".

Nothing else. This is the line between the two pipelines, and it is drawn
deliberately: **"make the room warmer" is an edit** (one change to this room,
§12) and stays one; "make this room *feel* warmer and more luxurious" is a
design brief. Axis words (warm, bright, dark, contrast, luxurious, minimal,
cozy and their opposites) set the axes, with "less"/"not so" counting against
an axis; "much / very" reads 1, "slightly / a bit" 0.35, otherwise 0.65. A
number or a plural sets `variantCount` ("3 modern designs" → 3, "a couple of
options" → 2, "some ideas" → 3, otherwise 1).

The same reader recognises an act on directions already on screen —
`{ action: "preview" | "apply" | "dismiss", ordinal }` — but never when a
style is named, so "show me a Scandinavian version" is always a new brief.
With no session open, such an act is answered ("There are no designs on
screen") rather than quietly generating some.

Since Phase 4B the reader also reads layout requests (`layout/read.ts`, §14.4)
and acts on layouts already on screen ("preview the third layout"). Style
words that stand right before a layout noun describe the layout ("a cozy
conversation layout") and do not also ask for new finishes; with a layout
asked for, only the words left over can ask for finishes.

### 13.4 Styles (`styles.ts`)

Six descriptive presets, not a ranking. Each carries a palette (wall, ceiling,
wood, upholstery, textile, accent, metal, shade), a floor rule, light values,
an axis signature, three variants and the constraints it states plainly:

| Style | Title | Variants | Floors kept | Hour | Bulb | Output | Lamps on |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MODERN_WARM | Modern Warm | Modern Warm · Modern Neutral · Modern Dark Accent | wood | 0.32 | 2700 K | 1.15 | yes |
| SCANDINAVIAN | Scandinavian | Scandinavian Light · Soft · Muted | wood | 0.10 | 3200 K | 1.0 | no |
| MINIMAL_NEUTRAL | Minimal Neutral | Minimal Pale · Stone · Graphite | wood, stone, ceramic | 0.15 | 3000 K | 1.0 | no |
| DARK_CONTEMPORARY | Dark Contemporary | Dark Charcoal · Ink · Warm Shadow | wood, stone | 0.55 | 2500 K | 1.25 | yes |
| CLASSIC_ELEGANT | Classic Elegant | Classic Ivory · Taupe · Deep | wood | 0.38 | 2700 K | 1.2 | yes |
| COZY | Cozy | Cozy Amber · Clay · Ember | wood | 0.62 | 2400 K | 1.3 | yes |

No preset mentions an object id, a category or a coordinate: a style is read
against whatever Scene is open. `STYLE_ORDER` (modern, scandinavian, minimal,
dark, classic, cozy) is the order used when nothing narrows the choice.

`resolveScheme(preset, variant, axes)` folds the three into the one set of
colours and light values the generator works from. A variant multiplies
lightness, leans the palette warm or cool and sets how far accents go; the
request's axes *nudge* the preset without replacing it (a warmer Scandinavian
room is still Scandinavian), and contrast is spent on the palette's darker
half so raising it separates timber and seating from the walls. With no style
named, `styleFor(axes)` picks the preset whose signature scores highest
against the request, ties broken by `STYLE_ORDER`.

### 13.5 ProposalGenerator (`generate.ts`)

`generateProposals(scene, intent, analysis?)` → `{ ok, analysis, proposals,
rejected, reason? }`.

Since Phase 4B a proposal is finishes and light (below), a layout of the
furniture the room already has (§14.5), or one of each together: the first
layout is paired with the first finish reading, and so on. A layout's `move`
operations come first in the plan, then the finish operations.

Which directions are produced: one style named gives that style's variants in
order (3 modern designs → Modern Warm, Modern Neutral, Modern Dark Accent);
several named give one reading of each before a second of any; none named
picks the style the axes point at, or — when the request says nothing at all —
a spread across the vocabulary, so "three designs" are three directions rather
than three shades of one.

What a scheme means for a room, read in the Scene's own order:

- **Walls** — `resurface` each wall with the style's wall colour.
- **Ceiling** — the style's ceiling colour, always lighter than its walls.
- **Floor** — kept exactly as measured when its class is one the style keeps
  (a ceramic floor survives a Minimal Neutral); otherwise the style's own
  floor colour, with the pattern, tile size and gloss the photograph measured
  carried through untouched.
- **Object finishes** — `restyle` per slot, by family: upholstery / cover /
  seat / bedding / cushion, textiles (curtains, rugs, fabric, pile, weave),
  timber (frame, body, top, stand, base, shelf), lamp shades, and artwork
  surfaces as the style's restrained accent. A metal finish takes the
  palette's metal tone; stone and ceramic are mixed towards the timber tone
  rather than repainted. **Skipped entirely**: a television, a plant's
  foliage, anything of class glass, and any slot the engine does not
  recognise.
- **Light** — `relight` the daylight to the style's hour, and each lamp to its
  colour temperature and output; a lamp the photograph found unlit is switched
  on only by a style that says so.

Every operation is applied to a working copy as it is planned and **dropped if
it changes nothing**, so a proposal never offers a change the room already
has; a direction with nothing left to do is reported as
"This room already reads that way". Ids are `<style>-<variant>`
(`modern-warm-dark-accent`), so the same request always names the same
proposal. No `Math.random`, no `Date.now`, no timestamps, no unordered
iteration: verified by test and by inspection.

### 13.6 DesignProposal (`proposal.ts`)

```
{ id, title, style, variant, description,
  designGoals[], operations[],
  affectedObjects[], affectedMaterials[], affectedLighting[],
  rationale[], constraints[],
  changes: ProposedChange[],          // the shape the command layer already uses
  layout: LayoutSummary | null,       // Phase 4B
  preview: { operationCount, changedObjectCount,
             changedMaterialCount, changedLightCount,
             movedObjectCount, restyledObjectCount },   // last two: Phase 4B
  status: "draft" | "preview" | "applied" | "rejected" }
```

`style` is `null` for a proposal that only rearranges the furniture; a layout's
`variant` is its reading's key (`facing`, `around`, `open`, …).

`rationale` is written from this room's own analysis ("The 3 walls are the
largest surface the room has…", "The floor lamp was found unlit in the
photograph; at this hour the style has it on"). `constraints` say what the
direction deliberately leaves alone, including that finishes are recoloured
while what each thing is *made of* stays as the photograph measured it, and
how many of the finishes changed were stand-ins the photograph never showed.

### 13.7 Proposal validation (`validate.ts`)

`validateOperations(scene, operations)` runs before a proposal is ever shown,
operation by operation against a working copy, and returns `{ ok }` or a
reason in the person's terms. It refuses:

- an empty plan, and any id the room does not have (object, surface, light);
- a slot the object does not have;
- a finish of a class that slot cannot take — `ALLOWED_CLASSES`, the
  compiler's own table — checked whenever a proposal *changes* a class;
  keeping the measured class is always allowed;
- a colour that is not `#rrggbb`, roughness or metalness outside 0..1;
- an hour outside 0..1, a bulb outside 1800–6500 K, output outside 0..3, a
  lamp value aimed at daylight or a daylight value aimed at a lamp, a light
  whose fixture is not in the room;
- a move that would put a piece outside the room, a move of a wall-hung
  piece, a scale past the editor's limits, a non-finite transform;
- **any** `add`, `remove` or `replace` — a design proposal cannot invent or
  destroy furniture;
- a plan that would change the number of objects, surfaces, openings or
  lights, leave a surface or slot without a finish, or leave a lamp's light
  without its fixture;
- since Phase 4B, any plan with moves that fails the layout's hard
  constraints (`validateLayout`, §14.6), checked on the arrangement the plan
  would leave.

The check is deliberately wider than what today's generator can emit: it is
the boundary a future generator — or a model asked for a bolder plan — has to
pass, so the generator's own restraint is not what keeps the room valid. A
proposal that fails is left out with its reason kept in `rejected`, never
quietly repaired.

### 13.8 Session, preview isolation and apply (`session.ts`, `state/store.ts`)

`DesignSession` = the request, the intent it was read as, the analysis, the
proposals, the rejected ones, `previewId` and `appliedId`. It lives in
`WorkspaceStore.state.design`, and the store exposes `proposeDesigns`,
`previewDesign`, `exitDesignPreview`, `applyDesign` and `dismissDesigns`.

**Preview isolation.** `renderedScene()` lays the previewed proposal's
operations over `doc.scene` for the renderer only — the very mechanism a
command's proposal already used. The document is untouched, so leaving a
preview returns *the same Scene object*, not an equal one; the test asserts
both reference identity and serialized equality. One thing is laid over the
room at a time: previewing a design drops a command's preview and issuing a
command drops the design's, leaving the cards on screen and every proposal
back at `draft`.

**Apply.** `applyDesign()` commits the proposal's whole plan through
`commit()` as a **single** history entry labelled with the proposal's title,
so one undo takes the entire design back and one redo returns it exactly. The
receipt strip reports it honestly ("Modern Neutral. 30 changes, one step in
the history."). Statuses move with it: the applied proposal becomes `applied`
and the ones not taken become `rejected`, while staying on screen and still
applicable. Stepping the history at all clears a design preview, since it was
laid over the room as it stood before the step.

### 13.9 The design UI (`DesignDirections.tsx`)

A narrow column against the room's left edge — about a sixth of the width, so
the 3D room stays the thing being looked at. Each card shows the title, the
one-line description, its counts, and Preview / Apply / Why; Why unfolds what
it changes, the rationale, what it leaves alone, and "N changes, applied as
one step in the history". The header carries the words that were asked and a
Close. Directions that could not be offered are named with their reason at
the foot.

Since Phase 4B the counts are "N pieces moved", finishes, pieces restyled and
lights, and a count of zero is not shown (a layout card reads "2 pieces
moved"). No card is scored and none is called the best. While directions are
open the rail and the room's title block share the left column without
overlapping (§14.9).

## 14. Spatial layout architecture (Phase 4B)

`src/features/workspace/design/layout/` — 1,985 lines of engine plus 551
lines of tests. The product moves from "change how my room looks" to "help me
decide how my room should be arranged", still **without** a second way to
change a room:

```
Scene → analyseLayout → LayoutAnalysis (part of DesignAnalysis 0.2)
text  → readLayout → LayoutIntent (inside DesignIntent 0.2) → validateDesignIntent
      → planLayouts: roles + circulation + direction + planner → move operations
      → validateLayout → DesignProposal → preview → apply → commit() → the same history
```

A layout is a list of ordinary `move` operations for pieces the room already
has. Nothing is added, removed, resized or replaced, and no image is drawn.
Phase 4B is complete and frozen; Phase 5 changed nothing in `design/layout/`.

### 14.1 Spatial roles (`roles.ts`)

`spatialRoles(scene)`, version `spatial-roles-0.1`: a layer derived from the
Scene, with the `ObjectCategory` model untouched. Each role carries the reasons
it was given, and no confidence is claimed. Roles are `PRIMARY_SEATING`,
`SECONDARY_SEATING`, `TABLE`, `DISPLAY`, `STORAGE`, `LIGHTING`, `DECOR`,
`ARTWORK`, `SLEEPING`, `OPENING` and `STRUCTURAL`. The primary seat is the
floor seat that holds the most people (sofa 3, bench 2, a chair 1), then the
larger, then by id.

`mobility` is what a layout may do with a thing: `movable`, `anchored`,
`wall-mounted`, `ceiling-mounted`, `carried` (moves only with what carries it)
or `structural`. A layout moves only `movable` floor pieces. "Anchored" is a
rule, not a property of the Scene: a piece lying flat (5 cm or lower, `FLAT`),
the piece a screen hangs above, storage standing against a wall, and a bed.

### 14.2 LayoutAnalysis (`analysis.ts`)

`analyseLayout(scene)`, version `layout-analysis-0.1`, is
`DesignAnalysis.layout`. From the Scene and nothing else:

- bounds; walls (length, inward direction, their openings); openings (kind,
  wall, width, sill, height, and whether a person can walk through it);
- roles, and per-piece facts: role, mobility, support, position, turn, size
  with scale applied, footprint, front, nearest wall and the gap to it, and the
  wall it stands against;
- `relationships`, recomputed by `relationsOf` (§5), and
  `staleRelationships`: recorded ones the current geometry no longer bears
  out;
- `seating` (primary, secondary), `focal` (the screen, and the table in front
  of the main seat), `circulation` (§14.3), and `proximity` (floor pieces
  within 60 cm of each other).

### 14.3 Circulation (`circulation.ts`, `geometry.ts`)

`circulationOf(scene)`, version `circulation-0.1`, is a deterministic design
heuristic. The floor is laid out as a 10 cm grid. Floor pieces taller than
5 cm are obstacles, so a rug is walked over. A cell is walkable when a 60 cm
path could pass through it: at least 30 cm (`clearance`) from every piece and
every wall. The walkable floor is the set of such cells that can be reached
from a doorway, or from the largest open region when the room has none. It
returns `openArea`, `occupiedArea` and `walkableArea` in m², where it was
reached `from`, each doorway (reachable, and what stands in front of it) and
each seat (reachable when a walkable cell comes within 35 cm, `reach`, of its
footprint).

A doorway is found by shape alone (`isPassage`: bottom at most 5 cm up, at
least 1.8 m tall), whatever the detector named it, which is why the fixture's
glazed door is the way in. `PASSAGE` keeps 0.9 m of floor clear straight out
from it, and a piece may stand 10 cm into that zone before it counts as in the
way. It is not an accessibility assessment: it knows nothing of door swings,
turning circles or building codes.

**Terminology.** Phase 4B calls `walkableArea` "walkable floor", on its cards
and in the planner's thresholds. It is the floor where the *centre* of a 60 cm
path can be, a circulation/path metric, and it is much smaller than the floor
that is simply not under furniture. That metric is frozen as it is. Phase 5
reports it unchanged under the name **circulation area**, beside a separate
**free floor** (§15.4).

### 14.4 LayoutIntent and the layout reader (`intent.ts`, `read.ts`)

```
LayoutIntent = {
  styles: ("TV_FOCUSED" | "CONVERSATION" | "OPEN")[],   // empty: choose from the axes
  social | tvFocus | openness | circulation |
  symmetry | compactness | separation: number | null,  // each −1..1
  preserve: boolean }                                   // "keep the furniture where it is"
```

Concepts, never coordinates: a provider can ask for a conversation layout or
more open floor, and cannot name a position, an angle or an operation.
`layoutIntentOf` runs inside `validateDesignIntent` and refuses unknown styles
by name, repeated styles, non-finite or out-of-range axes, and a `preserve`
that also asks for a layout.

The reader is a fixed vocabulary, not a language model. It knows layout nouns
and verbs (layout, arrangement, floor plan, arrange, rearrange, reposition),
phrases that set a direction or an axis ("around the TV", "conversation",
"more open", "social", "cramped", "flow", "symmetrical", "closer together",
"spread out"), qualifiers before a layout noun ("cozy", "minimal"), and "keep
the furniture where it is". A sentence that starts with a direct verb (move,
put, place, push, pull, slide, shift, drag, rotate, turn, set, swap, replace,
remove) is a Phase 3E command unless it also names a layout.

### 14.5 Directions, readings and the planner (`layouts.ts`, `strategies.ts`, `planner.ts`)

Three directions, three readings each. Titles are built from the room's own
pieces; on the fixture they read:

| Direction | Readings (key — title) |
| --- | --- |
| TV_FOCUSED | `facing` — Around the television · `centred` — Centred on the television · `gathered` — Gathered at the television |
| CONVERSATION | `around` — Conversation around the coffee table · `close` — Close conversation · `face-to-face` — Face to face across the coffee table |
| OPEN | `open` — Open floor · `path` — Clear way to the glazed door · `pared-back` — Pared back to the walls |

Directions named in the request come first. Otherwise the direction the axes
point at is used, with all three of its readings when more than one layout is
asked for. When the request says nothing about how, one reading of each
direction is tried. A room without a screen is never offered a screen
direction. A reading that would move nothing, or would arrange the room
exactly as one already offered does, is left out with its reason. Ids are
`layout-<direction>-<key>`, and at most 3 layouts are returned.

`PLANNER` (`layout-planner-0.1`) is greedy and deterministic. It places pieces
one at a time in the direction's order: the main seat, its table, the other
seats, then lamps and the rest. For each piece it tries every free spot on a
10 cm grid, every spot along a wall (5 cm apart, 2 cm off it) and every heading
worth trying. Candidates must pass the hard constraints: inside the room,
clear of every other piece with 30 cm of legroom in front of a seat, and no
further into a doorway than the piece already stood. The survivors are
weighed by the direction's preferences and general ones (don't move or turn
far, keep a piece's wall and its relationships). A piece moves only when its
best spot beats staying put by at least `minGain` (0.12).

A layout may not shrink the walkable floor below 70% of what it was
(`keepWalkable`), and an open layout has to free at least 0.2 m² of it
(`openGain`). Moves are built by `moveWithLoad`, the same helper a drag uses,
so a carried piece goes along. The weights are internal and never shown: no
layout is scored or called the best.

### 14.6 Layout validation (`validate.ts`)

`validateLayout(before, after, operations)` checks the arrangement a plan
would leave, not the planner's intentions, so any future generator is held to
the same room:

- only `movable` pieces move; a carried piece moves only with what carries
  it, and stays on it; walls, floor, ceiling, openings, wall- and
  ceiling-mounted pieces and anchored pieces never move;
- a floor piece stays on the floor, upright, at a finite position;
- every moved piece stays inside the room and passes through no wall;
- no moved piece runs into another;
- no moved piece stands further into a doorway than it already did;
- no seat that could be reached is shut in, and no way in is cut off.

A piece the plan did not touch is not re-judged. `design/validate.ts` runs
this on every proposal that moves anything (§13.7).

### 14.7 What a layout card says (`report.ts`)

`describeLayout` writes one change line per moved piece ("Armchair 2: moved
2.8 m to the right wall, turned 91°, out of the way of the glazed door"), a
rationale read from the room before and after, and the constraints (what the
layout leaves alone and why). The rationale includes a line such as "Walkable
floor, by a 60 cm path from the way in: 7.3 m² → 9.0 m²", shown to 0.1 m².
The proposal carries a `LayoutSummary`: direction, reading, the moved pieces,
relationships among the seating and the screen (gained, lost, kept), and the
circulation's walkable and open areas before and after.

### 14.8 Preview, apply and history

A layout travels inside the Phase 4A machinery unchanged (§13.8, §16).
Preview lays its `move` operations over the room for the renderer only, and
leaving it returns the same Scene object. Apply commits the whole plan as one
history entry titled by the proposal, and undo and redo return the exact
Scenes. Finishes and a layout requested together are one proposal and one
history step: on the fixture, "Give me a modern cozy design with a
conversation layout" gives "Conversation around the coffee table · Cozy
Amber".

### 14.9 Phase 4B polish: calibration contract and the design rail

**Optional calibration** (`reconstruction/localRuns.ts`, `loadRun.ts`):

- `calibration.json` is marked optional. When a run that exists has none, the
  dev API answers `204 No Content` with `X-Run-File: absent`, so the browser
  logs no failed request.
- An unknown run, an unknown file name or a missing required file is still
  404, and a file that exists but cannot be read is 500 `unreadable`.
- The loader's `readCalibration` keeps three cases apart: 204 opens the room
  with its scale estimated and reports nothing, and 200 parses and applies the
  file. Anything else (another status, a network failure, invalid JSON, the
  wrong schema) is logged with `console.error` and returned as
  `calibrationProblem`, and the room still opens with an estimated scale.
- `SceneTitleBlock` shows that problem as a highlighted line. That path is
  covered by unit tests only, because the real run has no broken calibration.

**Design rail and title block** (`SceneTitleBlock.tsx`/`.module.css`,
`DesignDirections.module.css`, `Workspace.tsx`/`.module.css`):

- While directions are open (`data-designs` on the stage), the rail and the
  room's title block share the left column. The rail is on top, and it stops
  above the block by the height the block reports through a `ResizeObserver`
  (`--title-block-space`).
- The rail width is one variable, `--design-rail-width` (17.5rem), and the
  block's photo is capped at 4.5rem while directions are open.
- On phones the title block is hidden, as before, and on shorter screens the
  card list scrolls. The result is no overlap and no horizontal scroll, with
  the room still the main thing on screen.

## 15. Measurement & spatial intelligence (Phase 5)

`src/features/workspace/measure/` — 1,699 lines plus 694 lines of tests. The
UI adds `InspectorSpace.tsx` (118 lines) and `useSettled.ts` (19 lines), and
small edits to `SceneTitleBlock.tsx` and `Inspector.tsx`. It turns the Scene
into a measurable spatial model without changing it:

```
Scene (+ SceneEvidence) → knowledgeOf → measureScene → room · floor · objects · openings
                                      → measureWalkway(piece)
                                      → answer(SpatialQuestion) → measurements + verdict + one sentence
```

### 15.1 Architecture

- **Read-only and deterministic.** Nothing here writes to the Scene or keeps
  a copy of the room. Measurements are derived on demand and never stored:
  there is no second Scene representation. The same Scene and evidence give
  byte-identical results (tested).
- `computeMeasurements(scene, evidence)` is uncached.
  `measureScene(scene, evidence)` is memoised per Scene object and evidence
  (`WeakMap`), and `measureWalkway(scene, evidence, id)` per piece. The
  rendered scene is a new object whenever it changes, so a previewed design is
  measured as that design.
- Evidence is used only when `evidence.sceneId === scene.id`; a sidecar for
  another Scene is ignored.
- Versions: `measure-0.1`, and walkways `walkway-0.1`.
- **Reused, not re-implemented:** the compiler's `Quantity` and `Basis`; 3E's
  `footprintOf` and `hasFront`; 4B's `obstaclesOf`, `circulationOf`,
  `CIRCULATION`, `isPassage`, `passageZones`, `PASSAGE`, `intrusion`,
  `gapToWall` and `frontOf`. The 4B planner, validator, strategies and
  thresholds are unchanged.
- Cost on the real room, timed once in a scratch probe during implementation:
  room 0.08 ms, floor 7.2 ms (6.0 ms of it the 4B circulation grid), objects
  3.5 ms, openings 0.3 ms.

### 15.2 The Measurement / provenance model (`types.ts`, `provenance.ts`)

```
Measurement extends Quantity<number> {   // value, basis, sigma, interval, confidence, sources, note
  available: true,
  unit: "m" | "m²",
  subjects: Id[],                        // the Scene ids it was measured on or between
  bound: "value" | "at-least" | "typical",
  edited: boolean,                       // a Scene value behind it was edited since the reconstruction
  resolution: number,                    // the step it is known to
  rounded: number,                       // value at that step: the most that may be said of it
  inputs: MeasuredInput[] }              // each: id, field, basis, sources, edited, bound, sigma
Unavailable = { available: false, reason }   // never a made-up number
```

- **Inputs** are read from the compiler's evidence, field by field:
  - the room's `width`, `depth` and `height`;
  - an object's `dimensions.0/1/2`, `transform.position`,
    `transform.rotation.1` and `support`;
  - a wall's `position`, and an opening's `width`, `height` and `sill`;
  - the scale every length shares (`scale:depth-model` when estimated,
    `calibration:N references` when calibrated).
- **Basis** is the weakest basis of the inputs (`measured` > `calibrated` >
  `estimated` > `inferred` > `default`). **Sources** are the union of the
  inputs' sources, plus `rule:<name>` for the rule that derived it.
- **Bound:**
  - `at-least` where the compiler recorded a lower bound (a width from the
    visible part of a piece), or where an unseen side of the room is
    `inferred`;
  - `typical` where a size's basis is `inferred` or `default` (a category's
    typical size);
  - otherwise `value`.

  An area or perimeter is `at-least` only when some input is a lower bound
  and none is edited, typical or default.
- **Uncertainty:** σ is passed through only for a number read straight off
  one Scene value that carries its own σ and has not been edited. No Scene
  value carries one yet, so **σ is null everywhere, and so are `interval` and
  `confidence`**. Calibrating with several references still leaves σ null
  (tested). No error margin is invented.
- **Honest rounding.** `resolution` is the step a number is shown to. It says
  how finely a number may be read, not how wrong it may be:

  | Basis | Lengths | Areas |
  | --- | --- | --- |
  | measured, calibrated | 1 cm | 0.1 m² |
  | estimated | 5 cm below 1 m, 10 cm up to 10 m, 50 cm above | 0.5 m² |
  | inferred, default | 10 cm (50 cm above 10 m) | 0.5 m² |

  A method can set a coarser floor (a walkway is never finer than its 5 cm
  grid). A value that rounds across a band edge (0.98 m, estimated, rounds up
  to 1.0) takes the step of the band it lands in.
- **Words** (`format.ts`):
  - "≈" unless the value is measured or calibrated;
  - "at least ≈ 2.2 m" for a lower bound, and "typical ≈ 0.9 m" for a
    category's typical size;
  - "< 0.05 m" for a positive value smaller than its step, and "—" when
    unavailable;
  - the basis in the compiler's words, with ", as edited" when it describes an
    edit. The demonstration room, which has no evidence, is `default` with
    source `demo:authored` and reads "authored, not measured".
- **Verdicts** (`atLeast(m, threshold)`) are `yes`, `no` or
  `too-close-to-call`. A value within its own step of the threshold is too
  close to call, and a lower bound below the threshold is too close to call,
  never no. No probability is claimed.

### 15.3 Measurements supported

- **Room** (`room.ts`): width, depth and height, floor area, perimeter.
- **Floor** (`floor.ts`): total floor area, free floor, occupied floor, and
  circulation area with where it was reached from (§15.4).
- **Each piece** (`objects.ts`):
  - size (width, depth, height) with its scale applied;
  - plan extent across and along the room, bottom and top height, and
    footprint area;
  - whether it stands on the floor, as the reconstruction placed it;
  - the nearest wall, the gap to it, and whether that gap is too small to tell
    from touching;
  - the nearest floor piece and the true distance between the two turned
    footprints, corner to corner included;
  - for a piece with a front, the clear floor straight out in front and what
    ends it (a piece, a wall, or the edge of the room where no wall was seen).
  - `clearAround` gives the same on all four sides.
- **Openings** (`openings.ts`): width, height and sill. For a doorway it also
  gives the clear depth straight in across its full width and what ends it,
  and each piece standing in its 0.9 m clear zone with how far in.
- **Distance** (`distance.ts`): the plan distance between any two pieces,
  walls or openings. It is 0 when they touch or overlap.
- **Walkway** (`walkways.ts`): the floor as a 5 cm distance field to the
  nearest standing piece or wall.
  - Routes start on a doorway's threshold, between its jambs, and a route
    reaches a piece within 35 cm of it.
  - Of all routes from a doorway to a piece, it reports the widest route's
    narrowest point: its width, where it is, and the one or two things that
    bound it (a door frame is named as such).
  - It reports "unreachable" with a reason, or "no doorway", rather than a
    number.
  - It knows nothing of door swings or turning circles, and is never shown
    finer than 5 cm.

### 15.4 Free floor vs walkable/circulation area

Two different metrics. Neither replaces the other, and both are shown side by
side:

- **Free floor = geometrically unoccupied floor surface.** It is exact: the
  room polygon minus the union of the standing pieces' turned footprints,
  overlaps counted once and clipped to the room. Anything 5 cm high or lower,
  a rug for example, does not take floor (the same obstacle rule as
  circulation).
- **Walkable / circulation area = the 4B path heuristic's area.**
  `circulationOf(scene).walkableArea`, read unchanged: where the centre of a
  60 cm path can be, reached from a doorway, on a 10 cm grid (§14.3). The
  value is identical to 4B's own (asserted in a test). It is labelled
  "circulation" with its definition, and 4B's "walkable floor" wording and
  thresholds are untouched.

On the real room they are ≈ 18 m² (18.169) and ≈ 7.5 m² (7.297). 4B's grid
count of open floor (17.966 m²) agrees with the exact free floor to within the
grid's error, which the test bounds at 0.5 m².

### 15.5 Edited vs found

- A Scene value is **edited** when it differs from the value its evidence
  recorded by more than the compiler's rounding: 1.5 mm for lengths, 0.02° for
  turns. A piece with no evidence entry (added) or a different category
  (replaced) is not the piece in the photograph: its values are `default` and
  edited.
- A measurement is edited when any of its inputs is. Moving a piece does not
  change what is known of its size, so its size is still "as found".
- In the words: the basis gains ", as edited", and the title block's Floor row
  adds "measured on the room as edited".
- **Verified in the browser:** previewing a layout marks the floor "as
  edited". Exiting the preview, or undoing an applied layout, brings the
  as-found text back exactly. Previewing a finish-only design leaves the floor
  readings unchanged, because finishes move no geometry.
- **Tested:** measuring an applied layout leaves the original room, measured
  as found, byte-identical.

### 15.6 Typed spatial questions (`questions.ts`)

`answer(scene, evidence, question)` returns either
`{ ok: true, text, measurements, verdict? }` or `{ ok: false, reason }`. Each
answer is one plain sentence naming what was measured and how it is known.
Uncalibrated rooms add "Not calibrated: every length shares one unknown scale
error."

| Question | Example |
| --- | --- |
| `room-size` | How wide is the room? |
| `object-size` | What is the sofa's approximate size? |
| `distance` | How much space is between the sofa and the coffee table? |
| `clearance` | How much clearance is there around this chair? |
| `free-floor` | How much floor is free? |
| `circulation-area` | How much walkable (circulation) floor is there? |
| `walkway` | How wide is the way to the sofa? |
| `circulation-at-least` | Is there at least 80 cm of circulation space (on the way from a doorway to every seat)? |

This is a typed API only. There is no natural-language reading of these
questions and they are not wired into the command bar.

### 15.7 In the workspace

- **Title block** (reconstructed rooms):
  - The Extent row reads "≈ 3.7 × 6.4 × 3.0 m", then "estimated, not
    calibrated", then what an axis cannot claim ("depth is a stated default: a
    side of the room was not seen").
  - A new Floor row reads "≈ 18 m² free · ≈ 7.5 m² circulation", with "free:
    not under furniture · circulation: where a 60 cm path can run from the
    doorway" beneath, and "measured on the room as edited" when it is.
  - The demonstration room keeps its authored Extent figures and has no Floor
    row.
- **Inspector, Size row:** the same honest series, with what it cannot claim
  on a line beneath. For the sofa that is "≈ 2.2 × 0.90 × 0.95 m" over
  "estimated · width at least this (seen in part)"; for Armchair 1, "≈ 0.9 ×
  0.9 × 0.9 m" over "inferred · width, depth, height typical (not seen)". The
  demonstration room keeps its authored figures.
- **Inspector, Space section:** up to five rows, each with its basis beneath:
  - In front ("≈ 0.35 m to Armchair 2");
  - Nearest ("≈ 0.25 m to Floor lamp");
  - Wall ("against the left wall", "on the right wall", "≈ 1.4 m from the
    left wall");
  - Off floor, for wall-hung pieces;
  - Way in ("≈ 0.55 m at its narrowest, from the glazed door").

  A gap that rounds to zero reads "against …".
- The Floor row and the Space section follow the room once it has been still
  for 200 ms (`useSettled`), at half opacity while they catch up, so a drag
  does not recompute them every frame. There is no new panel, dashboard or 3D
  overlay; the room stays the main thing on screen.

## 16. History, undo and redo

`scene/model/operations.ts` defines the eight operations — `move`, `scale`,
`restyle`, `replace`, `add`, `remove`, `resurface`, `relight` —
`applyOperation` (pure; returns the *same* scene when nothing changes),
`invertOperation` (read against the scene as it stood *before* the operation),
`DEFAULT_TIME_OF_DAY` and `hourName()`, the one place an hour is put into
words for both the command layer and the design engine. Exactness is handled
explicitly: a removed piece comes back with its relationships and its light at
their original indices; a restyle's inverse carries `library: { id, was }` so
a finish that was only tried is dropped again; `timeOfDay: "auto"` and
`on: "auto"` unset a value rather than writing down a default.

`state/document.ts` holds `{ name, scene, past, future }`. `commit()` records
one `Edit` (operations + inverses + label + optional `mergeKey`), collapsing
consecutive edits of one gesture; `seal()` ends a gesture; `undo`/`redo` apply
inverses in reverse. History is bounded at 120 entries.

`state/store.ts` (`WorkspaceStore`) is the single source of truth for the
workspace: document, selection, tool, derived preview scene, command proposal,
**design session**, command note, limitation, receipt. Three routes reach the
history and they are the same route:

| What the person did | How it is committed |
| --- | --- |
| A drag, a slider, a panel | `apply(intent)`, gestures merged by `mergeKey` |
| A command ("make the room warmer") | `acceptProposal()` — all kept changes as **one** entry, titled by `titleOf` |
| A design or a layout ("give me 3 modern designs", "give me three furniture layouts" → Apply) | `applyDesign()` — the whole plan (finishes, light and/or `move`s) as **one** entry, titled by the proposal |

`apply`, `undo` and `redo` also clear the receipt and any design preview, so
the receipt's own Undo can never take back a different step and a preview is
never left lying over a room it was not built for.

Measurements (§15) never reach the history: they are read, not applied.

## 17. Current tests

`npx vitest run` — **200 tests in 13 files, all passing** (node environment,
`vitest.config.mts`), run on 26 September 2026 on the current working tree.

| Phase | Tests | Files |
| --- | --- | --- |
| Phase 3 / 3E | 83 | 6 |
| Phase 4A | 37 | 2 |
| Phase 4B | 44 | 3 |
| Phase 5 | 36 | 2 |

Phase 3 (83, unchanged by Phases 4A, 4B and 5):

- `src/scene/compile/compileRoomShell.test.ts` (15) — shell, camera,
  byte-determinism, inferred height, calibration by one measurement and by
  several with residuals, failures, axis alignment, `parseIntermediate`.
- `src/scene/compile/materials.test.ts` (17) — colour per region, gloss from
  the floor's mirror image, measured tiles, wall unification, class
  fallbacks, light colour not applied twice, lamp switch, direction
  cross-check, determinism, editing a reconstructed finish through history.
- `src/scene/compile/objects.test.ts` (9) — score bars, completed depth,
  placement and support, wall-hung measurement, openings and daylight,
  relationships, id stability across recalibration, shell-only compile.
- `src/scene/compile/realRun.test.ts` (2) — real worker output for the MoGe
  example photograph: every surface traces to a plane or a rule; same bytes
  every time.
- `src/features/workspace/ai/rules/commands.test.ts` (21) — reading into the
  strict intent, the provider boundary, resolution, moves worked out from the
  scene, rotate/resize/remove, materials and light, determinism, one history
  step per command.
- `src/features/workspace/ai/rules/realRoom.test.ts` (19) — the same, against
  the real `download.png` room, including the eight-command sequence run
  through the history with strict equality on undo and redo, and a
  store-level assertion that the receipt is cleared by an undo.

Phase 4A (37):

- `src/features/workspace/design/design.test.ts` (22) — telling a design
  request from an edit command; styles, axes, negation and variant counts;
  session acts; the provider boundary refusing unknown styles, out-of-range
  axes and bad variant counts by name; a model's JSON giving byte-identical
  proposals to the rules'; the analysis matching the Scene field for field;
  six presets with distinct palettes and three variants each; style choice
  from axes; nudging without replacing; three distinct proposals; the spread
  across styles; finishes-and-light only; floors kept or coloured; nothing
  proposed that the room already has; byte-identical output; the validator
  passing what the engine makes and refusing bad ids, bad classes, bad light
  values, adds, removes, replaces and transforms that leave the room; session
  status transitions and ordinals.
- `src/features/workspace/design/realRoomDesign.test.ts` (15) — the same
  against the real `download.png` room: the analysis's real numbers; three
  modern designs each valid and distinct; a Scandinavian one lighter and
  earlier; warmer-and-more-luxurious measurably warmer across the whole
  palette and in the light; darker-and-contemporary with the ceiling still
  lighter than the walls and the palette still holding range; a cozy one with
  the unlit lamp switched on; structure untouched; "already reads that way";
  determinism; and through the store — preview isolation by identity *and*
  serialization, apply as one history step with exact undo and redo, taking a
  design by its place on screen, designs and commands side by side, and a
  design preview dropped when a command takes the room.

  Phase 4B changed one line here: the analysis version expected is now
  `design-analysis-0.2`.

Phase 4B (44):

- `src/features/workspace/design/layout/layout.test.ts` (12) covers:
  - telling a layout request from a direct command, and reading the
    arrangement asked for without inventing finishes;
  - a finish style and a layout read together, and acts on layouts already on
    screen;
  - the provider boundary refusing non-layout intents by name, with no way to
    name a position or an operation;
  - spatial roles derived deterministically with a reason each, and the way in
    and what stands in front of it;
  - layouts for the demonstration room (a second, different room): arranged
    by its own geometry; "no screen" said rather than arranged around; a
    carried piece moved with its carrier and refused alone; determinism.
- `src/features/workspace/design/layout/realRoomLayout.test.ts` (24), on the
  real room:
  - three layouts named from the room, each a different arrangement, moving
    only what may move and only what each direction needs;
  - each direction's effect: seats turned in round the table (with the
    relationships showing it), every touched seat turned to the screen, more
    walkable floor with the glazed door cleared, and the close conversation
    reading;
  - a finish style and a layout as one proposal, and a piece moved out of the
    way deterministically;
  - the hard constraints: leaving the room, collisions, the doorway, shutting
    a seat in, wall-hung and anchored pieces, and a layout rejected before it
    is shown, with the reason;
  - byte-identical layouts, and relationships recomputed exactly as the
    compiler recorded them;
  - through the store: preview without touching the document and the exact
    room back on exit, apply as one history step with exact undo and redo, a
    layout taken by its place on screen, direct commands and their ambiguity
    handling kept with layouts on screen, and "can't be made" said rather
    than invented.
- `src/features/workspace/reconstruction/calibration.test.ts` (8) covers:
  - the run-file route: 204 for a run with no calibration, 200 for one that
    exists, 404 for a missing run or a non-optional or unknown file;
  - the loader: an uncalibrated run opens with its scale estimated and nothing
    reported, and a calibration the run has is applied;
  - a server failure, a network failure, invalid JSON and the wrong schema are
    each reported, never treated as "no calibration".

Phase 5 (36):

- `src/features/workspace/measure/measure.synthetic.test.ts` (28), on
  hand-built scenes with exact answers:
  - the room: width, depth, height, area, perimeter, bases, and an unseen side
    as a lower bound;
  - a piece: scale and turn applied, true corner-to-corner distance, a wall
    gap told apart from touching, clear floor in front and on every side;
  - a doorway's clear depth and what stands in its zone;
  - walkways: the narrowest point and what bounds it, "at least" verdicts,
    the doorway itself, and unreachable or no way in;
  - free floor against circulation: an empty room, overlaps counted once,
    clipping to the room, a rug walked over, a turned footprint rather than
    its bounding box;
  - provenance: weakest basis, lower bounds and typical sizes carried
    through, edits marked on exactly what they touched, the demo room
    "authored", σ passed through only when present, and evidence for another
    Scene ignored;
  - calibrated against estimated through the real compiler: bases flip,
    lengths scale, steps tighten, and σ stays null with several references;
  - rounding steps and words, "too close to call", determinism, the Scene
    never written, and "unavailable" rather than a thrown error or an
    invented number.
- `src/features/workspace/measure/measure.realRoom.test.ts` (8), on the real
  `download.png` room:
  - sizes and bases agree with the evidence, and free floor and circulation
    each match their own definition;
  - seen, seen-in-part and typical sizes are told apart;
  - the sofa is against the left wall, the table stands in front of it, and
    the armchair is at the glazed door;
  - the way in is narrowest between the door frame and that armchair;
  - no precision is claimed beyond what the reconstruction has;
  - an applied layout is measured as edited while the room as found stays
    unchanged, and repeated runs give identical results.

Worker (`~/datum-recon`, `python -m pytest -q tests`): **35 passed**;
`ruff check` clean, `mypy` clean on 15 source files, as recorded at Phase 4A.
Phases 4B and 5 changed no Python and no worker code, and the suite was not
re-run for them.

**Verified on the current working tree (26 September 2026):**

- `npx vitest run`: 200/200. In one earlier full run during Phase 5, a single
  4B test ("never moves the room itself, or what is anchored in it", about
  2.8 s) failed once. It passed on every run since: six full-suite runs and
  once in isolation. The failure's cause was not captured.
- `npx tsc --noEmit`: clean. `npm run lint` (eslint): clean.
- `npm run build`: compiled, TypeScript clean, 11/11 pages, with
  `CIRCLE_NODE_TOTAL=3` (2 workers). The default build, with 15 page-data
  workers, crashed natively ("Zone Allocation failed - process out of memory")
  while the machine had about 1.2 GB of free commit memory. That is a machine
  constraint, not a code fault, and no config was changed. No source file has
  changed since that build.

**Headless browser verification.** A throwaway Node script, kept outside the
repository, drove headless Chrome (1440×900, SwiftShader) over the DevTools
protocol against the production build (`npx next start -p 3100`) and the real
reconstruction `/workspace/reconstruction/20260922T065240Z-2d25a689`. It used
real mouse and keyboard input, compared serialized Scenes and object
identity, and pixel-diffed screenshots.

- **Main run: 32/32 checks pass.**
  - The 21 Phase 4B steps: three distinct layouts; preview changes the
    screen and not the document; exit restores the exact original; apply adds
    exactly one history step; undo and redo return the exact Scenes; "Make
    the seating more social." produces a spatial change (on top of the
    applied layout, "Close conversation" moves Armchair 1 by 32 cm); and no
    console errors.
  - Phase 3E, within those steps: "Move the sofa 20cm left." is still
    answered by the Phase 3E interpreter ("the wall is in the way"), and
    "Move the chair." still asks which of three chairs is meant.
  - Phase 5 checks P5-1–P5-5: honest Extent and Floor rows; Inspector sizes
    and Space readings for the sofa (seen in part), Armchair 1 (not seen),
    the television (wall-hung) and the coffee table; the floor measured "as
    edited" during a layout preview, and as found again after exit and after
    undo.
  - Six viewport sizes, from 1920×1080 to 360×740: no overlap and no
    horizontal scroll.
- **Phase 4A run: 7/7 checks pass.** "Give me 3 modern designs" gives three
  finish proposals. Preview changes the screen and not the document, exit
  restores the exact original, and apply adds one history step. Undo and redo
  return the exact Scenes, and a finish preview leaves the floor readings
  unchanged. Console: 0 errors.
- **Console, both runs: zero application errors.** Two warnings do not come
  from the app's own code and also appeared in the Phase 4B run: the headless
  renderer lacks `KHR_parallel_shader_compile`, and Next.js reports a CSS
  preload not used within a few seconds.

## 18. Known limitations

**Design engine (Phase 4A)**

- A finish proposal changes **finishes, colours and light only**. Furniture
  is moved and turned only by a layout (Phase 4B, below); nothing is ever
  resized by a design.
- No furniture is added or removed by a design, and none can be: `add`,
  `remove` and `replace` are refused outright. There is no asset library
  behind the engine.
- A proposal recolours; it never changes what a thing is made of. Changing a
  material class stays the command layer's job.
- At most **3 variants** per request; a larger number is refused by the
  schema with the reason, not silently clamped.
- The intent reader is a deterministic vocabulary of style and atmosphere
  words. A style it has no word for is read as the nearest style it does have
  rather than refused, and the design/edit split is that vocabulary: a bare
  "make the room warmer" stays an edit.
- The style presets, their palettes and the axis weights are **provisional**.
  There is no evaluation set and no user study behind them.
- A proposal carries no evidence and claims none; it is a choice.
- The finish analysis lists the seating and the focal piece but does not
  describe the seating *arrangement*. Since Phase 4B the layout half
  (`DesignAnalysis.layout`, §14.2) records the primary and secondary seats,
  the focal screen and table, and the relationships recomputed from the
  geometry, and only layouts use them.
- **No real LLM provider is connected.** `DesignIntentProvider` exists and is
  enforced by `validateDesignIntent`; the only implementation is the rule
  reader. No provider, credential path or network call exists in the layer.

**Spatial layout (Phase 4B)**

- **The planner is a heuristic.** It places one piece at a time and finds a
  good arrangement, not the best possible one. Its weights and thresholds are
  provisional, with no evaluation set behind them.
- **Scope of moves:**
  - only existing `movable` floor pieces are moved or turned;
  - wall-hung, ceiling-hung, carried, flat and anchored pieces stay put;
  - nothing is added, removed or resized, and a request gets at most 3
    layouts.
- "Anchored" is a rule of this layer, not a property of the Scene.
- **Circulation is a design heuristic, not an accessibility assessment.** It
  knows nothing of door swings, and a doorway is found by shape alone.
- **Relationships are recomputed, never written back.** Applying a layout, or
  dragging a piece, leaves the Scene's recorded relationship list as it was.
  Phase 3E re-checks geometry for most relationships but trusts the recorded
  "faces".
- **Some readings cannot fully work on the fixture room:**
  - in the TV and conversation layouts Armchair 2 stays in front of the
    glazed door, because a moved piece may not stand further into a doorway
    than it already did (the card says so);
  - "Face to face" does not manage to set a chair opposite the sofa.
- **The reader is a vocabulary, not a model.** A sentence that starts with a
  direct verb stays a command, so "move the chairs closer together" goes to
  the command layer.
- **Speed:** about 0.1–0.5 s per request on the real room, and up to about
  1 s when readings fall back to others.
- **Precision on the card:** 4B's cards print walkable floor to 0.1 m² ("7.3
  m² → 9.0 m²", from `report.ts`). Phase 5's title block shows the same
  quantity rounded by basis ("≈ 7.5 m² circulation"). This was left alone
  because 4B is frozen.

**Measurement (Phase 5)**

- **No numeric uncertainty exists.** σ, interval and confidence are null
  everywhere, because the scale's error has not been measured (it needs a
  tape-measured evaluation set). Rounding stands in for it, and it is a
  display step, not an error bar. Every length in an uncalibrated room shares
  one unknown scale error, and the typed answers say so.
- **Single-photo geometry:**
  - visible widths are lower bounds, and unseen sizes are category priors;
  - the room's depth toward the camera is a `default` on the fixture, so every
    floor area inherits `default`;
  - rooms are rectangles and footprints are boxes;
  - calibration would fix scale, not shape (the fixture's two
    field-of-view estimates disagree).
- **Edits:** a measurement of edited geometry describes the design, not the
  physical room. It is marked, not corrected.
- **Walkway widths:** 5 cm grid steps on top of the scale error; no door
  swings or turning circles; not an accessibility check.
- **Floor contact** is the compiler's placement, not a measured contact.
- **Typed questions only:** the spatial question API is not reachable from
  the command bar, and nothing reads a spoken or typed question into it.
- **A gap of exactly zero** formats as "≈ 0.00 m" in the typed API. The
  Inspector shows "against …" instead.
- **Where it shows:** the title block, and so the Floor row, appears only at
  desktop widths. Tablet and phone layouts hide the title block, as before.
- **No in-app calibration:** the app offers no way to enter a measurement or
  calibrate, so every room here is scale `estimated`, factor 1.

**Not wired up**

- No language model anywhere: `ruleReader` and `designRules` are the only
  readers, and the workspace says plainly that they are rule-based.
- The entry page (`/workspace`) reads a photograph in the browser and
  measures its tones; it cannot start a reconstruction. Runs are made by hand
  in WSL and read back through `DATUM_RECONSTRUCTION_RUNS`.
- **Calibration remains deferred in the product.** The compiler applies a
  `calibration.json` and reports residuals, but the only way to make one is
  the worker's CLI. Phase 5 derives and shows measurements from the Scene; it
  takes no measurement from the person.
- Nothing is persisted: documents, edits, renames, scenes and design sessions
  live in memory for the session only (measurements are not stored at all).
  There is no scene serialisation format and no way to save or share a
  design.
- Reconstruction routes are development-only by construction and answer 404
  when the environment variable is unset.

**Compiler**

- Rectangular rooms only: walls more than 12° off an axis are reported and
  ignored, and the footprint is always a centred rectangle.
- One view per run; the wall behind the camera is omitted from the surfaces;
  an unseen side is a lower bound, and its basis is `inferred` or `default`.
- Room type is never estimated (always `other`); camera roll cannot be
  represented; `sigma`, `interval` and `confidence` are null everywhere, and
  all priors and thresholds are provisional until there is an evaluation set.
- Vocabulary gaps are reported, not guessed: stool, ceiling fan and wall
  clock are "seen, not modelled"; a table lamp has no builder; a phrase
  outside the vocabulary is rejected by name.
- Materials keep the photograph's light in their colours by design;
  roughness is measured only where a floor mirrors an opening.
- The daylight hour is not recoverable from a photograph; lamp colour
  temperature is a fixed 2700 K.

**AI command layer**

- One piece per move; no adding furniture (no asset library); replacement is
  limited to the forms the renderer can build; windows and doors can be
  named but not moved, resized or removed; "empty the room", "into the
  corner" and "into the middle" are answered as not available.
- No multi-step planning, no conversation memory and no transcript: each
  command is read on its own, with the current selection as its only context.
- Ambiguity is always a question back, never a guess, which means some
  reasonable commands need a second click.

**Elsewhere**

- Categories without a dedicated renderer builder are drawn as their bounding
  volume.
- The worker needs its pinned weights present and hash-matching; there is no
  CPU fallback for the main inference.
- On this development machine a default `next build` can run out of memory in
  page-data collection when little memory is free. Building with fewer workers
  (`CIRCLE_NODE_TOTAL=3`, §19) passes.

**Intentionally out of scope (Phases 4B and 5)**

- Image generation, image-to-image redesign, shopping, video, multi-photo
  reconstruction, new GPU models or worker stages, and a real LLM or chatbot.
- A second Scene representation, measurements written into the Scene, or a
  second provenance or calibration system.
- An in-app calibration or measurement-entry UI; a measurement dashboard or 3D
  measurement overlays.
- Natural-language routing of spatial questions through the command bar.
- Any change to the 4B planner, validator, strategies or thresholds in Phase
  5, including its "walkable floor" wording and metric.
- A GPU re-run of `download.png` and tape-measured ground truth. Real-room
  validation used the existing run and fixture (§20).
- Committing or pushing Phases 4B and 5 (§22).

## 19. Dev and run commands

```bash
# web app (repo root)
npm run dev          # next dev
npm run build        # next build
npm run start        # next start  (verification used: npx next start -p 3100)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest run

# when little memory is free: Next derives its build worker count from this
CIRCLE_NODE_TOTAL=3 npm run build
```

`.env.local` for local reconstructions (development only):

```
DATUM_RECONSTRUCTION_RUNS=\\wsl.localhost\Ubuntu\home\datum\datum-recon\runs
```

Routes: `/workspace` (entry), `/workspace/demo` (the hand-authored room),
`/workspace/reconstruction` (local runs), `/workspace/reconstruction/[runId]`
(a run compiled in the browser and opened in the workspace), and the
dev-only API `/api/reconstructions/local[/<runId>/<file>]`, which serves only
five named files and never leaves the runs directory. `calibration.json` is
optional: absent from a run that exists, it answers `204` with
`X-Run-File: absent` (§14.9).

```bash
# worker (WSL: Ubuntu only, never Ubuntu-20.04)
wsl -d Ubuntu
cd ~/datum-recon && source .venv/bin/activate
python -m reconstruction.worker --input /path/to/room.jpg
python -m reconstruction.calibrate --run runs/<runId> --plane plane-2 \
  --a 812,540 --b 1010,541 --metres 0.9 --label "door width"
python -m compileall -q reconstruction tests && ruff check reconstruction tests \
  && mypy reconstruction && python -m pytest -q tests
```

## 20. Current reconstruction fixture

`src/scene/compile/__fixtures__/download-png.intermediate.json` (251 KB) is
byte-identical to `runs/20260922T065240Z-2d25a689/reconstruction.json` — real
worker output for `download.png`, pipeline `0.1.0+e43837069c3a`, a 1254 × 1254
image, diagnostics `degraded` with one warning (GeoCalib and MoGe-2 disagree
on the vertical field of view). It holds 18 planes, 39 instances, 83
appearance regions and the light observation. The SHA-256 of
`C:\Users\yagya\Downloads\download.png` begins `2d25a689d7f77ec5`, which is
the compiled Scene's `sourceImageId`.

Compiled, it is the room every AI, design, layout and measurement test and the
browser verification run against: **3.724 × 6.418 × 2.998 m**, camera FOV 59.14°,
scale uncalibrated (factor 1, `estimated`), the far/left/right walls observed
and the side behind the camera omitted.

- **16 objects**: sofa, 2 armchairs, chair, coffee table, media console,
  bookshelf, ottoman, floor lamp, television, 4 artworks, 2 curtains.
- **1 opening**: `window-0`, "Glazed door", in the far wall.
- **5 surfaces**, **26 materials** (ceramic glossy floor, one unified wall
  paint, per-piece finishes, two stand-ins), **3 lights** (neutral ambient,
  diffuse daylight through the glazed door, the floor lamp seen unlit),
  **21 relationships**.
- Reported and not emitted: a ceiling fan and a wall clock (no builder),
  several windows seen through the glazed door (not set in a fitted wall),
  one chair whose mask was not trusted, and 13 low-score candidates.

As the design analysis reads it: floor area 23.901 m², 18.169 m² free,
density 0.24; 5 seats, 7 wall-mounted pieces, `television-0` focal, `sofa-0`
largest; 28 object finish slots over 24 distinct colours; mean lightness
0.282, contrast 0.534, saturation 0.333; hour 0.18 (never set), one lamp,
unlit; `sofa-0` against `wall-left`, `bookshelf-0` against `wall-far`,
`media-console-0` against `wall-right`.

What the directions come to on this room (operations per proposal, all with
15 pieces and 2 lights touched):

| Request | Proposals |
| --- | --- |
| "Give me 3 modern designs." | Modern Warm 32 · Modern Neutral 30 · Modern Dark Accent 33 |
| "Give me a Scandinavian design." | Scandinavian Light 31 |
| "Make this room feel warmer and more luxurious." | Classic Ivory 32 |
| "Make this room darker and more contemporary." | Dark Charcoal 31 |
| "Give me a cozy design." | Cozy Amber 32 |
| "Give me 3 designs." | Modern Warm 32 · Scandinavian Light 31 · Minimal Pale 29 |

Minimal Neutral keeps this room's ceramic floor; every other style gives it
the style's own floor colour while keeping its measured tile pattern and
gloss.

**As the layout analysis reads it (Phase 4B).** The seating is:

- primary: `sofa-0`;
- secondary: `armchair-0`, `armchair-1`, `chair-0` and `ottoman-0`;
- focal: `television-0`, with `coffee-table-0` as the table.

The 21 recomputed relationships equal the recorded ones, and none are stale.
Mobility:

- movable: sofa, both armchairs, chair, ottoman, coffee table and floor
  lamp;
- anchored: the bookshelf (storage standing against the far wall) and the
  media console (the television hangs above it);
- wall-mounted: the television, the 4 artworks and the 2 curtains.

Circulation, on 4B's 10 cm grid, reached from the glazed door:

- open 17.966 m², occupied 5.935 m², walkable 7.297 m²;
- the glazed door is reachable, but `armchair-1` stands in its clear zone;
- all 5 seats are reachable.

What the layouts come to on this room (each moves 2 pieces, `move`
operations only):

| Request | Proposals, and what moves |
| --- | --- |
| "Give me three furniture layouts." | **Around the television**: Armchair 1 turned 108° to face the television; Chair moved 82 cm, turned 115° · **Conversation around the coffee table**: Armchair 1 moved 10 cm, turned 136° towards the table; Chair moved 1.3 m, turned 3° · **Open floor**: Armchair 2 moved 2.8 m to the right wall, turned 91°, out of the glazed door's way; Armchair 1 moved 88 cm to the left wall, turned 61° |
| "Make the seating more social." | Conversation around the coffee table (on the unedited room; with that layout already applied the browser run got "Close conversation", Armchair 1 moved 32 cm) |
| "Make the room more open." | Open floor |
| "Arrange the room around the TV." | Around the television |
| "Give me a cozy conversation layout." | Close conversation: Armchair 1 moved 33 cm up to the table, turned 141°; Chair moved 1.4 m, turned 3° |

4B's own walkable floor on the cards: 7.3 m² → 7.8 m² (television,
conversation), → 9.0 m² (open), → 7.7 m² (close conversation).

**As the measurement layer reads it (Phase 5).** The values are as computed,
nothing was adjusted, and there is no ground truth: nobody has tape-measured
this room, so this checks consistency and honesty, not accuracy. The scale is
`estimated` from the depth model, with 0 references and no `logSigma`. Every
value below has σ, interval and confidence null, is not edited, and is shown
no finer than 5 cm or 0.5 m².

| Measurement | Shown | Raw | Basis |
| --- | --- | --- | --- |
| Room width · depth · height | ≈ 3.7 × 6.4 × 3.0 m | 3.724 · 6.418 · 2.998 | estimated · **default** (the wall behind the camera was not seen) · estimated |
| Floor area · perimeter | ≈ 24 m² · ≈ 20.5 m | 23.901 · 20.284 | default |
| Free floor | ≈ 18 m² | 18.169 | default |
| Occupied floor | ≈ 5.5 m² | 5.732 | default |
| Circulation area (4B heuristic, from the glazed door) | ≈ 7.5 m² | 7.297 | default |
| Sofa size | at least ≈ 2.2 × ≈ 0.90 × ≈ 0.95 m | width 2.192 (a lower bound: seen in part) | estimated |
| Armchair 1 size | typical ≈ 0.9 m on each side | 0.850 (the category's typical size) | inferred |
| Sofa ↔ coffee table | ≈ 0.50 m apart in plan | | estimated |
| Sofa | against the left wall; ≈ 0.35 m clear in front to Armchair 2; nearest the floor lamp, ≈ 0.25 m | | estimated |
| Coffee table | ≈ 1.4 m from the left wall; nearest Armchair 2, ≈ 0.45 m | | estimated |
| Glazed door | ≈ 1.4 m wide (estimated), ≈ 2.3 m high (inferred); ≈ 0.40 m clear straight in, to Armchair 2; Armchair 2 stands ≈ 0.50 m into its 0.9 m zone | | estimated / inferred |
| Way in to the sofa | ≈ 0.55 m at its narrowest, between the glazed door frame and Armchair 2 | 0.550 | estimated |
| "At least 80 cm of circulation?" | **No**: the way to 4 of the 5 seats is narrower than 80 cm | | estimated |

After each of the three layouts is applied, free floor stays ≈ 18 m² and
circulation is ≈ 8, ≈ 8 and ≈ 9 m². All read "default, as edited", while the
room's width is not marked edited.

Other fixtures: `moge-example-house-indoor.intermediate.json` (+ its compiled
form) for `realRun.test.ts`, and `synthetic.ts`, which builds observations of
a known room so the compiler — and the design engine — can be tested against
ground truth.

## 21. Important files and directories

```
src/scene/model/           types.ts (the Scene contract), operations.ts, queries.ts,
                           summary.ts, colour.ts (sRGB arithmetic, shared)
src/scene/compile/         the SceneCompiler: intermediate.ts (worker contract), compileRoomShell.ts,
                           objects.ts, vocabulary.ts, materials.ts, lighting.ts, relationships.ts,
                           calibration.ts, evidence.ts, priors.ts, frame.ts, __fixtures__/
src/scene/render/          SceneStage.ts and the parametric object builders; reads a Scene, nothing else
src/features/workspace/
  state/                   document.ts (history), store.ts (WorkspaceStore), edits.ts (every edit intent)
  ai/                      interpreter.ts (boundary), intent.ts (schema + validator), command.ts
                           (StructuredCommand + validateCommand), roomInterpreter.ts,
                           rules/{read,resolve,compile,spatial,vocabulary,messages}.ts + 2 test files
  design/                  the Phase 4A engine: styles.ts (presets + variants), analysis.ts
                           (DesignAnalysis), intent.ts (DesignIntent + validator), read.ts (the
                           deterministic provider), generate.ts (ProposalGenerator), validate.ts,
                           proposal.ts, session.ts, messages.ts, index.ts,
                           DesignDirections.tsx + .module.css, + 2 test files
  design/layout/           the Phase 4B layout engine: roles.ts, analysis.ts (LayoutAnalysis),
                           circulation.ts, geometry.ts (PASSAGE, relationsOf), intent.ts
                           (LayoutIntent), read.ts, layouts.ts, strategies.ts (READINGS),
                           planner.ts (PLANNER), validate.ts, report.ts, index.ts, + 2 test files
  measure/                 Phase 5 measurement: types.ts (Measurement, rounding, verdicts),
                           provenance.ts (inputs, edited-vs-found), geometry.ts, room.ts, floor.ts,
                           objects.ts, openings.ts, distance.ts, walkways.ts, questions.ts,
                           format.ts, scene.ts (measureScene), index.ts, + 2 test files
  command/                 CommandBar.tsx (one line, kinds of answer, clickable choices), ChangeProposal.tsx
  reconstruction/          loadRun.ts (readCalibration), localRuns.ts, ReconstructionIndex/Workspace.tsx,
                           describe.ts, calibration.test.ts
  SceneTitleBlock.tsx      the room's title block: Extent and Floor rows (Phase 5)
  InspectorSpace.tsx       the Inspector's honest Size row and Space section (Phase 5)
  useSettled.ts            a value once it has stopped changing (Phase 5)
  panels/, Inspector.tsx, Viewport.tsx, TopBar.tsx, scene/  the workspace itself
src/app/workspace/         /workspace, /workspace/demo, /workspace/reconstruction[/runId]
src/app/api/reconstructions/local/   dev-only run listing and file reading
src/demo/                  the hand-authored demonstration room
docs/reconstruction-architecture.md  the design document (committed)
~/datum-recon (WSL)        the Python worker: reconstruction/*.py, tests/, weights/, runs/
```

## 22. Git and implementation status

Branch `landing-workspace-refinement`, HEAD `af38165` (docs: update current
implementation state after phase 4A). Phases 3, 3E and 4A are committed.
**Phases 4B and 5 are implemented and verified (§17) but uncommitted.**
Nothing is staged, nothing is committed on top of `af38165`, and nothing has
been pushed.

Working-tree changes, by phase:

- **Phase 4B, modified (21):**
  - `design/`: `intent.ts`, `read.ts`, `analysis.ts`, `generate.ts`,
    `proposal.ts`, `validate.ts`, `messages.ts`, `index.ts`,
    `DesignDirections.tsx`, `DesignDirections.module.css`, `design.test.ts`;
  - `scene/compile/relationships.ts`, `ai/rules/spatial.ts`;
  - calibration polish: `reconstruction/localRuns.ts`,
    `reconstruction/loadRun.ts`, `reconstruction/ReconstructionWorkspace.tsx`,
    `sourceContext.ts`;
  - rail polish: `SceneTitleBlock.tsx`, `SceneTitleBlock.module.css`,
    `Workspace.tsx`, `Workspace.module.css`.
- **Phase 4B, new:** `design/layout/` (14 files, 2 of them tests) and
  `reconstruction/calibration.test.ts`.
- **Phase 5, modified:** `Inspector.tsx` and `Inspector.module.css`, plus
  further edits to `SceneTitleBlock.tsx` and `SceneTitleBlock.module.css`
  (already modified by 4B).
- **Phase 5, new:** `measure/` (15 files, 2 of them tests),
  `InspectorSpace.tsx` and `useSettled.ts`.
- **This file**, `CURRENT_STATE.md`, updated for Phases 4B and 5.

That is 23 modified source files under `src/` plus this file, and 32 new
files. No `package.json`, lockfile, config or worker file changed.

Some working-copy files have Windows (CRLF) line endings, from script-based
edits during Phases 4B and 5. The repository's `.gitattributes`
(`* text=auto eol=lf`) converts them to LF on commit, so the committed content
is unaffected and git's diffs show only the real changes.
