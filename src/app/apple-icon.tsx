import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The mark, drawn on paper for home screens. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#efece6",
        }}
      >
        <svg width="112" height="112" viewBox="0 0 24 24">
          <g fill="none" stroke="#191816" strokeWidth="1.2">
            <rect x="2.75" y="2.75" width="18.5" height="18.5" />
            <rect x="8.75" y="7.75" width="6.5" height="7.5" />
            <path d="M2.75 2.75l6 5M21.25 2.75l-6 5M2.75 21.25l6-6M21.25 21.25l-6-6" />
          </g>
        </svg>
      </div>
    ),
    size,
  );
}
