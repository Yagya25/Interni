# Reconstruction architecture

From one photograph of a room to the existing `Scene`, honestly.

Status: design, Phase 3A. Nothing in this document is implemented. No model
has been installed, no weights downloaded, no service created. Model facts and
licences were checked against their primary sources on 2026-09-21 (see
[Sources](#sources)); anything not verified is marked as such.

---

## At a glance

- **The boundary is the contract we already have.** Everything downstream (the
  renderer, the editor, operations, undo, the command reader, the landing
  summary) reads `Scene` (`src/scene/model/types.ts`). Reconstruction produces
  a `Scene` and nothing else the product depends on. The Scene model is not
  rewritten.
- **Two halves, one seam.** A Python GPU worker turns pixels into
  *observations* (camera, metric geometry, planes, masks, measurements, scores)
  and writes them to a versioned `ReconstructionIntermediate`. A deterministic
  TypeScript `SceneCompiler` turns observations into *decisions*: which plane is
  a wall, where the unseen wall goes, what category and form a piece is. The
  output is a `Scene` plus a sidecar `SceneEvidence` that records how each
  number was known.
- **Measured, estimated, inferred are different things and stay different.** A
  single uncalibrated photograph determines shape much better than size. Every
  absolute length is *estimated* until the person gives one real measurement.
  That measurement rescales the whole room in one step, because a single image
  is determined only up to one global scale.
- **v1 stack:** GeoCalib (camera, gravity), MoGe-2 ViT-L (metric point map,
  normals, FOV), SAM 3 (open-vocabulary instances), deterministic geometry
  (floor, walls, openings, boxes), SigLIP 2 (zero-shot room type, material
  class, builder form), and deterministic appearance statistics (colour,
  pattern, lamp state). Every model in the default path has weights that permit
  commercial use. SAM 3's custom licence and GeoCalib's CC BY 4.0 weights carry
  conditions, listed in §7.
- **Furniture is rebuilt, not generated.** Pieces are drawn with the existing
  parametric builders at their measured size. Asset retrieval comes later,
  image-to-3D generation is optional, and neither is on the default path.
- **Hardware.** The laptop GPU (RTX 4060 Laptop, 8 GB) is enough to develop
  the v1 stack. The laptop's free disk (7.3 GB) is not. Production uses one
  24 GB-class GPU (L4 / A10G) with all v1 models resident.

---

## 1. Current architecture analysis

What exists today, read from the repository at commit `51cde21`
(branch `landing-workspace-refinement`).

### 1.1 Stack and runtime

| Aspect | Today |
| --- | --- |
| Framework | Next.js 16.3.5 (App Router, Turbopack), React 19.2.8, TypeScript |
| 3D | three 0.186, one custom stage (`src/scene/render/SceneStage.ts`) |
| Motion | gsap 3.15 |
| Routes | All static: `/`, `/workspace`, `/workspace/demo`, icons, OG image, robots, sitemap |
| Server code | **None.** No route handlers, no server actions, no database, no storage |
| Deployment | Written for Vercel (`next.config.ts` reads `VERCEL_PROJECT_PRODUCTION_URL`); only env var is `NEXT_PUBLIC_SITE_URL` |
| Dependencies | Six runtime packages; nothing for ML, imaging or storage |

### 1.2 The Scene contract (`src/scene/model/types.ts`)

The contract was written for this moment: its header says a Scene "later
will come from the reconstruction pipeline (depth, segmentation, layout,
material and light estimation)". What it already provides, and what it cannot
express:

| Part | Shape | Fit for reconstruction |
| --- | --- | --- |
| `provenance` | `{kind:"demo"}` or `{kind:"reconstruction", sourceImageId, pipelineVersion, createdAt}` | Ready. `SceneTitleBlock` already renders `Reconstruction <version>`. |
| `room` | `type` (7 values), `label`, `footprint: Vec2[]`, `height` | Polygon footprint allows non-rectangular rooms. A single `height` cannot express sloped or stepped ceilings. |
| `camera` (CaptureCamera) | `position`, `target`, `verticalFov`, `aspect` | Position, look direction and FOV map directly. **No roll, no principal point, no lens distortion.** A lookAt with +Y up means zero roll. |
| `surfaces` | floor, ceiling (span the footprint); walls as `start`/`end`/`thickness` segments | Straight walls only. `evidence: "observed" \| "inferred"` already exists per surface. |
| `openings` | on a wall: `offset`, `width`, `height`, `sill` | Exactly the shape a wall-plane measurement gives. |
| `objects` | `category` (closed enum of 21), `transform`, `dimensions [w,h,d]`, `materials {slot → id}`, `support`, optional `form`, `metadata` | Oriented boxes plus a category are what single-image reconstruction can honestly produce. The closed category list misses common pieces: bed, desk, dining table, chair, cabinet, shelving. |
| `materials` | `class` (10), `color`, `roughness`, `metalness`, `pattern` (12 procedural), `patternScale`, `opacity`, `emissive` | Class, colour and pattern can be estimated. Roughness and metalness can only come from class priors. **No texture reference.** The comment says "Real pipelines will attach textures". |
| `lights` | daylight (`openingIds`, `timeOfDay`), ambient (`color`), artificial (`fixtureId`, `emitterOffset`, `colorTemperature`, `intensity?`, `on?`) | Semantic, not radiometric: it names which windows and fixtures light the room. That suits what a photo can support. |
| `relationships` | `subjectId`, predicate (9), `objectId` | Can be derived deterministically from geometry. |

Conventions the compiler must honour: metres; right-handed; +Y up; floor at
`y = 0`; XYZ Euler radians; sRGB hex colours; stable ids; an object's origin
is the centre of its base.

The contract has no uncertainty fields. Surfaces carry `evidence`, and
objects carry a free-form `metadata` record. This design keeps uncertainty in
a sidecar (§12, §15) rather than changing `Scene`.

### 1.3 What consumes a Scene

- **Renderer.** `SceneStage` renders any Scene. It has a builder per category
  (`src/scene/render/objects/`). Seven categories have two forms each: sofa
  `track-arm`/`curved`, coffee table `slab`/`drum`, side table `round`/`block`,
  rug `rect`/`round`, plant `fiddle-leaf`/`olive`, floor lamp `tripod`/`globe`,
  pendant `dome`/`lantern`. **Any category without a builder renders as its
  bounding volume** (`objects/index.ts`), so a reconstruction can always be
  displayed. Materials come from procedural canvas patterns (`textures.ts`).
  Light is a sun through the openings, a hemisphere/ambient term and point
  lights at fixtures, all driven by `timeOfDay` (`lighting.ts`).
- **Photo layer.** The stage renders depth from the capture camera and uses it
  as a "seen" mask. Surfaces the camera saw render live, and unseen ones are
  hatched (`shading.ts`: `uPhotoDepth`, `uPhotoProjection`, `aPhotoView`).
  This is the same machinery that could later project the *real* photograph
  onto reconstructed geometry. That needs an exact capture camera, which is
  why roll matters (§23).
- **Operations and history.** `SceneOperation` covers `move`, `scale`,
  `restyle`, `replace`, `add`, `remove`, `resurface` and `relight`, each with an
  inverse (`operations.ts`). History is a list of operations
  (`state/document.ts`). A reconstructed Scene inherits editing, undo and
  preview unchanged.
- **Workspace.** `Workspace({scene, name, palette, interpreter})` is already
  generic. `DemoWorkspace` is one caller. A reconstructed room needs another
  caller, not a new workspace.
- **Command reader.** `createDemoInterpreter(scene)` resolves names against
  the scene it is given: categories, synonyms, openings. It holds no demo ids.
  It should work on a reconstructed scene as-is, subject to a check when the
  first real scene exists.
- **Landing.** Reads only `src/demo`. It is unaffected by reconstruction and
  must stay so.

### 1.4 The upload path today (`src/features/workspace/source/`)

- The client accepts JPEG, PNG and WEBP up to 24 MB with a shortest edge of at
  least 640 px. It decodes the image and measures tone and colour
  (`analyse.ts`). Every number is a pixel measurement.
- It stores `{photograph, analysis, blob}` in IndexedDB (`datum-source`,
  key `current`). The blob never leaves the browser.
- The state machine already declares `reconstructing {step}` and
  `reconstructed {sceneId}` and never reaches them. `RECONSTRUCTION_STAGES`
  names four stages: depth; walls, floor and openings; objects; materials and
  light. §18 maps the pipeline onto exactly these.
- `Entry.tsx` shows a disabled **Reconstruct this room** button. The copy
  promises: *"Kept in this browser. It has not been uploaded anywhere."*
  **Server-side reconstruction breaks that promise**, so starting it must be an
  explicit, informed act (§20).

### 1.5 Local machine (measured, 2026-09-21)

| Item | Value | Consequence |
| --- | --- | --- |
| GPU | NVIDIA GeForce RTX 4060 Laptop, 8188 MiB, compute capability 8.9 (Ada) | Enough for the v1 stack at fp16/bf16. Not enough for image-to-3D models (16–32 GB). |
| GPU memory in use at idle | 1243 MiB (desktop compositor) | About 6.9 GB usable |
| Driver | 610.88, CUDA UMD 13.3, WDDM | Supports CUDA inside WSL2 without a Linux driver |
| CPU / RAM | Ryzen 7 7840HS / 15.3 GB | WSL2 gets half of RAM by default; set it explicitly (§9) |
| Disk | **7.3 GB free on C:** | **Blocker.** The v1 environment needs roughly 25–40 GB (§9). |
| Python (Windows) | 3.14.3 only | Too new for parts of the CV ecosystem, and SAM 3 needs ≥ 3.12. Use a separate 3.12 environment. |
| WSL | Ubuntu-20.04 and Ubuntu, WSL 2, both stopped | 20.04 is past standard support. Use a current Ubuntu. |
| Docker, nvcc | Not installed | Neither is needed for milestone 1 (§9) |

---

## 2. Proposed architecture

```
 Browser (existing Next.js app)
 ─────────────────────────────
  Entry: photograph held in IndexedDB ──► explicit "Reconstruct" (consent)
        │  upload to private storage (signed URL)
        ▼
 Next.js route handlers (Node)          ┌───────────────────────────────┐
  POST /api/reconstructions ────────────►  jobs (Postgres) · blobs (private)│
  GET  /api/reconstructions/:id  ◄───────┤  status, stage, errors         │
        │ enqueue                        └──────────────▲────────────────┘
        ▼                                               │ signed callback
 GPU worker (Python, one container)                     │
  S0 intake ─► S1 camera ─► S2 geometry ─► S3 segmentation ─► S4 layout
            ─► S5 objects ─► S6 appearance ─► ReconstructionIntermediate.json
                                                        │
                                                        ▼
 SceneCompiler (TypeScript, pure, deterministic; runs in Node and in the browser)
  intermediate + calibration(s) + priors table ─► { scene: Scene,
                                                    evidence: SceneEvidence,
                                                    report: CompileReport }
                                                        │
                                                        ▼
  Review (what was found; how sure; one measurement) ─► Workspace(scene)
```

Principles:

1. **Observations and decisions are separate.** The worker records what the
   pixels support: planes with inlier counts, masks with scores, metric points
   with a scale uncertainty. The compiler makes every choice that shapes the
   room: which planes are walls, how the footprint closes, what a detection is
   called, which prior fills an unseen dimension. Choices are cheap to change
   and re-run. GPU work is expensive and is not repeated to change a choice.
2. **Deterministic compile.** The same intermediate, calibration and compiler
   version always give byte-identical output. That makes recalibration instant
   (it runs in the browser), testable (golden files) and auditable.
3. **The Scene stays the product's only dependency.** Uncertainty, alternatives
   and diagnostics live beside it in `SceneEvidence`, keyed by entity id.
4. **Nothing is invented to fill a gap.** An object appears only if it was
   detected. An unseen wall is emitted as `evidence: "inferred"` because a room
   must be closed, and the evidence says so. A value with no support is a stated
   default, recorded as `default`, never presented as found.
5. **Partial results are results.** If camera and floor succeed and objects
   fail, the person gets the room shell and a clear account of what is missing.

---

## 3. Model comparison

Licences are those of the **weights**, which is what governs use. Where the
code licence differs, it is noted. "Commercial" is shorthand: ✓ permitted,
✗ not permitted, ? unclear (needs legal review).

### 3.1 Metric depth and geometry (single image)

| Model | Outputs | Metric | Intrinsics | Normals | Size | Weights licence | Com. | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **MoGe-2 ViT-L (normal)** | point map, depth, validity mask, normals | ✓ | FOV estimated | ✓ | 331M | MIT (HF model tag) | ✓ | Authors: 60 ms/image, A100 or RTX 3090, fp16. Code MIT, with bundled DINOv2 code under Apache-2.0. |
| MoGe-2 ViT-B / ViT-S (normal) | same | ✓ | ✓ | ✓ | 104M / 35M | MIT | ✓ | Smaller fallbacks |
| DA3METRIC-LARGE | canonical depth; metric = focal × out / 300 | needs focal | — | — | 0.35B | Apache-2.0 | ✓ | Nov 2025. Card: trained on public academic datasets only. |
| DA3MONO-LARGE | relative depth | ✗ | — | — | 0.35B | Apache-2.0 | ✓ | |
| DA3-LARGE / GIANT / NESTED | any-view depth, poses, rays | relative | ✓ | — | 0.35–1.4B | CC BY-NC 4.0 | ✗ | Best multi-view variants are non-commercial |
| Depth Anything V2 Small | relative disparity | ✗ | — | — | 24.8M | Apache-2.0 | ✓ | |
| Depth Anything V2 Base/Large | relative disparity | ✗ | — | — | 97.5M / 335M | CC BY-NC 4.0 | ✗ | Metric fine-tunes derive from these: treat as non-commercial |
| Depth Pro (Apple) | metric depth, focal length | ✓ | focal | — | — | Apple custom licence (use, modify, redistribute; **no patent grant**; no Apple marks) | ? | Authors: 2.25 MP in 0.3 s on a standard GPU |
| UniDepth V2 | metric depth, intrinsics, confidence | ✓ | ✓ | — | S/B/L | CC BY-NC 4.0 | ✗ | Strong, but non-commercial |
| Metric3D v2 | metric depth, normals (+confidence) | ✓ | focal input | ✓ | S/L/g2 | BSD-2 code; README directs commercial enquiries to the authors | ? | Needs the focal length to be right |
| ZoeDepth | metric depth | ✓ | — | — | — | MIT | ✓ | Superseded by the above; not evaluated further |
| MapAnything (apache) | metric depth, poses, intrinsics; mono and multi-view | ✓ | ✓ | — | — | Apache-2.0 (`facebook/map-anything-apache`) | ✓ | The CC BY-NC variant is trained on 13 datasets and the Apache one on 6. Relevant to §19. |

### 3.2 Camera and gravity

| Option | Outputs | Licence | Com. | Notes |
| --- | --- | --- | --- | --- |
| **GeoCalib** (ECCV 2024) | gravity (roll, pitch), focal / vertical FOV, optional radial distortion `k1`, **covariance** | Code Apache-2.0; weights CC BY 4.0 | ✓ (attribution) | Accepts focal and gravity priors. Returns its own uncertainty. Supports shared intrinsics across images. |
| EXIF `FocalLengthIn35mmFilm` | focal prior | — | ✓ | Measured metadata, but the conversion to FOV depends on a diagonal-vs-width convention, and digital crops invalidate it. Use it as a prior, not as truth. |
| MoGe-2 FOV | FOV (by-product) | MIT | ✓ | Cross-check |
| Vanishing points (classical line segments + RANSAC) | Manhattan frame, focal (if ≥ 2 finite VPs) | own code | ✓ | Deterministic cross-check for yaw and focal |

### 3.3 Detection and instance segmentation (open vocabulary)

| Model | Task | Size | Licence | Com. | Notes |
| --- | --- | --- | --- | --- | --- |
| **SAM 3** | text or exemplar prompt → **all instances** of the concept: masks, boxes, scores | 848M | SAM License (custom, Meta) | ✓ with conditions | Gated on HF. Python ≥ 3.12, PyTorch ≥ 2.7, CUDA ≥ 12.6. Meta reports ~30 ms/image with 100+ objects on H200; a public issue (#425) reports slower real-world throughput. Measure it. SAM 3.1 (Mar 2026) speeds up video tracking. |
| Grounding DINO T / B (via `transformers`) | text → boxes | Swin-T / Swin-B | Apache-2.0 | ✓ | No CUDA build needed through `transformers`. Prompts are lowercase and period-separated. |
| SAM 2.1 (tiny → large) | box/point → mask | 38.9M–224.4M | Apache-2.0 | ✓ | 39.5–91.2 FPS (authors). Upstream recommends WSL on Windows. |
| OWLv2 L/14 | text → boxes | — | Apache-2.0 | ✓ | Model card frames it as "a research output" (intent statement, not a licence term) |
| Florence-2 | detection, grounding, captions | 0.23B / 0.77B | MIT | ✓ | Light alternative; not evaluated further |
| YOLO-World | real-time open vocabulary | — | GPL-3.0 | ✓ copyleft | Distributing it triggers source obligations; a commercial licence is available from Tencent |
| Ultralytics YOLO / YOLOE | detection, segmentation | — | AGPL-3.0 or paid enterprise licence | ✓ copyleft | AGPL's network clause reaches a hosted service |
| Grounding DINO 1.5 / 1.6, DINO-X | open-set detection | — | IDEA API (not open weights) | — | External API; images leave our infrastructure |

### 3.4 Structure: walls, floor, ceiling, openings

| Option | Licence | Com. | Notes |
| --- | --- | --- | --- |
| **Geometry-first plane fitting** (RANSAC on the metric point map + normals, gravity-aligned, Manhattan snap) | own code | ✓ | Deterministic and explainable. Uses no semantic model for wall, floor or ceiling. |
| **SAM 3 prompted "window", "door"** (and "wall", "floor", "ceiling" as secondary evidence) | SAM License | ✓ | Its behaviour on "stuff" classes (wall, floor) must be validated. Openings are "things" and suit it. |
| OneFormer / Mask2Former (ADE20K) | Code MIT; weights trained on ADE20K, whose images are limited to non-commercial research and education | ? | Legally unclear for a product. Kept as an evaluation baseline only. |
| SpatialLM 1.1 (walls, doors, windows, boxes from a point cloud) | Code Apache-2.0; weights CC BY-NC 4.0 | ✗ | Also designed for full scans, not one view |
| LayoutNet / HorizonNet / PanoTPS-Net | various | — | Panoramas, not perspective photos |
| Plane-DUSt3R | DUSt3R lineage (CC BY-NC-SA 4.0) | ✗ | Multi-view |

### 3.5 Furniture geometry

| Approach | What it gives | Licence | Com. | GPU | Notes |
| --- | --- | --- | --- | --- | --- |
| **Parametric builders (in repo)** | Category + form drawn at measured `[w,h,d]` with named material slots | ours | ✓ | none | Editable, consistent, and slot-aware for restyle. Looks like our builder, not the actual piece. |
| Asset retrieval: ABO | 7,953 glTF 2.0 models with 4K PBR | CC BY 4.0 on the official portal; some secondary sources say BY-NC | ✓ (attribution); confirm | none at runtime | Real products; retrieval by image embedding |
| Asset retrieval: Poly Haven | small CC0 furniture set | CC0 | ✓ | none | Few pieces |
| Asset retrieval: Objaverse | ~800K objects | ODC-By collection; **per-object** CC licences, some NC/ND | per object | none | Must filter object by object |
| 3D-FUTURE / 3D-FRONT | 9,992 furniture CAD models | Terms forbid commercialisation and redistribution | ✗ | — | Excluded |
| TRELLIS (v1) image-large | image → mesh / 3D Gaussians / radiance field | MIT; dependencies include **nvdiffrast (NVIDIA, non-commercial)** and other separately licensed CUDA modules | ? | ≥ 16 GB, Linux | |
| TRELLIS.2 | image → PBR textured mesh (GLB) | MIT; dependencies nvdiffrast / nvdiffrec under their own licences | ? | ≥ 24 GB, Linux | H100: ~3 s (512³) to ~60 s (1536³) per asset |
| SAM 3D Objects | image + mask → shape, texture, **pose/layout** (splats or mesh) | SAM License | ✓ with conditions | **≥ 32 GB**, Linux | Built for occlusion and clutter |
| Hunyuan3D 2.1 | image → shape + PBR texture | Tencent Hunyuan 3D 2.1 Community License: **excludes EU, UK and South Korea**; approval needed above 1M MAU; outputs may not improve other models | ✗ in EU/UK/KR | 10 GB shape, 21 GB texture, 29 GB both | Excluded |
| Image embeddings for retrieval: SigLIP 2 / DINOv2 / DINOv3 | crop ↔ asset-render similarity | Apache-2.0 / Apache-2.0 / DINOv3 License (commercial permitted; "Built with DINOv3" attribution) | ✓ | small | |

### 3.6 Materials

| Option | Licence | Com. | Notes |
| --- | --- | --- | --- |
| **SigLIP 2 zero-shot** over `MaterialClass` prompts, restricted per category | Apache-2.0 | ✓ | Returns scores over our own vocabulary |
| **Deterministic colour statistics** in linear RGB over well-exposed mask pixels | ours | ✓ | Gives *apparent* colour; albedo is not recoverable without light |
| **Deterministic texture analysis** on metric-rectified planes (FFT orientation and period) | ours | ✓ | Plank direction and width on floors; `patternScale` in metres |
| Dense Material Segmentation (Apple DMS, 46 classes) | Annotations CC BY-NC 4.0 | ✗ | Evaluation reference only |
| Intrinsic decomposition (Careaga & Aksoy) | "Academic use only", patent pending | ✗ | Excluded |

### 3.7 Lighting

| Option | Licence | Com. | Notes |
| --- | --- | --- | --- |
| **Deterministic cues**: window openings (S4), lamp fixtures (S5), lamp lit/unlit from luminance, grey-world illuminant | ours | ✓ | Maps directly onto `DaylightSource`, `ArtificialLight`, `AmbientLight` |
| DiffusionLight (chrome-ball inpainting → HDR env map) | Code MIT; built on SDXL, whose licence must be checked for the exact weights | ? | Output is an HDR environment map, which the `Light` contract cannot hold. Needs 1024² input. Excluded from v1. |
| Other diffusion lighting (IllumiDiff, LDM env maps, spatio-temporal) | not checked | — | Research; not evaluated |

### 3.8 Optional scene-level language (not in the default path)

| Model | Licence | Notes |
| --- | --- | --- |
| Qwen3-VL (2B–235B) | Apache-2.0 | Could propose a vocabulary or check a result. Output must be constrained to our enums and never trusted as geometry. |
| Florence-2 | MIT | Captions, grounding |

---

## 4. Recommended model per task

| Task | v1 choice | Fallback / cross-check | Measured in milestone 1? |
| --- | --- | --- | --- |
| Camera intrinsics and gravity | **GeoCalib** (pinhole, or simple-radial when distortion is detected) | EXIF focal prior; MoGe-2 FOV; vanishing points | Yes |
| Metric geometry, normals | **MoGe-2 ViT-L normal** (`Ruicheng/moge-2-vitl-normal`) | DA3METRIC-LARGE given GeoCalib's focal (Apache-2.0); Depth Pro after legal review | Yes: all three on the eval set |
| Floor, ceiling, walls | **Deterministic plane fitting** on MoGe-2 points and normals | SAM 3 "wall/floor/ceiling" masks as secondary evidence | Yes |
| Windows, doors | **SAM 3** ("window", "door", "glass door", "doorway") projected onto fitted wall planes | Grounding DINO + SAM 2.1 | Masks only in M1 |
| Furniture instances | **SAM 3**, prompted from the `ObjectCategory` vocabulary and synonyms | Grounding DINO B → SAM 2.1 L (all Apache-2.0) | No (M3) |
| Object boxes, support, relationships | **Deterministic** (gravity-aligned OBB, Manhattan yaw, support planes) | — | No (M3) |
| Object form (which builder form) | **SigLIP 2 zero-shot** between the forms the builders can draw | none (default builder) | No (M3) |
| Room type | **SigLIP 2 zero-shot** over `RoomType` | "other" | Yes |
| Material class | **SigLIP 2 zero-shot**, restricted per category or surface | class default | No (M4) |
| Material colour, pattern | **Deterministic** statistics and texture analysis | class default | No (M4) |
| Lighting | **Deterministic** cues | stated defaults | No (M4) |
| Furniture geometry | **Parametric builders** at measured size | Retrieval (ABO / Poly Haven), later; image-to-3D optional, later | — |

---

## 5. Why these

**GeoCalib for the camera.** The CaptureCamera needs a vertical FOV and a pose.
Pitch and roll are defined by gravity, and GeoCalib estimates exactly gravity
and focal length from one image. It combines learned priors with a geometric
optimisation and **returns a covariance**, the only model here that reports
calibrated uncertainty for the camera. It also accepts priors (EXIF focal), so
evidence composes instead of competing. Weights are CC BY 4.0: commercial use
with attribution.

**MoGe-2 for geometry.** One forward pass gives a metric point map, normals, a
validity mask and the FOV. Layout fitting needs exactly these. Normals make
plane segmentation far more robust than depth alone. The validity mask removes
sky and far background seen through windows. Weights are MIT. ViT-L is 331M
parameters, and the authors report 60 ms at fp16 on a 3090-class GPU, which
fits the 8 GB laptop. The alternatives are strong but fail on licence
(UniDepth, Depth Anything V2 Large and DA3-Large are non-commercial) or on
coupling (DA3METRIC and Metric3D need the focal length they are given to be
right). DA3METRIC stays in the evaluation as the Apache-2.0 second opinion.
**This choice is provisional until milestone 1 measures it against
tape-measured rooms**; §24 makes that the gate.

**Geometry-first layout.** No layout model with a usable licence works on a
single perspective photograph of a non-cuboid room. The strong ones are
panoramic (HorizonNet, LayoutNet), non-commercial (SpatialLM,
DUSt3R-derived), or trained on data with unclear commercial terms (ADE20K
segmenters). A floor is the lowest large plane whose normal matches gravity.
A wall is a vertical plane. These are geometric facts about a metric point
map, not guesses, and fitting them is deterministic, inspectable and
explainable ("this wall is supported by 38% of the unoccluded pixels in this
region"). What the photo cannot show (walls behind the camera, how far a wall
runs beyond the frame) is closed by explicit, recorded rules in the compiler
(§14).

**SAM 3 for instances.** One model does what a detector and a segmenter do
together: from the phrase "armchair" it returns every armchair, each with a
mask and a score. The SAM License permits commercial use, with conditions
(§7). The all-Apache Grounding DINO + SAM 2.1 pair stays the fallback behind
the same interface, and milestone 3 measures both on our own labelled images
before committing.

**SigLIP 2 for the small classifications.** Room type, material class and
builder form are each a choice among a few labels we define. Zero-shot scoring
against our own prompts returns scores over exactly our enums, deterministically,
with no text generation that could produce a label we don't have. Apache-2.0.

**Deterministic appearance.** Colour and pattern come from pixel statistics
and rectified-plane texture analysis. These are real measurements of how the
surface looks in this photo. What can't be measured (roughness, metalness,
albedo under unknown light) is taken from class priors and labelled
`inferred`, not dressed up as estimation. No commercially usable
intrinsic-decomposition or lighting model exists that also fits our light
contract (§3.6–3.7).

**Parametric builders for furniture.** The product's promise is an *editable*
room: restyle a slot, turn a piece, swap a form. The builders keep slots,
forms, supports and the command reader working. Generated meshes would cost
16–32 GB GPUs and seconds to minutes per object, and would *invent* the
occluded side of every piece (the back of a sofa against a wall was never
seen). Most carry licence problems in their dependencies. They are an
optional later step for hero pieces, not the foundation.

---

## 6. Alternatives considered

| Alternative | Why not now | When it could return |
| --- | --- | --- |
| One end-to-end model (e.g. SpatialLM-style point cloud → walls, doors, boxes) | Non-commercial weights; built for scans | If a commercially licensed equivalent appears, it can plug in as an S4/S5 observer |
| In-browser inference (WebGPU / ONNX) | Only small models run well (e.g. Depth Anything V2 Small); hundreds of MB to download; device variance; accuracy first | An instant low-fidelity preview while the server job runs |
| Next.js route handlers running inference | Vercel Functions have no GPUs; the model ecosystem is Python and CUDA | Never for inference. Route handlers stay the product API (§10). |
| External vision APIs (Grounding DINO 1.5/1.6 API, hosted VLMs) | Send users' home photos to third parties; no control of versions or retention | Only with an explicit, disclosed agreement |
| Image-to-3D per piece (TRELLIS.2, SAM 3D Objects) | GPU size, latency, hallucinated occluded geometry, dependency licences | Opt-in "rebuild this piece in detail", labelled `generated` |
| Diffusion lighting (DiffusionLight) | Output doesn't fit the Light contract; multi-second diffusion; base-weight licence | If the renderer gains an environment-map light |
| Non-commercial best-in-class (UniDepth, DA3-Large, SpatialLM, DUSt3R/MASt3R) | Licence | Research and evaluation only, if our use qualifies |

---

## 7. Licensing

Principle: **anything on the production path needs a licence that permits
commercial use for the weights, the code and every runtime dependency.**
Research-only components may be used only for internal evaluation where that
use itself qualifies. This is not legal advice. Every row marked "review"
needs sign-off before launch.

| Component | Weights | Code | Obligations | Status |
| --- | --- | --- | --- | --- |
| MoGe-2 | MIT (HF tag) | MIT; DINOv2 portion Apache-2.0 | Keep notices | ✓ |
| GeoCalib | CC BY 4.0 | Apache-2.0 | **Attribution** in product docs | ✓ |
| SAM 3 | SAM License | SAM License | Ship the licence with any redistribution. Trade-control compliance. **No military, ITAR, nuclear, espionage or weapons use.** No reverse engineering. Meta may terminate for breach. Gated download means accepting terms per account. | ✓, **review** |
| SigLIP 2 | Apache-2.0 | Apache-2.0 | Notices | ✓ |
| Grounding DINO, SAM 2.1 (fallback) | Apache-2.0 | Apache-2.0 | Notices | ✓ |
| DA3METRIC-LARGE (evaluation, possible fallback) | Apache-2.0 | Apache-2.0 | Notices | ✓ |
| Depth Pro (evaluation) | Apple custom licence | same | No patent grant; no Apple marks | **review** |
| ABO assets (later) | CC BY 4.0 per official portal | — | Attribution to Amazon.com and the authors | ✓, **confirm** (conflicting secondary sources) |
| Objaverse assets (later) | per object | — | Filter out NC and ND; attribute each | per object |
| TRELLIS / TRELLIS.2 (optional, later) | MIT | MIT; **nvdiffrast is NVIDIA non-commercial**; other separately licensed modules | Replace or license the rasteriser | ✗ until resolved |
| SAM 3D Objects (optional, later) | SAM License | SAM License | as SAM 3 | ✓, **review** |
| Hunyuan3D 2.1 | Community licence, excludes EU/UK/KR | — | — | ✗ |
| UniDepth, DA V2 B/L, DA3 L/G, SpatialLM, DUSt3R/MASt3R, DMS, Intrinsic | Non-commercial | — | — | ✗ production |
| YOLO-World (GPL-3.0), Ultralytics (AGPL-3.0) | copyleft | — | Source obligations | ✗ unless bought out |
| ADE20K-trained segmenters | images non-commercial; annotations BSD | — | unclear | ✗ production |

Operational rules for later phases:

1. **Pin by hash.** Record repository, revision and SHA-256 of every weight
   file. The worker refuses weights whose hash is not on the list. The licence
   recorded for each is copied into the intermediate (`pipeline.models[]`), so
   every scene can say what produced it.
2. **Mirror, don't fetch.** Production reads weights from our own storage,
   never from a hub at runtime. Gated models (SAM 3) are downloaded once, by an
   account that accepted the terms.
3. **Only safetensors, or `weights_only` loading.** Never unpickle a file we
   didn't pin.
4. **Attribution page.** GeoCalib (CC BY), ABO (CC BY), DINOv3 if adopted
   ("Built with DINOv3").

---

## 8. GPU requirements

Weights at bf16/fp16. Activation memory depends on input resolution and is
**not verified**. Milestone 1 measures peak memory per stage.

| Model | Params | fp16 weights (≈) | Notes |
| --- | --- | --- | --- |
| MoGe-2 ViT-L normal | 331M | ~0.7 GB | |
| SAM 3 | 848M | ~1.7 GB (≈3.4 GB fp32) | |
| SigLIP 2 (so400m class) | ~0.4B | ~0.8 GB | |
| GeoCalib | small | < 0.1 GB (unverified) | CPU-capable |
| **v1 stack total (weights)** | | **~3.3 GB** | Fits on 24 GB with room for batching and activations |
| DA3METRIC-LARGE (eval) | 0.35B | ~0.7 GB | |
| Grounding DINO B + SAM 2.1 L (fallback) | unverified + 0.22B | ~1 GB (unverified) | |
| TRELLIS image-large | 1.2B | — | Authors: ≥ 16 GB GPU |
| TRELLIS.2 | 4B | — | Authors: ≥ 24 GB GPU |
| SAM 3D Objects | — | — | Authors: ≥ 32 GB GPU |
| Hunyuan3D 2.1 | — | — | 10 / 21 / 29 GB (shape / texture / both) |

- **Local (RTX 4060 Laptop, ~6.9 GB free):** the v1 stack should fit, but
  the full stack together plus SAM 3's activations at 1008 px is unverified.
  The worker is written to run with models resident when memory allows and to
  load and unload per stage when it doesn't. The memory policy is a
  configuration setting, not a code fork.
- **Production:** one 24 GB GPU (NVIDIA L4 or A10G class) keeps every v1 model
  resident. Loading is then paid once per container, not once per request.
- **Optional generative pieces:** a separate worker pool on 48–80 GB GPUs
  (L40S, A100 80 GB, H100), never the default path.

---

## 9. Local development setup (Windows, RTX 4060 Laptop, 16 GB)

This is the plan for when implementation is approved. **Nothing here has been
done.**

1. **Free or add disk first.** Budget roughly 25–40 GB:

   | Item | Estimate |
   | --- | --- |
   | WSL distribution and tooling | 3–5 GB |
   | PyTorch with CUDA runtime | 5–8 GB installed |
   | v1 weights (fp32 on disk) | 5–7 GB |
   | Eval images and artefacts | 1–3 GB |
   | Headroom | ≥ 10 GB |

   With 7.3 GB free on C:, either free space or move the WSL virtual disk to
   another drive.
2. **Linux, not Windows Python.** Use WSL2 with a current Ubuntu LTS, because
   20.04 is past standard support. SAM 2 upstream recommends WSL on Windows,
   TRELLIS-family code is Linux-only, and every production target is Linux.
   The Windows driver (610.88, CUDA 13.3 UMD) exposes the GPU to WSL2. Don't
   install a Linux GPU driver inside WSL.
3. **Python 3.12 via `uv`, in WSL.** SAM 3 needs ≥ 3.12. The host's 3.14 is
   ahead of much of the CV ecosystem. Pin a PyTorch wheel with a bundled CUDA
   12.x runtime (SAM 3 needs CUDA ≥ 12.6). No `nvcc` is needed: v1 avoids
   packages that compile CUDA extensions (Grounding DINO runs through
   `transformers`).
4. **WSL memory.** WSL2 takes half of host RAM by default (~7.6 GB here). Set
   `memory=10GB` and some swap in `.wslconfig`: loading 3–4 GB of weights
   stages through CPU memory, and point clouds at full resolution are large.
5. **Resolution.** Infer at each model's working resolution (MoGe and SAM 3
   resize internally). Keep the original only for colour statistics.
6. **Wiring.** The worker exposes a CLI
   (`reconstruct photo.jpg → intermediate.json + artefacts/`) and the same
   pipeline behind a local FastAPI endpoint. `next dev` on Windows reaches
   it at `localhost` through WSL2 port forwarding. The Next.js route handlers
   (later) talk to a URL from an env var, `RECONSTRUCTION_WORKER_URL`.
7. **Containers are optional locally.** Docker (with the NVIDIA container
   toolkit) becomes useful for production parity in phase C, not milestone 1.
8. **Tests without a GPU.** The SceneCompiler is pure TypeScript and is tested
   from committed intermediate fixtures, in the same headless harness as the
   model and command tests. CI needs no GPU.

---

## 10. Production architecture

```
                    ┌──────────────────────────── Vercel (existing target) ─┐
 Browser ──HTTPS──► │ Next.js 16 app                                         │
   │                │  pages: /, /workspace, /workspace/demo, /workspace/[id] │
   │                │  route handlers (Node runtime, dynamic):               │
   │                │   /api/reconstructions            create job, sign URL │
   │                │   /api/reconstructions/[id]       status               │
   │                │   /api/reconstructions/[id]/result scene+evidence      │
   │                │   /api/reconstructions/[id]/calibration                │
   │                │   /api/worker/callback            (HMAC, worker only)  │
   │                └───────┬───────────────┬──────────────────▲────────────┘
   │  PUT (signed)          │ SQL           │ enqueue          │ callback
   ▼                        ▼               ▼                  │
 Private object storage   Postgres (jobs,   GPU job queue ───► GPU worker
 (source, artefacts,      scenes, evidence,                    container: CUDA,
  intermediate)           audit)                                Python 3.12, models
                                                                resident, 24 GB GPU
```

**Why Python GPU workers behind a queue, not Next.js alone.** The work is
seconds of GPU time on a scarce, expensive device, with cold starts of tens of
seconds. That is a job, not a request. The Next.js app keeps what it is good
at: auth, validation, signed URLs, job records, compilation and the UI. The
worker is stateless. It pulls a job, reads the source from storage, writes
artefacts and the intermediate back, and reports through a signed callback.
It holds no database credentials.

Choices, to be provisioned when the phase begins (on Vercel, through the
Marketplace):

- **Object storage:** private blob storage (Vercel Blob private, or S3/R2)
  with signed, size-limited upload URLs.
- **Database:** managed Postgres. `jobs`, `scenes` (scene, evidence and
  report as JSONB, with compiler and pipeline versions), `calibrations`,
  `audit`.
- **GPU compute:** a serverless-GPU platform that runs our container on an
  L4/A10G class GPU, scales to zero and bills per second. Candidates to
  evaluate: Modal, Google Cloud Run with GPUs, RunPod Serverless. The worker is
  a plain container with one entrypoint so the choice is reversible. Keep one
  warm instance during active hours if cold starts prove unacceptable (§22).
- **Queue:** the platform's own invocation queue, or a managed queue, with the
  database as the source of truth for status. Delivery is at-least-once, so
  every stage is idempotent on `(jobId, stage, inputHash)`.
- **Compilation:** runs in the callback handler (authoritative stored scene)
  and in the browser (instant recalibration preview). It is the same module.

---

## 11. API boundaries

Four boundaries, each typed, versioned and owned by one side.

### 11.1 Browser ↔ Next.js (product API)

| Method and path | Request | Response | Notes |
| --- | --- | --- | --- |
| `POST /api/reconstructions` | `{ photograph: {name, type, bytes, width, height}, consent: {version, acceptedAt} }` | `{ id, upload: {url, headers, expiresAt} }` | Validates declared type and size again. Refuses without consent. |
| `PUT <signed url>` | image bytes | 200 | Direct to storage, size-capped by the signature |
| `POST /api/reconstructions/:id/start` | `{}` | `{ status: "queued", position? }` | Idempotent |
| `GET /api/reconstructions/:id` | — | `JobStatus` (§18) | Polled, or streamed as SSE |
| `GET /api/reconstructions/:id/result` | — | `{ scene, evidence, report }` | Only when `succeeded` or `partial` |
| `PUT /api/reconstructions/:id/calibration` | `{ references: CalibrationReference[] }` | `{ scene, evidence, report }` | Recompiles; no GPU |
| `DELETE /api/reconstructions/:id` | — | 204 | Deletes source, artefacts and scene (§20) |

Job ids are unguessable (UUIDv4). Every request is checked against the owner.
Route files live under `src/app/api/...`: a `route.ts` can't share a segment
with a `page.tsx`. Handlers are dynamic and uncached (Next 16 route-handler
guide).

### 11.2 Next.js ↔ worker (job contract)

```ts
// Job message (queue payload)
interface ReconstructionJob {
  jobId: string;
  sourceKey: string;            // object-storage key of the uploaded original
  requested: { stages: StageId[]; vocabularyVersion: string };
  pipeline: { version: string };// worker refuses a mismatched major version
  callback: { url: string };    // HMAC-signed with a shared secret
}
// Worker → callback (per stage, and at the end)
interface WorkerEvent {
  jobId: string;
  seq: number;                  // monotonic; the receiver drops stale events
  stage: StageId;
  status: "started" | "succeeded" | "degraded" | "failed";
  timingMs?: number;
  problem?: Problem;            // §17
  intermediateKey?: string;     // on the final event
}
```

### 11.3 Worker ↔ compiler: the `ReconstructionIntermediate` (§13)

It is JSON, validated against a JSON Schema generated from the TypeScript
types. Python side: pydantic models generated from that schema, so both sides
check the same shape. Large arrays (depth, normals, masks) are artefact
references, not inline.

### 11.4 Compiler ↔ product: `{ scene: Scene, evidence: SceneEvidence, report: CompileReport }`

`scene` is today's `Scene`, unchanged. `evidence` and `report` are new sidecar
types (§12, §15) that nothing existing needs to read.

---

## 12. Intermediate schemas

Shared value types. Everything uncertain carries its basis. **"Measured"
means read directly from the photo, its metadata or the person, by a known
procedure**, and nothing else.

```ts
/** How a value is known. Ordered from strongest to weakest. */
type Basis =
  | "measured"    // read off pixels/metadata by a known procedure, or entered by the person
  | "calibrated"  // an estimate rescaled by a measured reference
  | "estimated"   // produced by a model from visible pixels
  | "inferred"    // not visible; completed from constraints or priors
  | "default";    // nothing to go on; a stated default

interface Quantity<T = number> {
  value: T;
  basis: Basis;
  /** 0..1. Calibrated against the evaluation set where possible (§15). */
  confidence: number;
  /** For lengths/angles: a central 80% interval (p10, p90), in the value's unit. */
  interval?: readonly [number, number];
  /** Which observer produced it: "moge-2-vitl-normal@<rev>", "geocalib@<rev>", "rule:floor-plane". */
  sources: readonly string[];
}

type ArtefactRef = { key: string; format: "png16-mm" | "npz" | "rle-coco" | "jpeg"; width: number; height: number; sha256: string };
type PixelBox = readonly [x0: number, y0: number, x1: number, y1: number];
type Frame = "camera-opencv" | "capture";   // see §13 conventions
```

Per-stage observation records:

```ts
interface CameraObservation {                    // S1
  intrinsics: { fx: Quantity; fy: Quantity; cx: Quantity; cy: Quantity };
  distortion: { model: "none" | "simple-radial"; k1?: Quantity };
  gravityCam: Quantity<readonly [number, number, number]>;  // unit vector, camera frame
  roll: Quantity; pitch: Quantity;               // degrees
  verticalFov: Quantity;                         // degrees, displayed orientation
  exifFocal35mm?: number;                        // measured metadata, if present
  agreement: { geocalibVsMoge?: number; geocalibVsExif?: number };  // degrees FOV difference
}

interface GeometryObservation {                  // S2
  depth: ArtefactRef; normals: ArtefactRef; validMask: ArtefactRef;
  /** Global metric scale of the point map. Uncalibrated: value 1, basis "estimated". */
  scale: { logSigma: number };                   // σ of ln(scale) from eval-set residuals
  stats: { validFraction: number; depthRange: readonly [number, number] };
}

interface PlaneObservation {                     // S4
  id: string;                                    // "plane-0"… in deterministic order
  role: "floor" | "ceiling" | "wall" | "other-horizontal" | "other-vertical";
  normal: readonly [number, number, number];     // capture frame
  offset: number;                                // n·x + d = 0, metres (pre-calibration)
  inliers: number; inlierFraction: number; rmsResidual: number;
  /** Visible extent along the plane's in-plane axes; a lower bound on its true extent. */
  visibleExtent: { min: readonly [number, number]; max: readonly [number, number] };
  touchesImageBorder: boolean;                   // extent truncated by the frame
  mask: ArtefactRef;
}

interface OpeningObservation {                   // S3+S4
  id: string; kind: "window" | "door";
  planeId: string;                               // wall plane it lies on
  /** In wall-plane coordinates (u along the wall, v up), metres. */
  u: Quantity<readonly [number, number]>; v: Quantity<readonly [number, number]>;
  truncated: { left: boolean; right: boolean; top: boolean; bottom: boolean };
  score: number; mask: ArtefactRef; box: PixelBox;
}

interface InstanceObservation {                  // S3+S5
  id: string;
  prompt: string;                                // the phrase that found it
  labels: readonly { label: string; score: number }[];  // all prompts that matched, merged
  box: PixelBox; mask: ArtefactRef; maskScore: number;
  visibleFraction: Quantity;                     // unoccluded share, from depth ordering
  touchesImageBorder: boolean;
  points: { count: number; centroid: readonly [number, number, number] };
  /** Gravity-aligned oriented box of the *visible* points (lower bound on extent). */
  visibleBox: { center: readonly [number, number, number]; size: readonly [number, number, number]; yaw: number };
  yawCandidates: readonly { yaw: number; source: "manhattan" | "pca" | "front-normal"; score: number }[];
  contact: { floorGap: number; nearestWallGap: number; ceilingGap: number; restsOn?: string };
  form?: readonly { form: string; score: number }[];  // SigLIP 2 over builder forms
}

interface AppearanceObservation {                // S6
  regionId: string;                              // plane id, instance id, or `${instanceId}:${part}`
  materialClass: readonly { class: string; score: number }[];
  apparentColor: { linear: readonly [number, number, number]; srgbHex: string; pixels: number; clippedFraction: number };
  texture?: { orientationDeg: number; periodMetres: number; strength: number }; // planar regions only
}

interface LightObservation {                     // S6
  illuminant: { srgbHex: string; basis: Basis };
  windows: readonly { openingId: string; exteriorLuminance: number; clippedFraction: number }[];
  lamps: readonly { instanceId: string; lit: Quantity<boolean>; chromaticityCct?: Quantity }[];
  sunPatches: { detected: boolean; confidence: number };
}
```

---

## 13. `ReconstructionIntermediate`

The complete, versioned record of what the worker observed. It is immutable
once written. Scenes are recompiled from it; GPU stages are never re-run to
change a decision.

```ts
interface ReconstructionIntermediate {
  schemaVersion: 1;
  jobId: string;
  createdAt: string;                             // ISO; the compiler's only clock
  pipeline: {
    version: string;                             // hash of worker code + model pins
    models: readonly { id: string; repo: string; revision: string; sha256: string; licence: string }[];
    seeds: { ransac: number };                   // determinism
  };
  source: {
    photographId: string;                        // Photograph.id from the client
    width: number; height: number;               // after EXIF orientation (as the browser shows it)
    orientationApplied: number;                  // EXIF orientation tag that was applied
    exif: { focal35mm?: number; make?: string; model?: string };  // nothing else kept (§20)
    sha256: string;                              // of the canonical re-encode
  };
  /**
   * One entry per photograph. v1 always has exactly one. Multi-image adds
   * views, and `world` becomes a fusion of them (§19).
   */
  views: readonly {
    viewId: string;
    photographId: string;
    camera: CameraObservation;
    geometry: GeometryObservation;
    /** Rigid transform camera-opencv → capture frame (gravity-aligned, floor y = 0). */
    cameraToCapture: readonly number[];          // 4×4, column-major
    stages: Readonly<Record<StageId, StageOutcome>>;
  }[];
  world: {
    frame: "capture";                            // +Y up, floor at y = 0, origin below camera 0
    gravityAgreementDeg: number;                 // GeoCalib gravity vs floor-plane normal
    manhattan: { yaw: number; confidence: number } | null;
    cameraHeight: Quantity;                      // metres, pre-calibration
    planes: readonly PlaneObservation[];
    openings: readonly OpeningObservation[];
    instances: readonly InstanceObservation[];
    appearance: readonly AppearanceObservation[];
    light: LightObservation;
    roomType: readonly { type: string; score: number }[];
  };
  diagnostics: {
    warnings: readonly Problem[];                // §17; non-fatal
    timingsMs: Readonly<Record<StageId, number>>;
    peakGpuMemoryMb?: number;
  };
}

type StageId = "intake" | "camera" | "geometry" | "segmentation" | "layout" | "objects" | "appearance";
type StageOutcome = { status: "succeeded" | "degraded" | "failed" | "skipped"; problem?: Problem };
```

Conventions:

- **camera-opencv**: x right, y down, z forward. This is what the models emit.
- **capture**: the world frame the worker hands over. +Y is up (from gravity,
  refined by the floor normal). The floor is `y = 0`. The origin is directly
  below the camera. Yaw puts the camera's forward direction toward −Z. The
  compiler applies one more rigid transform to reach the Scene frame (§14.2).
- All lengths are pre-calibration metric estimates. The compiler multiplies by
  the scale factor.

---

## 14. SceneCompiler design

A pure TypeScript module (proposed location: `src/scene/compile/`, next to
`model/` and `render/`, later).

```ts
compile(
  input: ReconstructionIntermediate,
  options: { calibration: readonly CalibrationReference[]; priors: PriorsTable; vocabulary: Vocabulary },
): { scene: Scene; evidence: SceneEvidence; report: CompileReport }
```

### 14.1 Determinism rules

- No `Date.now`, no `Math.random`. `createdAt` comes from the intermediate.
- Stable ordering: planes by role then area; instances by category then
  x-position; ties broken by id.
- Ids are derived from content and order (`wall-0`, `sofa-0`,
  `mat-floor`). They stay the same when only calibration changes, so the
  selection, the workspace and any history survive a recalibration.
- Output rounded (lengths to 1 mm, angles to 0.01°), so trivial float noise
  can't create diffs.
- `PriorsTable` and `Vocabulary` are versioned data files. Their versions are
  written into the report.
- Golden tests: fixture intermediate → committed expected scene.

### 14.2 Steps

1. **Validate** the intermediate against its schema. Refuse unknown major
   versions.
2. **Scale.** `s = calibrate(options.calibration)` (§16), otherwise `s = 1`.
   Every length is multiplied by `s`; angles are not.
3. **Frame.** Choose the Scene frame: rotate yaw so the dominant Manhattan
   direction is the X axis (walls axis-aligned where the room allows), and put
   the origin at the centre of the footprint's bounding box (the demo's
   convention). Record the transform in the report.
