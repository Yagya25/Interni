import {
  Color,
  LinearSRGBColorSpace,
  Matrix4,
  MeshDepthMaterial,
  Vector2,
  Vector3,
  type IUniform,
  type Material,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from "three";

/**
 * Understanding layers, implemented once as an extension to three's standard
 * material. Every visual mode the story needs (photograph, depth map, clay
 * model, material reveal, redesign sweep, section caps) is a uniform, never
 * a define, so switching modes never triggers a shader recompile mid-scroll.
 */

/**
 * Per-vertex position in the capture camera's view space, measured with
 * everything at rest. It is baked into the geometry, so it travels with a
 * mesh wherever the story moves it: a wall pulled out of the room still
 * knows which of its parts the photograph saw.
 */
export const PHOTO_ATTRIBUTE = "aPhotoView";

/** A colour whose value is already in output (display) space. */
export const displayColor = (hex: string) => new Color().setStyle(hex, LinearSRGBColorSpace);

export function createGlobalUniforms() {
  return {
    uCapturePos: { value: new Vector3() },
    uDepthMix: { value: 0 },
    uDepthFront: { value: 0 },
    uDepthNear: { value: displayColor("#f6f3ed") },
    uDepthFar: { value: displayColor("#5e5953") },
    uDepthLine: { value: displayColor("#2a2825") },
    uClay: { value: 0 },
    uClayColor: { value: new Color("#e7e3dc") },
    uAO: { value: 1 },
    uRoomMin: { value: new Vector3() },
    uRoomMax: { value: new Vector3() },
    uWave: { value: -100 },
    uWaveLine: { value: 0 },
    uAccent: { value: displayColor("#b8411f") },
    uPaper: { value: displayColor("#efece6") },
    uDimArch: { value: 0 },
    uDimObj: { value: 0 },
    uSection: { value: displayColor("#2a2825") },
    // What the photograph saw: the depth it recorded from its camera, read
    // back through the same projection. `uPhotoTexel` is one depth texel.
    uPhoto: { value: 0 },
    uPhotoDepth: { value: null as Texture | null },
    uPhotoTexel: { value: new Vector2(1, 1) },
    uPhotoProjection: { value: new Matrix4() },
    uPhotoNear: { value: 0.05 },
    uPhotoFar: { value: 80 },
    uPhotoUnseen: { value: displayColor("#dad4c9") },
  } satisfies Record<string, IUniform>;
}

export type GlobalUniforms = ReturnType<typeof createGlobalUniforms>;

/** Shared by every material of one reveal group (wood, fabric, ...). */
export function createRevealUniforms() {
  return {
    uReveal: { value: 0 },
    uRevealSeed: { value: new Vector3() },
    uRevealRadius: { value: 14 },
  } satisfies Record<string, IUniform>;
}

export type RevealUniforms = ReturnType<typeof createRevealUniforms>;

export const Role = { architecture: 0, object: 1 } as const;
export const Variant = { shared: 0, before: 1, after: 2 } as const;

/** Per scene object (or per architecture set). */
export function createInstanceUniforms(role: number, variant: number) {
  return {
    uClipY: { value: 1e5 },
    uVariant: { value: variant },
    uRole: { value: role },
  } satisfies Record<string, IUniform>;
}

export type InstanceUniforms = ReturnType<typeof createInstanceUniforms>;

const VERTEX_PARS = /* glsl */ `
varying vec3 vDWorld;
`;

const VERTEX_PHOTO_PARS = /* glsl */ `
attribute vec3 ${PHOTO_ATTRIBUTE};
varying vec3 vPhotoView;
`;

const VERTEX_WORLD = /* glsl */ `
#include <project_vertex>
vec4 dWorld = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  dWorld = instanceMatrix * dWorld;
#endif
vDWorld = ( modelMatrix * dWorld ).xyz;
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vDWorld;
uniform float uClipY;
uniform float uVariant;
uniform float uWave;
`;

const FRAGMENT_VISIBILITY = /* glsl */ `
// Redesign sweep: "before" exists right of the front, "after" left of it.
if ( uVariant > 0.5 ) {
  float dSide = vDWorld.x - uWave;
  if ( uVariant < 1.5 ? dSide < 0.0 : dSide > 0.0 ) discard;
}
if ( vDWorld.y > uClipY ) discard;
`;

const STANDARD_PARS = /* glsl */ `
${FRAGMENT_PARS}
uniform vec3 uCapturePos;
uniform float uDepthMix;
uniform float uDepthFront;
uniform vec3 uDepthNear;
uniform vec3 uDepthFar;
uniform vec3 uDepthLine;
uniform float uClay;
uniform vec3 uClayColor;
uniform float uAO;
uniform vec3 uRoomMin;
uniform vec3 uRoomMax;
uniform float uWaveLine;
uniform vec3 uAccent;
uniform vec3 uPaper;
uniform float uDimArch;
uniform float uDimObj;
uniform vec3 uSection;
uniform float uReveal;
uniform vec3 uRevealSeed;
uniform float uRevealRadius;
uniform float uRole;
uniform float uSectionCaps;
varying vec3 vPhotoView;
uniform float uPhoto;
uniform sampler2D uPhotoDepth;
uniform vec2 uPhotoTexel;
uniform mat4 uPhotoProjection;
uniform float uPhotoNear;
uniform float uPhotoFar;
uniform vec3 uPhotoUnseen;

// 1 where the photograph recorded this point, 0 where something stood in
// front of it, with a tolerance that grows with distance as depth
// precision falls.
float dPhotoSeen( vec2 uv, float distanceFromCamera ) {
  float recorded = ( uPhotoNear * uPhotoFar ) / ( ( uPhotoFar - uPhotoNear ) * texture2D( uPhotoDepth, uv ).r - uPhotoFar );
  float tolerance = 0.03 + 0.018 * distanceFromCamera;
  return 1.0 - smoothstep( tolerance, tolerance * 1.8, distanceFromCamera + recorded );
}

float dContour( float d, float spacing ) {
  float f = d / spacing;
  float g = abs( fract( f - 0.5 ) - 0.5 ) / max( fwidth( f ), 1e-4 );
  return 1.0 - min( g, 1.0 );
}
`;

const STANDARD_CLAY = /* glsl */ `
#include <metalnessmap_fragment>
// Clay: the room as a neutral architectural model. Each material class
// floods back in from a seed point as it is "identified".
float dRevealEdge = uReveal * uRevealRadius;
float dRevealMask = 1.0 - smoothstep( dRevealEdge - 0.35, dRevealEdge, distance( vDWorld, uRevealSeed ) );
float dClay = uClay * ( 1.0 - dRevealMask );
diffuseColor.rgb = mix( diffuseColor.rgb, uClayColor, dClay );
roughnessFactor = mix( roughnessFactor, 0.92, dClay );
metalnessFactor = mix( metalnessFactor, 0.0, dClay );
`;

const STANDARD_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance *= ( 1.0 - dClay );
`;

const STANDARD_OCCLUSION = /* glsl */ `
// Corner occlusion for architecture, computed from the room box: the second
// nearest room plane tells how close a fragment is to a corner.
if ( uRole < 0.5 && uAO > 0.001 ) {
  vec3 dA = vDWorld - uRoomMin;
  vec3 dB = uRoomMax - vDWorld;
  float ax = min( dA.x, dB.x );
  float ay = min( dA.y, dB.y );
  float az = min( dA.z, dB.z );
  float lo = min( ax, min( ay, az ) );
  float hi = max( ax, max( ay, az ) );
  float mid = ax + ay + az - lo - hi;
  float ao = mix( 0.58, 1.0, smoothstep( 0.0, 0.9, mid ) );
  outgoingLight *= mix( 1.0, ao, uAO );
}
#include <opaque_fragment>
`;

const STANDARD_OUTPUT = /* glsl */ `
#include <dithering_fragment>
// The room as the photograph knows it. Each fragment finds where it sat in
// the picture and whether the picture saw it there; what it saw is shown
// as the room renders it, sharp from any viewpoint, and what it never saw
// (behind the sofa, outside the frame) is left blank.
if ( uPhoto > 0.001 ) {
  vec4 pClip = uPhotoProjection * vec4( vPhotoView, 1.0 );
  vec2 pUv = pClip.xy / max( pClip.w, 1e-5 ) * 0.5 + 0.5;
  // A mesh built after the photograph has no coordinates (w = 0): unseen.
  float pInside = step( 1e-5, pClip.w ) * step( 0.0, pUv.x ) * step( pUv.x, 1.0 ) * step( 0.0, pUv.y ) * step( pUv.y, 1.0 );
  vec2 pUvIn = clamp( pUv, vec2( 0.0 ), vec2( 1.0 ) );
  float pDistance = -vPhotoView.z;
  // A 3×3 tent of taps, so the edge of the unseen is smooth rather than
  // stepped at the depth texture's resolution when the camera moves in.
  float pSeen = 0.0;
  for ( int i = -1; i <= 1; i ++ ) {
    for ( int j = -1; j <= 1; j ++ ) {
      float weight = ( 2.0 - abs( float( i ) ) ) * ( 2.0 - abs( float( j ) ) );
      pSeen += weight * dPhotoSeen( pUvIn + vec2( float( i ), float( j ) ) * uPhotoTexel * 0.75, pDistance );
    }
  }
  pSeen *= pInside / 16.0;
  // What was never seen is hatched, the way a drawing marks what is not
  // known, and the edge where it meets what was seen is a hairline.
  float pHatch = dContour( dot( vDWorld, vec3( 1.0, 0.8, 1.0 ) ), 0.09 );
  vec3 pUnseen = mix( uPhotoUnseen, uDepthLine, pHatch * 0.2 );
  float pTear = clamp( fwidth( pSeen ) * 1.2, 0.0, 1.0 );
  vec3 pShown = mix( mix( pUnseen, gl_FragColor.rgb, pSeen ), uDepthLine, pTear * 0.5 );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, pShown, uPhoto );
}

