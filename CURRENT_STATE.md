# Current state, after Phase 4A

What is actually implemented, as of 23 September 2026. Nothing here is planned
work: every claim is read from the code in this repository and from the
reconstruction worker in WSL. The design document for where this is going is
`docs/reconstruction-architecture.md`; this file is the inventory.

Repository: branch `landing-workspace-refinement`, HEAD `59a4bcc`. Everything
described below is committed — the reconstruction compiler and the AI command
layer in `20eff6c`, the design proposal engine in `59a4bcc`.

Stack: Next.js 16.3.5 (App Router), React 19.2.8, three 0.186, TypeScript 5,
vitest 4.1.11. The reconstruction worker is a separate Python 3.12 package in
WSL, not part of this repository.

The product is two pipelines over one Scene:

```
photograph → worker → intermediate → SceneCompiler → Scene → workspace
                                                       │
                          words → intent → command → operations → history   (3E: do this)
                          words → design intent → proposals → operations → history  (4A: propose this)
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
"calibrated to your measurement" in `SceneTitleBlock`, and per-finish and
per-light readings in `Inspector`, `MaterialsPanel` and `LightingPanel`
through `reconstruction/describe.ts`. Evidence reaches components via
`sourceContext.ts`.

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
- **AI command layer** (`ai/rules/spatial.ts`, 642 lines): footprints as
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
  piece (§13.8).

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
kept apart on purpose and neither can produce the other's result.

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
lines of tests. The product moves from "do what I tell you" to "help me
design this room" **without** a second way to change a room:

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
inference layer, no invented objects. Version `design-analysis-0.1`. It
returns:

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

Deterministic: the same Scene gives the same analysis field for field.

### 13.2 DesignIntent and the provider boundary (`intent.ts`)

`DesignIntent` is what a *request* asks for, and the only thing the generator
accepts:

```
{ version: "design-intent-0.1",
  styles: DesignStyle[],            // empty means "choose for me"
  atmosphere: string | null,        // the words, for the card
  warmth | brightness | contrast |
  luxury | minimalism | coziness: number | null,   // each −1..1
  variantCount: number }            // 1..MAX_VARIANTS (3)
```

`validateDesignIntent(value)` is the provider boundary, and it is as strict as
`validateIntent`: an unknown style is refused **by name**, styles must not
repeat, every axis must be a finite number within −1..1, `variantCount` must
be a whole number between 1 and 3, an unknown `version` is refused, nothing is
coerced. A model placed behind this boundary can ask for a style and an
atmosphere; **it cannot name an operation, an object id, or a colour**. The
generator decides what a style means for a room and the validator decides
whether the result may be shown at all.

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
  preview: { operationCount, changedObjectCount,
             changedMaterialCount, changedLightCount },
  status: "draft" | "preview" | "applied" | "rejected" }
```

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
  without its fixture.

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
one-line description, the three counts (finishes, pieces, lights), and
Preview / Apply / Why; Why unfolds what it changes, the rationale, what it
leaves alone, and "N changes, applied as one step in the history". The header
carries the words that were asked and a Close. Directions that could not be
offered are named with their reason at the foot.

## 14. History, undo and redo

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
| A design ("give me 3 modern designs" → Apply) | `applyDesign()` — the whole plan as **one** entry, titled by the proposal |

`apply`, `undo` and `redo` also clear the receipt and any design preview, so
the receipt's own Undo can never take back a different step and a preview is
never left lying over a room it was not built for.

## 15. Current tests

`npx vitest run` — **120 tests in 8 files, all passing** (node environment,
`vitest.config.mts`).

Phase 3 (83, unchanged by Phase 4A):

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

Worker (`~/datum-recon`, `python -m pytest -q tests`): **35 passed**;
`ruff check` clean, `mypy` clean on 15 source files. Phase 4A changed no
Python and no worker code, so that suite is unaffected.

Verified on the current tree: `npx tsc --noEmit` clean; `npx eslint .` clean
with 0 warnings; `npx next build` compiled successfully; deterministic
proposal output confirmed; preview / apply / undo / redo confirmed.

