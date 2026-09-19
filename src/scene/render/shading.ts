import {
  Color,
  LinearSRGBColorSpace,
  MeshDepthMaterial,
  Vector3,
  type IUniform,
  type Material,
  type WebGLProgramParametersWithUniforms,
} from "three";

/**
 * Understanding layers, implemented once as an extension to three's standard
 * material. Every visual mode the story needs (depth map, clay model,
 * material reveal, redesign sweep, section caps) is a uniform, never a
 * define, so switching modes never triggers a shader recompile mid-scroll.
 */

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

function injectVertex(shader: WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERTEX_PARS}`)
    .replace("#include <project_vertex>", VERTEX_WORLD);
}

/** Extend a MeshStandardMaterial / MeshPhysicalMaterial. */
export function extendStandardMaterial(material: Material, uniforms: AnyUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    injectVertex(shader);
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