4. **Room shell.**
   - *Floor*: the `floor` plane defines `y = 0`. If no floor was observed, the
     compile **fails** with `no-floor`, because nothing else can be placed
     honestly.
   - *Walls*: each `wall` plane becomes a line on the floor, extended to meet
     its neighbours. Corners are intersections of adjacent wall lines
     (Manhattan-snapped when within tolerance and the room is Manhattan).
     `evidence: "observed"`.
   - *Closing the footprint*: for each side of the room with no observed wall,
     place an inferred wall at the smallest extent consistent with the
     evidence. That means the camera is inside the room, every observed floor
     point is inside the footprint, and the wall has a minimum clearance
     behind the camera (a priors-table constant). `evidence: "inferred"`, with
     a wide interval. The wall behind the camera may be omitted as a surface
     (the demo omits its south wall) while the footprint stays closed. The
     report says which sides are inferred.
   - *Ceiling*: the observed `ceiling` plane gives `room.height`. If there is
     none, height = max(highest wall-top evidence, tallest object top +
     clearance, priors default), with `basis: "inferred"`.
   - *Thickness*: walls get the priors-table thickness (`inferred`). A single
     image cannot see into a wall.
5. **Openings.** For each opening, find its wall (the plane it was projected
   onto) and convert `u`/`v` to `offset`, `width`, `height` and `sill`. If it
   is truncated by the frame, its extent is a lower bound and the evidence says
   so. A door's `sill` snaps to 0 within tolerance. Frame and panel materials
   come from appearance observations.