Browser verification was done by hand on the production build (`npx next start
-p 3100`) against the real reconstruction: open the room → ask for 3 designs →
three cards → preview #1 (the room visibly changes) → exit (the original
returns) → preview #2 → apply (receipt: "30 changes, one step in the history")
→ undo (original) → redo (applied). Phase 3E in the same session: a sofa move
compiled and previewed, "move the chair" answered with three described
options, selection and the inspector unaffected. **No console messages at
all.** It is not automated.

## 16. Known limitations

**Design engine (Phase 4A)**

- Proposals change **finishes, colours and light only**. There is no
  furniture-layout generation: nothing is moved, rotated or resized by a
  design. The validator checks transforms so a future generator can be held
  to the room, but today's generator emits none.
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
- The analysis lists the seating and the focal piece but does not describe the
  seating *arrangement*, though the Scene's relationships would support it.
- **No real LLM provider is connected.** `DesignIntentProvider` exists and is
  enforced by `validateDesignIntent`; the only implementation is the rule
  reader. No provider, credential path or network call exists in the layer.

**Not wired up**

- No language model anywhere: `ruleReader` and `designRules` are the only
  readers, and the workspace says plainly that they are rule-based.
- The entry page (`/workspace`) reads a photograph in the browser and
  measures its tones; it cannot start a reconstruction. Runs are made by hand
  in WSL and read back through `DATUM_RECONSTRUCTION_RUNS`.
- **Measurements and calibration remain deferred in the product.** The
  compiler applies a `calibration.json` and reports residuals, but the only
  way to make one is the worker's CLI; nothing in the app takes a
  measurement, so every scene here is scale `estimated`, factor 1.
- Nothing is persisted: documents, edits, renames, scenes and design sessions
  live in memory for the session only. There is no scene serialisation format
  and no way to save or share a design.
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

## 17. Dev and run commands

```bash
# web app (repo root)
npm run dev          # next dev
npm run build        # next build
npm run start        # next start  (verification used: npx next start -p 3100)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test         # vitest run
```

`.env` for local reconstructions (development only):

```
DATUM_RECONSTRUCTION_RUNS=\\wsl.localhost\Ubuntu\home\datum\datum-recon\runs
```

Routes: `/workspace` (entry), `/workspace/demo` (the hand-authored room),
`/workspace/reconstruction` (local runs), `/workspace/reconstruction/[runId]`
(a run compiled in the browser and opened in the workspace), and the
dev-only API `/api/reconstructions/local[/<runId>/<file>]`, which serves only
five named files and never leaves the runs directory.

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

## 18. Current reconstruction fixture

`src/scene/compile/__fixtures__/download-png.intermediate.json` (251 KB) is
byte-identical to `runs/20260922T065240Z-2d25a689/reconstruction.json` — real
worker output for `download.png`, pipeline `0.1.0+e43837069c3a`, a 1254 × 1254
image, diagnostics `degraded` with one warning (GeoCalib and MoGe-2 disagree
on the vertical field of view). It holds 18 planes, 39 instances, 83
appearance regions and the light observation.

Compiled, it is the room every AI and design test and the browser
verification run against: **3.724 × 6.418 × 2.998 m**, camera FOV 59.14°,
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

Other fixtures: `moge-example-house-indoor.intermediate.json` (+ its compiled
form) for `realRun.test.ts`, and `synthetic.ts`, which builds observations of
a known room so the compiler — and the design engine — can be tested against
ground truth.

## 19. Important files and directories

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
  command/                 CommandBar.tsx (one line, kinds of answer, clickable choices), ChangeProposal.tsx
  reconstruction/          loadRun.ts, localRuns.ts, ReconstructionIndex/Workspace.tsx, describe.ts
  panels/, Inspector.tsx, Viewport.tsx, TopBar.tsx, scene/  the workspace itself
src/app/workspace/         /workspace, /workspace/demo, /workspace/reconstruction[/runId]
src/app/api/reconstructions/local/   dev-only run listing and file reading
src/demo/                  the hand-authored demonstration room
docs/reconstruction-architecture.md  the design document (committed)
~/datum-recon (WSL)        the Python worker: reconstruction/*.py, tests/, weights/, runs/
```
