import type { ReactNode } from "react";

/**
 * The workspace's instrument marks.
 *
 * Drawn in the same hand as the wordmark: a 24-unit square, hairline
 * strokes, no fills, no rounded caps. Each one is a drafting symbol for
 * what the tool does rather than a picture of a thing — a frustum for the
 * camera, a hatched square for materials, a prism for interpretation.
 */

function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

/** Language entering, discrete changes leaving. */
export const AiIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M2.5 12h4.2" />
    <path d="M10.5 4.6 17.9 18H3.1z" />
    <path d="M18.6 7.4h2.9M20.2 12h1.3M18.6 16.6h2.9" />
  </Glyph>
);

/** Pieces standing in a plan. */
export const ObjectsIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.75" y="2.75" width="18.5" height="18.5" />
    <rect x="5.75" y="5.75" width="7" height="4.5" />
    <rect x="14" y="13" width="4.25" height="5.25" />
  </Glyph>
);

/** Swatches laid over one another, the top one hatched. */
export const MaterialsIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.75" y="7.75" width="9.5" height="9.5" />
    <path d="M4.6 15.4 9.9 10.1M4.6 12.1 8.6 8.1" />
    <path d="M8.75 7.25V4.75h9.5v9.5h-2.5" />
    <path d="M12.25 11.75h6.5v6.5" />
  </Glyph>
);

/** Sun over a sill. */
export const LightingIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M7.4 15.5a4.6 4.6 0 0 1 9.2 0" />
    <path d="M2.5 15.5h19" />
    <path d="M12 3.3v2.4M4.8 6.4l1.7 1.7M19.2 6.4l-1.7 1.7" />
    <path d="M5.5 19.2h13" />
  </Glyph>
);

/** A view frustum in plan. */
export const CameraIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 19.4 4 5.6h16z" />
    <circle cx="12" cy="19.4" r="1.7" />
    <path d="M6.6 10.2h10.8" />
  </Glyph>
);

export const UndoIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 9.5h10a5 5 0 0 1 0 10H9" />
    <path d="m8 5-3.5 4.5L8 14" />
  </Glyph>
);

export const RedoIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M19.5 9.5h-10a5 5 0 0 0 0 10H15" />
    <path d="m16 5 3.5 4.5L16 14" />
  </Glyph>
);

export const CloseIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M5.5 5.5l13 13M18.5 5.5l-13 13" />
  </Glyph>
);

export const SendIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 19.5v-15M5.5 11 12 4.5 18.5 11" />
  </Glyph>
);

/** Back to the viewpoint the photograph was taken from. */
export const CaptureViewIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="2.75" y="4.75" width="18.5" height="14.5" />
    <circle cx="12" cy="12" r="3.4" />
  </Glyph>
);

/** Straight on, at eye level. */
export const FrontViewIcon = (p: IconProps) => (
  <Glyph {...p}>
    <rect x="4.75" y="6.75" width="14.5" height="10.5" />
    <path d="M2.5 20.5h19" />
  </Glyph>
);

/** Looking down on the plan. */
export const TopViewIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M12 2.8v4.4M9.8 5.4 12 7.6l2.2-2.2" />
    <rect x="4.75" y="10.75" width="14.5" height="9.5" />
  </Glyph>
);

export const FrameIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.5 8.5v-5h5M20.5 8.5v-5h-5M3.5 15.5v5h5M20.5 15.5v5h-5" />
    <rect x="9.25" y="9.25" width="5.5" height="5.5" />
  </Glyph>
);

export const ZoomInIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 12h15M12 4.5v15" />
  </Glyph>
);

export const ZoomOutIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4.5 12h15" />
  </Glyph>
);

/** A section cut with its dimension line: how each value was known. */
export const EvidenceIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M4 4.5h12.5l3.5 3.5v11.5H4z" />
    <path d="M7.5 10h9M7.5 13.5h9M7.5 17h5" />
  </Glyph>
);

/** A dimension line between two ticks: one known length. */
export const CalibrateIcon = (p: IconProps) => (
  <Glyph {...p}>
    <path d="M3.5 7v10M20.5 7v10" />
    <path d="M3.5 12h17" />
    <path d="M6.5 9.5 3.5 12l3 2.5M17.5 9.5l3 2.5-3 2.5" />
  </Glyph>
);