6. **Objects.** For each instance above the presence threshold (§15):
   - *category*: map the best label through `Vocabulary` (phrase →
     `ObjectCategory`). No mapping means no object. It is reported as
     `seen-not-modelled` ("a bed, which this version can't represent yet"),
     never forced into the wrong category.
   - *support*: floor if `floorGap` < tolerance; object if it rests on another
     instance's top face; wall if it is thin and against a wall plane; ceiling
     if `ceilingGap` < tolerance.
   - *yaw*: the best candidate. Manhattan alignment is preferred for
     wall-parallel furniture when its score is close.
   - *dimensions*: visible box extents are lower bounds. An axis that isn't
     visible (usually depth, from the front) is completed as
     `max(visible, prior p50 for the category)`, clamped to the category's
     prior range and to free space (not through a wall). Its basis is
     `inferred`, with the prior's interval.
   - *position*: base centre, snapped to its support height.
   - *form*: the SigLIP 2 winner among the forms the builder draws, if it beats
     the runner-up by a margin; otherwise none, so the default builder draws
     it.
   - *materials*: one slot per region observed. The category's other slots get
     class defaults with `basis: "inferred"` (§14.3).
7. **Materials.** For each distinct appearance: `class` is the top zero-shot
   class allowed for that surface or category; `color` is the apparent colour
   (`estimated`: it is the colour under this photo's light, not the albedo);
   `roughness`/`metalness` come from class priors (`inferred`); `pattern` and
   `patternScale` come from texture analysis on planes, otherwise the class
   default. **Names describe, and never claim more than was seen:**
   "Wood, mid-brown" or "Painted surface, warm white", never "White oak,
   natural oil". Near-identical appearances merge into one material (ΔE
   threshold), so a room doesn't get twelve whites.
