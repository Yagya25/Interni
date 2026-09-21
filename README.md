# Datum

A photograph of a room, turned into a model you can redesign.

This repository holds the foundation, the landing page, and the workspace:
the room as an editable model, with selection, transforms, materials,
lighting, history and a command surface. Reconstruction from a real
photograph, and the model that reads a sentence as a change, come next; both
have integration boundaries waiting for them.

> "Datum" is a working name, set in `src/config/site.ts`.

## Commands

```bash
npm install
npm run dev         # http://localhost:3000
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # production build (Turbopack)
npm run start       # serve the production build
```

Set `NEXT_PUBLIC_SITE_URL` (see `.env.example`) so canonical links, Open Graph
images, `robots.txt` and the sitemap point at the deployed origin. A bare
hostname is accepted and assumed to be `https`. On Vercel it is optional — the
project's production domain is used instead — and the production build warns
when neither is available, rather than quietly publishing localhost URLs.

## Structure

```
src/
  app/                    Routes: / (landing), /workspace (entry),
                          /workspace/demo (the workspace), 404, error
                          boundary, icons, Open Graph image, robots, sitemap
  config/site.ts          Product name, copy, routes, in-page anchors
  components/             Shared primitives: Text, Button, Container,
                          StatusState (loading / error / empty / success),
                          Wordmark, PageShell
  lib/                    gsap registration, math, media-query hooks
  scene/
    model/                The scene contract (types), operations, queries,
                          and the derived summary ("what the model knows")
    render/               three.js renderer for any Scene: architecture,
                          object builders, materials, procedural textures,
                          lighting, annotations, and SceneStage (the engine)
  demo/                   The single source of demonstration data: the room,
                          its redesign, the edit operations, material callouts
  features/landing/       The landing page: navigation, footer, and the
                          scroll sequence (chapters, shots, timeline, layers)
  features/workspace/     The product: the shell, the viewport, the tool
                          panels, the inspector, the command surface
    state/                Document, history, and the intents that produce
                          scene operations
    scene/                The bridge to SceneStage: mounting, the camera
                          rig, pointer gestures, dragging
    ai/                   The interpreter boundary, and the rule-based reader
                          behind it (normalises wording; not a language model)
    assets/               What a replacement can be fulfilled with: today,
                          the forms the renderer has builders for
```

## How the landing page works

- **One timeline.** `features/landing/sequence/timeline.ts` builds a single
  GSAP timeline in abstract units. ScrollTrigger scrubs it across a tall
  section whose stage is pinned with `position: sticky`.
- **State, not effects.** The timeline animates a plain `ViewState` object
  (`scene/render/viewState.ts`). `SceneStage` renders a frame as a pure
  function of that object, on demand, so scrolling forwards, backwards,
  jumping, or refreshing mid-page always yields a coherent frame.
- **The photograph opens up.** The stage records the depth its capture
  camera can see (`StageOptions.photograph`), and each vertex carries where
  it sat in that view (`PHOTO_ATTRIBUTE`). With `view.photo` on, whatever the
  photograph saw is drawn and whatever it never saw — behind the sofa, the
  wall outside the frame — is left blank and hatched, wherever the camera
  goes. Walls pulled apart and furniture lifted out keep that knowledge with
  them. The surfaces are rendered rather than textured with the picture's
  own pixels, so they stay sharp when the camera moves in.
- **No React re-renders while scrolling.** Only chapter changes (a dozen per
  visit) touch React state. Progress bars and 3D-anchored labels are written
  straight to the DOM.
- **Understanding layers are uniforms.** Depth contours, the clay model,
  per-material reveal, the redesign sweep and section caps are one shader
  extension (`scene/render/shading.ts`); changing view never recompiles.
- **Reduced motion** shows each chapter in its settled state, switching
  without animation.
- **Honest data.** Every number on screen is derived from the demo scene via
  `summarizeScene`. The scene is labelled as a demonstration wherever it is
  shown.

## How the workspace works

- **The scene is the document.** Every change — dragged, typed into a field,
  or one day written as a sentence — becomes a `SceneOperation` applied to
  the scene (`scene/model/operations.ts`). Nothing mutates a mesh. An
  operation that asks for what is already true returns the same scene, so a
  drag held against a wall costs nothing and leaves no history.
- **History is operations, not snapshots.** Each entry records the
  operations and the inverses read from the scene *before* they ran, so undo
  reverses what happened rather than reloading. Continuous gestures share a
  merge key and collapse into one step. Some acts are several operations:
  moving or turning a table moves what stands on it (`moveWithLoad`),
  removing it removes them, and one undo brings the stack back together.
- **The renderer is told, not asked.** `SceneStage.syncScene` diffs the new
  scene against the old, mostly by reference — an operation shares
  everything it did not touch — and updates transforms, materials and lights
  in place. Only a change to what an object *is* costs a rebuild. The store
  is subscribed to outside React, so editing the room re-renders no
  components.
- **The camera is view state, not document state.** `CameraRig` writes into
  the same `ViewState` the landing page's timeline writes into, within
  limits that keep the view inside the room it is looking at.
- **Commands are operations too.** The command bar sends to a
  `CommandInterpreter`. The one connected is rule-based: it normalises
  wording and synonyms (`ai/demo/vocabulary.ts`), reads a structured
  `CommandIntent` (intent, target, action, parameters, confidence,
  clarification), resolves the target against the scene, and builds the same
  operations a hand would, shown as a proposal to apply or discard. A name
  that fits two pieces, or "this" with nothing selected, is asked about rather
  than guessed. A replacement is fulfilled only when a builder draws the form
  asked for (`assets/catalogue.ts`); otherwise the request is shown, as
  understood, with no operation behind it. A language model replaces the
  reader behind the same interface.
- **Nothing pretends.** Uploading a photograph reads, decodes and measures it
  in the browser, keeps it on screen, and stops at the reconstruction
  boundary. The demonstration room is only ever opened on request.

## Replacing the demo with real reconstruction

The landing page reads `demo` from `src/demo/index.ts` and nothing else.
A reconstruction result is a `Scene` (`src/scene/model/types.ts`); a redesign
is a `DesignVariant`; edits are `SceneOperation`s. Swap the source and the
renderer, labels and counts follow. Unknown object categories render as their
bounding volume until a dedicated builder exists.