// Attention: fade what is not the subject towards paper.
gl_FragColor.rgb = mix( gl_FragColor.rgb, uPaper, uRole < 0.5 ? uDimArch : uDimObj );

// Depth map with iso-distance contours, measured from the capture camera
// and propagating outwards from it.
float dDist = distance( vDWorld, uCapturePos );
float dDepth = uDepthMix * ( 1.0 - smoothstep( uDepthFront - 0.9, uDepthFront, dDist ) );
if ( dDepth > 0.001 ) {
  float t = clamp( ( dDist - 0.8 ) / 7.2, 0.0, 1.0 );
  vec3 dCol = mix( uDepthNear, uDepthFar, smoothstep( 0.0, 1.0, t ) );
  // Faint quarter-metre lines, firmer whole metres.
  float lines = max( dContour( dDist, 0.25 ) * 0.14, dContour( dDist, 1.0 ) * 0.5 );
  dCol = mix( dCol, uDepthLine, lines );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, dCol, dDepth );
}

// The redesign front, drawn as a single hairline where it cuts surfaces.
if ( uWaveLine > 0.001 ) {
  float w = abs( vDWorld.x - uWave );
  float line = 1.0 - smoothstep( 0.0, fwidth( vDWorld.x ) * 1.25 + 0.002, w );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, uAccent, line * uWaveLine );
}

