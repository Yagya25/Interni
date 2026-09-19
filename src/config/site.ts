/**
 * Site-wide configuration. Product naming and public routes live here so
 * that renaming the product or moving a route is a one-file change.
 *
 * "Datum" is a working name: in surveying and architecture a datum is the
 * reference plane every other measurement is taken from.
 */
const DEVELOPMENT_URL = "http://localhost:3000";

/**
 * The public origin, used for canonical links, Open Graph, robots and the
 * sitemap. Getting this wrong is quiet and expensive — a deployment that
 * falls back to localhost publishes canonical tags pointing at a machine
 * nobody can reach — so it is resolved in exactly one place.
 *
 * `next.config.ts` warns at build time when it is about to fall back; this
 * function stays silent, because a build renders each route in its own
 * worker and anything logged here is logged once per route.
 */
function resolveUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  // Set by Vercel to a project's stable production domain, rather than the
  // per-deployment URL. Harmless anywhere else, where it is simply unset.
  const platform = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const raw = configured || (platform ? `https://${platform}` : "");

  if (!raw) return DEVELOPMENT_URL;

  // Accept a bare hostname, and keep only the origin so joins stay clean.
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return DEVELOPMENT_URL;
  }
}

export const site = {
  name: "Datum",
  title: "Datum — Turn a photo of your room into an editable 3D space",
  description:
    "Datum turns a single photograph of a room into a 3D model that knows its walls, furniture, materials and light, so you can redesign the space you actually live in.",
  /** Used for canonical URLs and Open Graph. Override per environment. */
  url: resolveUrl(),
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
