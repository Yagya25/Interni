import {
  Color,
  DirectionalLight,
  HemisphereLight,
  RectAreaLight,
  Vector3,
  type Scene as ThreeScene,
} from "three";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { clamp, lerp, smoothstep } from "@/lib/math";
import type { OpeningPart } from "./architecture";

/**
 * The light rig. Daylight is a real directional sun that enters through the
 * window openings and casts shadows, plus soft sky light from each window
 * and a low ambient term. Artificial lights are point lights at each
 * fixture's emitter. Time of day moves the sun and retunes every term.
 */

interface LightKey {
  t: number;
  sunElevation: number;
  /** Degrees from due west towards south. */
  sunAzimuth: number;
  sunColor: string;
  sunIntensity: number;
  skyColor: string;
  skyIntensity: number;
  ambient: number;
  environment: number;
  lamps: number;
  exposure: number;
  exterior: string;
  exteriorIntensity: number;
}

// Day → warm afternoon → evening.
const keys: LightKey[] = [
  { t: 0, sunElevation: 48, sunAzimuth: 38, sunColor: "#fff3e3", sunIntensity: 5.2, skyColor: "#e6edf2", skyIntensity: 9, ambient: 1.05, environment: 0.62, lamps: 0, exposure: 1.08, exterior: "#ffffff", exteriorIntensity: 2.6 },
  { t: 0.5, sunElevation: 20, sunAzimuth: 18, sunColor: "#ffc790", sunIntensity: 6.2, skyColor: "#f3dcc0", skyIntensity: 6, ambient: 0.8, environment: 0.5, lamps: 0.1, exposure: 1.1, exterior: "#ffe4c2", exteriorIntensity: 2.2 },
  { t: 0.68, sunElevation: 9, sunAzimuth: 8, sunColor: "#ffa15e", sunIntensity: 5.2, skyColor: "#ecc49f", skyIntensity: 4, ambient: 0.55, environment: 0.36, lamps: 0.45, exposure: 1.18, exterior: "#f8c79c", exteriorIntensity: 1.6 },
  { t: 1, sunElevation: -6, sunAzimuth: 0, sunColor: "#6f7fa8", sunIntensity: 0, skyColor: "#42547c", skyIntensity: 1.6, ambient: 0.14, environment: 0.09, lamps: 1, exposure: 1.45, exterior: "#33456a", exteriorIntensity: 0.7 },
];

export interface LightSample {
  sunDirection: Vector3;
  sunColor: Color;
  sunIntensity: number;
  skyColor: Color;
  skyIntensity: number;
  ambient: number;
  environment: number;
  lamps: number;
  exposure: number;
  exterior: Color;
  exteriorIntensity: number;
}

const tmpA = new Color();
const tmpB = new Color();

export function sampleLight(time: number, out: LightSample) {
  const t = clamp(time);
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const k = smoothstep(a.t, b.t, t);
  const mix = (x: number, y: number) => lerp(x, y, k);
  const elevation = (mix(a.sunElevation, b.sunElevation) * Math.PI) / 180;
  const azimuth = (mix(a.sunAzimuth, b.sunAzimuth) * Math.PI) / 180;
  // Direction from the room towards the sun: west is -X, south is +Z.
  out.sunDirection.set(
    -Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  );
  out.sunColor.copy(tmpA.set(a.sunColor)).lerp(tmpB.set(b.sunColor), k);
  out.sunIntensity = mix(a.sunIntensity, b.sunIntensity) * smoothstep(-4, 3, (elevation * 180) / Math.PI);
  out.skyColor.copy(tmpA.set(a.skyColor)).lerp(tmpB.set(b.skyColor), k);
  out.skyIntensity = mix(a.skyIntensity, b.skyIntensity);
  out.ambient = mix(a.ambient, b.ambient);
  out.environment = mix(a.environment, b.environment);
  out.lamps = mix(a.lamps, b.lamps);
  out.exposure = mix(a.exposure, b.exposure);
  out.exterior.copy(tmpA.set(a.exterior)).lerp(tmpB.set(b.exterior), k);
  out.exteriorIntensity = mix(a.exteriorIntensity, b.exteriorIntensity);
  return out;
}

export const createLightSample = (): LightSample => ({
  sunDirection: new Vector3(),
  sunColor: new Color(),
  sunIntensity: 0,
  skyColor: new Color(),
  skyIntensity: 0,
  ambient: 0,
  environment: 0,
  lamps: 0,
  exposure: 1,
  exterior: new Color(),
  exteriorIntensity: 1,
});

export class LightRig {
  readonly sun: DirectionalLight;
  readonly hemisphere: HemisphereLight;
  readonly windows: RectAreaLight[] = [];
  readonly sample = createLightSample();
  private readonly roomCenter: Vector3;

  constructor(
    scene: ThreeScene,
    roomCenter: Vector3,
    windows: OpeningPart[],
    shadowMapSize: number,
  ) {
    RectAreaLightUniformsLib.init();
    this.roomCenter = roomCenter.clone();

    this.sun = new DirectionalLight("#ffffff", 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -7;
    cam.right = 7;
    cam.top = 7;
    cam.bottom = -7;
    cam.near = 0.5;
    cam.far = 30;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 3;
    scene.add(this.sun, this.sun.target);

    this.hemisphere = new HemisphereLight("#f3efe8", "#b8ab98", 0.5);
    scene.add(this.hemisphere);

    for (const w of windows) {
      const light = new RectAreaLight("#ffffff", 4, w.width * 0.95, w.height * 0.95);
      light.position.copy(w.center).addScaledVector(w.inward, 0.02);
      light.lookAt(light.position.clone().add(w.inward));
      scene.add(light);
      this.windows.push(light);
    }
  }

  /** Apply the time of day. Returns the sample for fixtures and exposure. */
  update(time: number) {
    const s = sampleLight(time, this.sample);
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity;
    this.sun.position.copy(this.roomCenter).addScaledVector(s.sunDirection, 14);
    this.sun.target.position.copy(this.roomCenter);
    this.sun.target.updateMatrixWorld();

    this.hemisphere.intensity = s.ambient;
    for (const light of this.windows) {
      light.color.copy(s.skyColor);
      light.intensity = s.skyIntensity;
    }
    return s;
  }
}
