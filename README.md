# Datum

A photograph of a room, turned into a model you can redesign.

This repository holds the foundation, the landing page, and the scroll-driven
demonstration of the product. Reconstruction, the editor and AI redesign come
in later phases; the code is structured so they slot in without rewrites.

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

Set `NEXT_PUBLIC_SITE_URL` (see `.env.example`) so canonical and Open Graph
URLs point at the deployed origin.

## Structure

```
src/
  app/                    Routes: / (landing), /workspace (placeholder), 404,
                          error boundary, icons, Open Graph image, robots, sitemap
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
```

## How the landing page works

- **One timeline.** `features/landing/sequence/timeline.ts` builds a single
  GSAP timeline in abstract units. ScrollTrigger scrubs it across a tall
  section whose stage is pinned with `position: sticky`.
- **State, not effects.** The timeline animates a plain `ViewState` object
  (`scene/render/viewState.ts`). `SceneStage` renders a frame as a pure
  function of that object, on demand, so scrolling forwards, backwards,
  jumping, or refreshing mid-page always yields a coherent frame.
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

## Replacing the demo with real reconstruction

The landing page reads `demo` from `src/demo/index.ts` and nothing else.
A reconstruction result is a `Scene` (`src/scene/model/types.ts`); a redesign
is a `DesignVariant`; edits are `SceneOperation`s. Swap the source and the
renderer, labels and counts follow. Unknown object categories render as their
bounding volume until a dedicated builder exists.