8. **Lights.** Always one ambient light (colour = estimated illuminant). One
   daylight per room, holding every window's id if any window was found;
   `timeOfDay` is `DEFAULT_TIME_OF_DAY` with `basis: "default"` unless §15's
   evidence rule passes. One artificial light per lamp fixture:
   `emitterOffset` from the same constants the builder uses; `on: true` only
   when observed lit, otherwise left undefined (no claim);
   `colorTemperature` estimated if lit and unclipped, otherwise default 2700 K
   (`default`).
9. **Relationships.** Derived by fixed geometric rules and thresholds from the
   priors table: `on` (support), `against` (gap to wall < ε), `beside`,
   `in-front-of`, `faces`, `opposite`, `lit-by` (inside a lamp's radius).
10. **Camera.** `position` = camera centre in the Scene frame (height =
    `cameraHeight · s`). `target` = where the principal ray meets the first
    surface (so orbiting pivots on the room, not on empty space). `verticalFov`
    comes from `fy` and the displayed height. `aspect` = width / height.
    **Roll is not representable**: its value goes into the evidence, and
    |roll| > 1° raises `camera-roll-dropped` in the report.
11. **Room type and label** come from the zero-shot scores, with low margin
    → `"other"`. **Provenance** is
    `{kind: "reconstruction", sourceImageId, pipelineVersion, createdAt}`.
12. **Invariants**, checked before returning (a violation is a compiler bug
    and fails loudly):
    - ids are unique and references resolve;
    - every opening lies within its wall;
    - every object is inside the footprint and not intersecting walls
      (tolerance);
    - every support target exists;
    - the floor is at 0;
    - the camera is inside the room.

### 14.3 The priors table

This is versioned data, not code. Per category: dimension ranges (p10/p50/p90),
slots and their default classes, typical support. Per material class:
roughness/metalness defaults, pattern default. Per room: wall thickness,
ceiling-height default, clearance behind the camera. Every prior used is
listed in the evidence for the field it filled. The first values are taken
from the demo library and common furniture standards, and flagged for
revision against the evaluation set.

### 14.4 What the compiler never does

It never adds an object that wasn't observed. It never picks a builder form
it can't justify by score. It never turns a `default` into an `estimated`. It
never uses the demo room for anything.

---

## 15. Confidence and uncertainty model

### 15.1 Where uncertainty comes from, and how it is represented

| Source | Nature | Representation |
| --- | --- | --- |
| **Global scale** | One unknown factor shared by *every* length in the room. It is fully correlated, and it is the largest single term. | `ln s ~ N(0, σ²)` with σ fitted to eval-set residuals. Lengths get intervals from it. |
| Shape (relative geometry) | Local depth and normal error; far less than scale | Per-plane RMS residual and inlier fraction. Intervals on derived lengths. |
| Camera | FOV, roll and pitch covariance (GeoCalib) | Carried into `verticalFov` and `roll` intervals |
| Detection and segmentation | Mask and presence scores; label alternatives | Confidence after calibration (15.3); `alternatives[]` |
| Occlusion and truncation | Visible fraction; touches image border | Lower-bound flags; `inferred` completions |
| Priors | Category dimension ranges; class material values | `basis: "inferred"`, interval from the prior's p10–p90 |

Published zero-shot results for leading monocular models put per-pixel
absolute relative depth error on the NYUv2 indoor benchmark at roughly
0.05–0.10. That describes curated benchmark images, **not the scale error on
an arbitrary phone photo**, which milestone 1 measures on our own rooms. Until
it is measured, the design assumes scale is the weakest quantity. The UI must
never show a length as more certain than its interval.

### 15.2 The sidecar

```ts
interface SceneEvidence {
  schemaVersion: 1;
  sceneId: string;
  scale: { factor: number; basis: "estimated" | "calibrated"; logSigma: number; references: readonly CalibrationReference[]; residuals: readonly number[] };
  entities: Readonly<Record<string /* Scene id */, EntityEvidence>>;
}
interface EntityEvidence {
  kind: "room" | "camera" | "surface" | "opening" | "object" | "material" | "light";
  presence: { basis: Basis; confidence: number };      // is it really there
  visibleFraction?: number;
  /** Keyed by field path in the Scene entity: "dimensions.2", "transform.position.0", "category", "color". */
  fields: Readonly<Record<string, Quantity<unknown>>>;
  alternatives?: readonly { field: string; value: string; confidence: number }[];
  priorsUsed?: readonly string[];
  notes: readonly string[];                            // plain-language, shown to people
}
```

`Surface.evidence` in the Scene is derived from the same data: `observed` when
the surface has visible inliers above threshold, otherwise `inferred`. The
existing summary (`inferredSurfaces`) and hatching keep working.

### 15.3 Scores are not probabilities

Raw model scores are mapped to calibrated confidence per model and per
category, using isotonic regression fitted on the labelled evaluation set.
Thresholds are then set on calibrated confidence:

| Band | Treatment |
| --- | --- |
| ≥ 0.8 | Emitted |
| 0.5–0.8 | Emitted, flagged as "check this" in the review |
| 0.3–0.5 | Not emitted. Listed in the review as a candidate ("Possibly a side table: add it?"). Adding one is an operation, so it is undoable. |
| < 0.3 | Dropped, and counted in the report |

The thresholds are placeholders until measured.

### 15.4 Estimated vs measured, as a person sees it

Three words, used consistently in the UI:

- **measured** ("from your measurement", "from the photo's metadata");
- **estimated**: a model read it from the photo, shown with its range;
- **assumed**: the product's word for `inferred` and `default`. It was not
  visible, so the value is a typical one.

After calibration, lengths read **calibrated**. They are still estimates,
anchored to a real number.

---

## 16. Calibration strategy

**Premise.** A single image determines the room up to one global scale. Any
one real length therefore fixes all of them, as far as the error is scale
error.

**References a person can give:**

```ts
type CalibrationReference =
  | { kind: "opening"; openingId: string; dimension: "width" | "height"; metres: number }
  | { kind: "object"; objectId: string; axis: 0 | 1 | 2; metres: number }
  | { kind: "wall"; wallId: string; metres: number }                        // only observed, untruncated walls
  | { kind: "room-height"; metres: number }                                 // only if ceiling observed
  | { kind: "on-plane"; planeId: string; a: readonly [number, number]; b: readonly [number, number]; metres: number }; // two clicks on the photo
```

The references are the natural ones: "this door is 0.9 m wide", "the ceiling
is 2.7 m", "the sofa is 2.2 m long", or two clicks on the floor 1 m apart.

**Solving.** Each reference `i` gives `rᵢ = ln(mᵢ / eᵢ)`, where `m` is the
person's measurement and `e` the uncalibrated estimate of the same length
(recomputed from the intermediate, so it is exact for that geometry). The
weight is `wᵢ = 1 / (σ²_measurement + σ²_estimate,i)`. `σ_estimate` comes
from the reference's own geometric uncertainty: an opening's width from mask
edges is good, while a truncated wall is refused. The fused
`ln s = Σ wᵢ rᵢ / Σ wᵢ`.

**Propagation.** Recompile with `s`. Every position, dimension, footprint
point, height and camera position scales. Angles, materials and light do not.
Ids don't change. `scale.basis` becomes `calibrated`, `logSigma` collapses to
the fused reference uncertainty, and every length's interval narrows
accordingly. It runs in the browser in milliseconds, with no GPU.

**Consistency.** With two or more references, the residuals
`rᵢ − ln s` are shown. A reference more than 2σ from the others is flagged
("these two measurements disagree by 9%"). **One scale corrects scale error,
not shape error.** A wrong FOV distorts depth relative to width, and one
lateral reference can't fix depth-direction lengths. That is why the review
asks for a second reference along the depth axis when the camera evidence is
weak. Estimating a focal correction from two or more orthogonal references is
a later refinement.

**Automatic soft priors (not calibration).** A door height near 2.0–2.1 m,
a camera height in 1.1–1.7 m, and a ceiling in 2.3–3.2 m are used only as
*sanity checks*. A reconstruction that violates all three shows a "size looks
off" warning and asks for a measurement. It is never silently rescaled.

**Edits and calibration.** Calibration belongs in the review step, before
editing. If a person calibrates after editing, the base scene is recompiled
and the history is replayed with lengths scaled. Every current operation is
linear in position: `move.to` and `add`/`replace` transforms and dimensions
scale by `s`; `scale`, `restyle`, `resurface` and `relight` are unchanged. The
replay is a pure function, testable like the rest.

---

## 17. Error and failure handling

Every stage returns `succeeded | degraded | failed | skipped` with a
`Problem`. The compiler decides what can still be produced. **Partial success
is shown as partial.**

| Problem | Detected by | Outcome | What the person reads |
| --- | --- | --- | --- |
| `not-decodable`, `too-large`, `too-small`, `wrong-type` | S0 (again, server-side) | fail | Existing `PROBLEMS` copy |
| `not-a-room` | S1/S2: outdoor or sky-dominated; no floor-like plane; RoomType margin | fail | "This doesn't look like the inside of a room. A photograph taken from a doorway or corner works best." |
| `too-dark`, `too-blurry` | S0 statistics (existing luminance and range; a Laplacian variance measure) | degrade or fail | "It's too dark to read the depth of this room." |
| `wide-angle` | GeoCalib `k1` or FOV above threshold | degrade | "Taken with a wide lens, so straight lines bend. Sizes are less reliable." |
| `no-floor` | S4 | fail (nothing can be placed) | "The floor isn't visible enough to rebuild the room." |
| `gravity-disagreement` | S1 vs S4 > threshold | degrade (use floor normal) | internal |
| `few-walls` | S4 finds < 1 wall | partial: floor, camera and objects, with an open, inferred footprint | "Only part of the room's outline could be seen." |
| `mirror-or-glass` | depth beyond a wall plane inside a non-window region | degrade (masked out) | "A mirror or glass was ignored." |
| `camera-roll-dropped` | compiler | note | internal (affects photo overlay only) |
| `seen-not-modelled` | compiler | note | "Also seen: a bed and a desk. These can't be represented yet." |
| `gpu-oom` | worker | retry once at a lower resolution, then fail | "Something went wrong on our side. Try again." |
| `timeout`, `worker-lost` | lease expiry | re-queue ≤ 2 times, then fail | same |
| `model-integrity` | hash mismatch | fail, alert | same |
| `version-mismatch` | job vs worker major version | re-route or fail | same |

Rules: retry only transient infrastructure failures. A deterministic failure
(no floor) never retries. Every failure carries a stage and a machine code;
the copy is looked up, never built from exception text. Nothing about the
image content goes into logs.

---

## 18. Progress reporting

The existing state machine already has the right shape:
`ready → reconstructing {step} → reconstructed {sceneId} | error`.
The pipeline maps onto the four `RECONSTRUCTION_STAGES` already shown on
screen:

| UI step | Stage text (existing) | Pipeline stages |
| --- | --- | --- |
| 1 | Depth, read from the single image | S0 intake, S1 camera, S2 geometry |
| 2 | Walls, floor and openings, fitted to the depth | S3 segmentation (structure, openings), S4 layout |
| 3 | Objects, separated and measured | S3 segmentation (instances), S5 objects |
| 4 | Materials and light, estimated from the pixels | S6 appearance, compile |

```ts
type JobStatus =
  | { status: "queued"; position?: number }
  | { status: "running"; step: 1 | 2 | 3 | 4; stage: StageId; startedAt: string }
  | { status: "succeeded"; sceneId: string }
  | { status: "partial"; sceneId: string; missing: readonly StageId[] }
  | { status: "failed"; stage: StageId; problem: Problem }
  | { status: "cancelled" };
```

- **Only real transitions move the indicator.** There is no timer-driven
  percentage (the same rule `ANALYSIS_STEPS` follows). An ETA may be shown,
  labelled as an estimate, from measured p50 stage timings.
- **Transport.** Poll `GET /api/reconstructions/:id` about once a second.
  Server-Sent Events from the route handler are an upgrade; they work on the
  Node runtime.
- **Cold start is a state**, not a frozen step: "Starting the reconstruction
  service…" while a worker boots.
- **Cancel** is honoured between stages.

---

## 19. Multi-image compatibility

v1 is single-image, but nothing in it assumes there will only ever be one:

- **The intermediate is already per-view** (`views[]`), with `world` as the
  fused result. One image means one view, and `world` is that view's
  geometry.
- **Poses and fusion.** Multiple photos need camera poses in one frame.
  Commercially usable options exist: VGGT-1B-Commercial (Meta; commercial use
  permitted except military; gated), MapAnything-apache (Apache-2.0), and the
  DA3 Base and Small variants (Apache-2.0; DA3 Large and Giant are
  non-commercial). GeoCalib's shared-intrinsics mode covers photos from one
  phone.
- **What fusion changes.** Walls seen from two sides stop being `inferred`.
  Object depth dimensions stop being prior-filled. Scale uncertainty drops
  because parallax constrains it. Evidence merges per entity: observed in any
  view means observed.
- **Association.** Instances match across views by reprojected mask overlap
  plus embedding similarity. The compiler then sees one instance with several
  views' observations.
- **Contract gaps, noted and not changed now:** `provenance.sourceImageId` is
  singular, and `Scene.camera` is one camera. Multi-image keeps one *primary*
  capture camera (the photo the person chose) and records the rest in the
  intermediate and evidence. An additive `sourceImageIds?` field is a future
  proposal, not part of this phase.

---

## 20. Security for uploaded images

A photo of someone's home is personal data. It can include faces, family
photos, documents, screens, and a GPS position in its EXIF.

**Consent and copy.** The entry screen currently promises "It has not been
uploaded anywhere". Reconstruction must be a separate, explicit action that
says, before any byte leaves the browser, three things: the photograph will be
sent for processing, for how long it is kept, and how to delete it. The
consent version is recorded with the job.

**Upload.**
- Signed, single-use, short-lived upload URLs, with a size cap (the existing
  24 MB) in the signature.
- Private bucket only; never a public URL.
- One object per job, under a random key.

**Decode defensively (S0).**
- Sniff magic bytes; never trust the declared type.
- Decode in a hardened library with a pixel cap (decompression-bomb guard;
  e.g. 50 MP), a dimension cap and a time limit.
- Apply EXIF orientation, so the server sees what the browser showed.
- **Read only** focal-35mm, make and model from EXIF. **Strip all metadata**
  (GPS, timestamps, serials, XMP) by re-encoding to a canonical image.
- Inference runs on the canonical image. The original is deleted after S0.

**Worker isolation.**
- Non-root container, read-only filesystem except scratch.
- Network egress only to storage and the callback URL.
- Pinned dependencies with hashes; weights pinned by hash (§7).
- No arbitrary deserialisation.

**Access.**
- Unguessable job ids, with owner checks on every call.
- Results served through the API, never as public artefacts.
- The HMAC-signed worker callback has replay protection (`seq`, timestamp).

**Abuse and cost.** Per-account and per-IP rate limits and a daily GPU quota,
because every job spends real GPU money.

**Retention.**
- Source images are deleted after a short window (proposed: 30 days) or on
  request.
- Artefacts go with them. The compiled scene stays until the person deletes
  the room.
- **Never used for training** without a separate opt-in.

**Logs** carry ids, stages, timings and error codes, never pixels or EXIF.

**Compliance to confirm before launch:**
- privacy notice and data-processing terms for the chosen GPU and storage
  providers (region);
- whether hosting user images requires CSAM hash-matching in the target
  jurisdictions.

If a VLM is ever added: text inside a photo (a poster, a screen) can steer it.
Its output is data restricted to our enums, never instructions.

---

## 21. Storage strategy

| Data | Where | Format | Size (typical) | Lifetime |
| --- | --- | --- | --- | --- |
| Photograph (client) | IndexedDB (existing) | original blob | 2–8 MB | until replaced (existing) |
| Canonical source | private object storage | JPEG q92, metadata-free | 1–4 MB | retention window |
| Depth | object storage | 16-bit PNG in millimetres at working resolution | ~1–2 MB | retention window |
| Normals, validity | object storage | 8-bit PNG / packed | ~1 MB | retention window |
| Masks | object storage | COCO RLE in JSON | 10–200 KB | retention window |
| Intermediate | object storage + hash in DB | JSON, gzip | 50–300 KB | as long as the scene (recompile source) |
| Scene, evidence, report | Postgres JSONB | JSON | 20–150 KB | until deleted |
| Calibrations | Postgres | rows | tiny | with the scene |
| Weights | container image or a platform volume | safetensors, pinned | 5–7 GB (v1) | per pipeline version |

- The **intermediate outlives the artefacts**. Once compiled, a scene can be
  recompiled under a newer compiler without the depth maps. A new *pipeline*
  version means re-running the GPU, which needs the source, which may have
  expired. That is stated, not hidden.
- **Versioning.** Scene rows record `pipelineVersion` (already in provenance),
  `compilerVersion`, `priorsVersion` and `vocabularyVersion`.
- **Client.** The reconstructed scene is fetched by id. The workspace route
  becomes `/workspace/[id]`, alongside `/workspace/demo`, later.

---

## 22. Expected latency

Figures marked **(authors)** are published by the model authors on their
hardware. Everything else is a **target to verify** in milestone 1, not a
measurement.

| Stage | Production (L4/A10G class, warm) | Basis |
| --- | --- | --- |
| Upload 3 MB | 1–5 s, network-bound | estimate |
| S0 decode, orientation, re-encode | 0.2–0.5 s | estimate |
| S1 GeoCalib | < 0.5 s | estimate |
| S2 MoGe-2 ViT-L | ~0.06 s on A100/3090 (authors); L4 somewhat slower | authors + estimate |
| S3 SAM 3, ~25 prompts | ~0.03 s/image on H200 (Meta); public reports of slower throughput; prompts batch against one image encoding | authors + **measure** |
| S4 plane fitting (CPU, numpy) | 0.5–2 s | estimate |
| S5 objects (CPU) + SigLIP 2 crops | 0.3–1 s | estimate |
| S6 appearance | 0.3–1 s | estimate |
| Compile (TS) | < 0.1 s | estimate |
| **End to end, warm, excluding upload** | **target ≤ 10 s** | to verify |
| **Cold start** (container + ~3–7 GB weights to GPU) | **tens of seconds** | to verify; the dominant term if scaled to zero |
| Recalibration | < 0.1 s, in the browser | by design |

**Local RTX 4060 Laptop.** Single-image inference should be in the same order
of magnitude. If models must load and unload per stage to fit 8 GB, loading
dominates. Milestone 1 reports both.

**Optional generative piece** (per object, if ever enabled): TRELLIS.2 takes
~3 s at 512³ to ~60 s at 1536³ on an H100 (authors), which is why it can never
be on the default path.

---

## 23. Quality limitations

This is what one photograph cannot provide. The product must say so rather
than paper over it.

**Geometry**
- **Absolute size** is estimated until calibrated. Ratios within a plane
  (door width to wall length) are far more reliable than absolute lengths.
- **Out of frame** geometry is inferred. That means walls behind the camera,
  the far end of a wall cut by the frame, and the true footprint of an
  L-shaped or open-plan room. It is hatched as inferred, as today.
- **Occluded surfaces**: the backs and undersides of furniture, and floor
  under a sofa, are unknown. The depth of a piece seen from the front is
  prior-filled.
- **Thin structures** (chair legs, lamp stems, plant stems) are poorly
  resolved in depth. Builders draw them from the category, not from the photo.
- **Mirrors, glass and glossy floors** produce false depth. They are handled
  by masking and warnings, not solved.
- **Non-Manhattan and curved walls, sloped or stepped ceilings, stairs,
  mezzanines** are beyond the contract (straight walls, one height). They are
  approximated, and the report says so.
- **Wide and ultra-wide lenses**: lens distortion is estimated, but the
  CaptureCamera is pinhole with no roll. Rendering from the capture camera is
  close; an exact photo overlay is not.

**Semantics**
- **The category vocabulary is closed** (21 categories). Beds, desks, dining
  tables, chairs and cabinets are reported as seen-not-modelled until the enum
  grows. Adding categories is additive, and the renderer already falls back to
  bounding volumes.
- **Forms are the builders' forms.** A reconstructed sofa is "a sofa of this
  size, shaped like our curved sofa". It is not *that* sofa. The UI should say
  "represented as".
- **Look-alike classes** (armchair vs lounge chair, side table vs stool) are
  confused. Alternatives are kept in the evidence.

**Appearance**
- **Colour is apparent colour** under the photo's light. White-balance and
  exposure change it, and a warm evening photo makes a white wall cream.
- **Material class is a classification** that can be wrong (leather vs faux
  leather, marble vs porcelain). Species and brand (white oak, Carrara) are
  never claimed.
- **Roughness and metalness** are class assumptions, not measurements.
- **Blown-out windows** and clipped lamps destroy colour and light
  information in those regions.

**Light**
- **Time of day** and **sun direction** generally can't be recovered. They
  are defaults unless sun patches are unambiguous.
- **Lamp colour temperature** is estimated only for lit, unclipped lamps.
- **Fixtures out of frame** (a ceiling light behind the camera) are unknown.
  Their light is folded into ambient.

---

## 24. Implementation phases

Each phase ends with something real and measured. None fakes the next.

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **M1: Geometry spine, offline** (first milestone, §F below) | Eval set; worker CLI S0–S2 + S4 (camera, depth, floor, walls, ceiling); intermediate v1; SceneCompiler for room shell + camera + evidence + calibration; no UI | Measured error report; deterministic compile; calibration propagation shown to reduce error; honest failures |
| M2: Service and review | Route handlers, storage, jobs, worker container, callback; consent step; enable "Reconstruct this room"; `reconstructing`/`reconstructed` states; review screen (what was found, how sure, one measurement); open in `Workspace` | End-to-end on the real stack for the eval set; delete works; no image data in logs |
| M3: Objects | SAM 3 vs Grounding DINO + SAM 2.1 bake-off on labelled eval images; S5 boxes, support, relationships; SigLIP 2 forms; vocabulary v1; candidates in review | Per-category precision and recall reported and above the agreed bar; no category forced |
| M4: Openings, materials, light | Openings on walls; material class, colour, pattern; lamps lit and unlit; ambient | Material class accuracy reported; colour ΔE vs colour-checker shots |
| M5: Asset retrieval (optional) | Licensed catalogue (ABO / Poly Haven / commissioned); embedding retrieval; additive asset reference in the contract; glTF path in the renderer | Licence sign-off; slot mapping; performance budget kept |
| M6: Multi-image | Views, poses, fusion, association | Inferred walls become observed; scale σ drops, measured |
| M7: Generative pieces (optional) | Opt-in per piece; separate GPU pool; labelled `generated` | Dependency licences resolved |

Contract changes that later phases will propose, each additive and each
needing its own approval:

- `camera.roll?`
- a texture reference on `Material`
- an asset reference on `SceneObject`
- more `ObjectCategory` values
- `provenance.sourceImageIds?`

---

## Decision summary

### A. Recommended architecture

Two halves with a typed seam. A **Python GPU worker** (one container, behind a
job queue) turns the photograph into immutable, versioned observations: the
`ReconstructionIntermediate`. A **pure, deterministic TypeScript
SceneCompiler** turns those observations, plus any calibration, into today's
unchanged `Scene` and a sidecar `SceneEvidence` that records, for every value,
whether it was measured, estimated, calibrated, inferred or defaulted, with a
range. Next.js route handlers stay the product API. The workspace, renderer,
operations and command reader consume the Scene exactly as they do now.

### B. Model and tool stack

| Role | Choice |
| --- | --- |
| Camera, gravity | GeoCalib (Apache-2.0 code, CC BY 4.0 weights) + EXIF focal prior |
| Metric geometry, normals, FOV | MoGe-2 ViT-L normal (MIT) |
| Evaluation second opinion | DA3METRIC-LARGE (Apache-2.0); Depth Pro pending legal review |
| Instances, windows, doors | SAM 3 (SAM License) |
| Apache-only fallback | Grounding DINO B + SAM 2.1 L |
| Walls, floor, ceiling, boxes, supports, relationships | Deterministic geometry (RANSAC planes, Manhattan frame, oriented boxes) |
| Room type, material class, builder form | SigLIP 2 zero-shot over our own enums (Apache-2.0) |
| Colour, pattern, lamp state | Deterministic pixel statistics |
| Furniture | Existing parametric builders; retrieval later |
| Runtime | Python 3.12, PyTorch with CUDA 12.x (≥ 12.6), `transformers`, FastAPI, numpy / scipy / Open3D-class geometry, pydantic from a shared JSON Schema; TypeScript compiler in `src/scene/compile/` |

### C. Reasoning, in one line each

1. **Commercial licences only on the path.** This rules out UniDepth,
   Depth Anything V2 Large, DA3-Large, SpatialLM, DUSt3R, Hunyuan3D 2.1 and
   nvdiffrast-bound generation.
2. **GeoCalib** is the only camera estimator that returns calibrated
   uncertainty and accepts priors.
3. **MoGe-2** gives metric points, normals and FOV in one pass under MIT, and
   fits 8 GB.
4. **Geometry-first layout** because floors and walls are planes. Fitting
   them is explainable, and no licensed single-image perspective layout model
   exists.
5. **SAM 3** gives every instance of each category in one pass, with a
   licence that permits commercial use. The Apache pair is kept behind the
   same interface in case evaluation or legal review says otherwise.
6. **Zero-shot scoring** keeps small classifications inside our enums.
7. **Deterministic appearance** because what can't be measured shouldn't be
   generated.
8. **Builders over generation**: editable and cheap, and they don't invent the
   hidden half of a sofa.
9. **Deterministic compile**: calibration is instant and exact, outputs are
   testable, and GPU work is never repeated to change a rule.

### D. Local hardware requirements

- The RTX 4060 Laptop (8 GB, ~6.9 GB free) is sufficient for developing the
  v1 stack at fp16/bf16. Peak memory is to be measured; per-stage loading is
  the fallback.
- **Free 25–40 GB of disk first**. 7.3 GB is free now.
- WSL2 with a current Ubuntu LTS, Python 3.12 via `uv`, a PyTorch CUDA 12.x
  wheel, and `.wslconfig` memory around 10 GB.
- No Docker and no `nvcc` needed for milestone 1.
- Image-to-3D models (16–32 GB) cannot run locally, and v1 doesn't need them.

### E. Production architecture

- Next.js on Vercel (existing), with dynamic route handlers for jobs, status,
  results and calibration.
- Private object storage with signed uploads, and managed Postgres for jobs,
  scenes and evidence.
- A GPU job queue feeding a stateless Python worker container on one 24 GB
  GPU (L4/A10G class) on a serverless-GPU platform (Modal, Cloud Run GPU or
  RunPod to be evaluated), with all v1 models resident.
- The worker reports through an HMAC-signed callback, and the handler compiles
  and stores the Scene.
- Explicit consent, metadata stripping, pinned weights, retention and deletion
  as in §20.

### F. First implementation milestone: **M1, the geometry spine, offline**

Goal: prove on real rooms that the pipeline measures a room shell correctly,
and says how sure it is, before any UI or service exists.

1. **Evaluation set.** 20–30 photographs of real rooms (several phones;
   portrait and landscape; a wide-lens shot; a dark shot; a mirror). Each is
   tape-measured: room width and depth, ceiling height, one door and one
   window width, camera height. This set is the ground truth everything later
   is judged against.
2. **Environment.** Set up per §9, after disk is freed. Download the pinned
   weights: GeoCalib, MoGe-2 ViT-L normal and DA3METRIC-LARGE. Do the
   download after approval.
3. **Worker CLI.** S0 (decode, orientation, EXIF focal, strip), S1 GeoCalib,
   S2 MoGe-2 (with DA3METRIC as a comparison run), S4 plane fitting. The
   output is a `ReconstructionIntermediate` v1 with artefacts.
4. **Compiler, shell only.**
   - floor, walls (observed and inferred), ceiling or inferred height,
     footprint, camera, provenance;
   - `SceneEvidence` and calibration by one reference;
   - golden tests from fixtures; invariants.
5. **Viewing.** Compiled scenes are opened by a local-only script in the
   existing renderer. No product route and no UI change.
6. **Report.** Per image and in aggregate:
   - uncalibrated error in room dimensions and ceiling height, for MoGe-2 and
     for DA3METRIC;
   - error after calibrating with the door width;
   - camera-height and FOV error against EXIF;
   - failure cases;
   - peak GPU memory and time per stage on the 4060.

**Exit criteria:**
- The compile is deterministic: the same intermediate gives byte-identical
  output.
- Calibration demonstrably reduces the other lengths' error, and residuals are
  shown.
- Every failure in the set produces a named problem, never a wrong-but-confident
  room.
- The measured errors are written into this document, replacing the targets
  in §15 and §22.
- The depth model choice is confirmed or changed on that evidence. Objects,
  materials, service and UI wait for this gate.

---

## Sources

Verified 2026-09-21 from primary pages unless stated.

- Depth Anything V2 (sizes, licences): https://github.com/DepthAnything/Depth-Anything-V2
- Depth Anything 3 (variants, licences): https://github.com/ByteDance-Seed/Depth-Anything-3, https://huggingface.co/depth-anything/DA3METRIC-LARGE
- MoGe / MoGe-2 (outputs, 60 ms, code licence): https://github.com/microsoft/MoGe; weights tag: https://huggingface.co/Ruicheng/moge-2-vitl-normal
- Depth Pro (outputs, speed): https://github.com/apple/ml-depth-pro; licence: https://raw.githubusercontent.com/apple/ml-depth-pro/main/LICENSE
- UniDepth: https://github.com/lpiccinelli-eth/UniDepth
- Metric3D: https://github.com/YvanYin/Metric3D
- GeoCalib: https://github.com/cvg/GeoCalib
- SAM 3: https://github.com/facebookresearch/sam3; licence: https://raw.githubusercontent.com/facebookresearch/sam3/main/LICENSE; throughput report: https://github.com/facebookresearch/sam3/issues/425; Meta blog: https://ai.meta.com/blog/segment-anything-model-3/
- SAM 2 / 2.1: https://github.com/facebookresearch/sam2
- SAM 3D Objects: https://github.com/facebookresearch/sam-3d-objects, setup: https://github.com/facebookresearch/sam-3d-objects/blob/main/doc/setup.md
- Grounding DINO: https://github.com/IDEA-Research/GroundingDINO, https://huggingface.co/IDEA-Research/grounding-dino-base
- OWLv2: https://huggingface.co/google/owlv2-large-patch14-ensemble
- YOLO-World licence: https://github.com/AILab-CVC/YOLO-World
- SpatialLM: https://github.com/manycore-research/SpatialLM
- MapAnything: https://github.com/facebookresearch/map-anything
- VGGT-1B-Commercial: https://huggingface.co/facebook/VGGT-1B-Commercial, https://github.com/facebookresearch/vggt
- TRELLIS: https://github.com/microsoft/TRELLIS; TRELLIS.2: https://github.com/microsoft/TRELLIS.2; nvdiffrast licence: https://raw.githubusercontent.com/NVlabs/nvdiffrast/main/LICENSE.txt
- Hunyuan3D 2.1: https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1, licence: https://raw.githubusercontent.com/Tencent-Hunyuan/Hunyuan3D-2.1/main/LICENSE
- ABO: https://amazon-berkeley-objects.s3.amazonaws.com/index.html
- Objaverse: https://huggingface.co/datasets/allenai/objaverse
- 3D-FUTURE terms: https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud202004171628_60052.html
- DINOv3 licence: https://ai.meta.com/resources/models-and-libraries/dinov3-license/
- Dense Material Segmentation: https://github.com/apple/ml-dms-dataset
- Intrinsic (Careaga & Aksoy): https://github.com/compphoto/Intrinsic
- DiffusionLight: https://github.com/DiffusionLight/DiffusionLight
- ADE20K terms: https://github.com/CSAILVision/ADE20K
- Qwen3-VL licence (secondary source): https://freeapihub.com/ai-models/qwen3-vl
- Next.js 16 route handlers: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`

Not verified here, stated from general knowledge and to be confirmed before
use:
- Florence-2 (MIT)
- SigLIP 2 (Apache-2.0)
- Ultralytics (AGPL-3.0 / enterprise)
- Poly Haven (CC0)
- the Grounding DINO 1.5/1.6 API-only status
- the NYUv2 error range in §15.1
- WSL2's default memory limit
- Ubuntu 20.04's support status