// Section caps: where a solid is cut open we see its back faces. Paint them
// as poché, the way a cut is drawn in an architectural section.
if ( uSectionCaps > 0.5 && !gl_FrontFacing ) gl_FragColor.rgb = uSection;
`;

type AnyUniforms = Record<string, IUniform>;

function injectVertex(shader: WebGLProgramParametersWithUniforms, photo = false) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERTEX_PARS}${photo ? VERTEX_PHOTO_PARS : ""}`)
    .replace("#include <project_vertex>", photo ? `${VERTEX_WORLD}vPhotoView = ${PHOTO_ATTRIBUTE};\n` : VERTEX_WORLD);
}

/** Extend a MeshStandardMaterial / MeshPhysicalMaterial. */
export function extendStandardMaterial(material: Material, uniforms: AnyUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader, true);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${STANDARD_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\n${FRAGMENT_VISIBILITY}`,
      )
      .replace("#include <metalnessmap_fragment>", STANDARD_CLAY)
      .replace("#include <emissivemap_fragment>", STANDARD_EMISSIVE)
      .replace("#include <opaque_fragment>", STANDARD_OCCLUSION)
      .replace("#include <dithering_fragment>", STANDARD_OUTPUT);
  };
  // All extended materials of a type share one program; only uniforms differ.
  material.customProgramCacheKey = () => "datum-standard";
}

/** Visibility rules only (variant sweep and clip), for unlit helpers. */
export function extendVisibility(material: Material, uniforms: AnyUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\n${FRAGMENT_VISIBILITY}`,
      );
  };
  material.customProgramCacheKey = () => `datum-visibility-${material.type}`;
}

/**
 * Shadow depth material honouring the same visibility rules, so a removed
 * or not-yet-built object never casts a shadow.
 */
export function createShadowDepthMaterial(uniforms: AnyUniforms) {
  // Same packing as three's own shadow pass (shadow maps are depth textures).
  const material = new MeshDepthMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_PARS}`)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>\n${FRAGMENT_VISIBILITY}`,
      );
  };
  material.customProgramCacheKey = () => "datum-depth";
  return material;
}
