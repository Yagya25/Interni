/**
 * Site-wide configuration. Product naming and public routes live here so
 * that renaming the product or moving a route is a one-file change.
 *
 * "Datum" is a working name: in surveying and architecture a datum is the
 * reference plane every other measurement is taken from.
 */
export const site = {
  name: "Datum",
  title: "Datum — Turn a photo of your room into an editable 3D space",
  description:
    "Datum turns a single photograph of a room into a 3D model that knows its walls, furniture, materials and light, so you can redesign the space you actually live in.",
  /** Used for canonical URLs and Open Graph. Override per environment. */
  url: process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000",
  locale: "en_GB",
} as const;

export const routes = {
  home: "/",
  /** Entry point of the product. Upload + reconstruction arrive in a later phase. */
  workspace: "/workspace",
} as const;

/** In-page anchors used by the navigation. */
export const anchors = {
  main: "main",
  sequence: "how-it-works",
  reimagine: "reimagine",
} as const;
