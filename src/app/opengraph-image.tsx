import { ImageResponse } from "next/og";
import { site } from "@/config/site";

export const alt = `${site.name}: turn a photo of your room into an editable 3D space`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * A drawing, not a render: one-point perspective lines of a room inside a
 * photograph's frame, with the product's promise beside it.
 */
export default function OpenGraphImage() {
  const ink = "#191816";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: "#efece6",
          color: ink,
          padding: 64,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: 520 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 34, letterSpacing: -1 }}>
            <svg width="36" height="36" viewBox="0 0 24 24">
              <g fill="none" stroke={ink} strokeWidth="1.6">
                <rect x="2.75" y="2.75" width="18.5" height="18.5" />
                <rect x="8.75" y="7.75" width="6.5" height="7.5" />
                <path d="M2.75 2.75l6 5M21.25 2.75l-6 5M2.75 21.25l6-6M21.25 21.25l-6-6" />
              </g>
            </svg>
            {site.name}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            <div style={{ fontSize: 76, lineHeight: 0.95, letterSpacing: -3 }}>Reimagine your space.</div>
            <div style={{ fontSize: 28, lineHeight: 1.3, color: "#46433d" }}>
              One photograph becomes an editable 3D model of your room.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", flex: 1, justifyContent: "flex-end", alignItems: "center" }}>
          <svg width="470" height="500" viewBox="0 0 470 500">
            <g fill="none" stroke={ink} strokeWidth="1.5">
              <rect x="1" y="1" width="468" height="498" />
              <rect x="150" y="150" width="170" height="190" />
              <path d="M1 1L150 150M469 1L320 150M1 499L150 340M469 499L320 340" />
              <path d="M40 40L40 460M430 40L430 460" strokeDasharray="4 6" stroke="#a0988b" />
              <rect x="95" y="180" width="30" height="120" stroke="#a0988b" />
              <path d="M175 300h120v40H175z" />
              <path d="M200 420h90l-12 -30h-66z" stroke="#b8411f" />
            </g>
          </svg>
        </div>
      </div>
    ),
    size,
  );
}
