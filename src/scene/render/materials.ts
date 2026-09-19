import { Color, DoubleSide, FrontSide, MeshStandardMaterial, type Side } from "three";
import type { Material as SceneMaterial } from "@/scene/model/types";
import {
  extendStandardMaterial,
  type GlobalUniforms,
  type InstanceUniforms,
  type RevealUniforms,
} from "./shading";
import type { TextureLibrary } from "./textures";
import { revealGroupOf, type RevealGroup } from "./viewState";

export interface MaterialOptions {
  side?: Side;
  /** Paint cut faces as poché when this solid is sectioned. */
  sectionCaps?: boolean;
  /** Request a separate instance of a slot's material (e.g. an image vs its mat). */
  key?: string;
}

/**
 * Turns scene materials into renderable materials. Materials are created per
 * object so an object can be recoloured, clipped or highlighted on its own;
 * they still share one shader program.
 */
export class MaterialFactory {
  private readonly created: MeshStandardMaterial[] = [];

  constructor(
    private readonly textures: TextureLibrary,
    private readonly globals: GlobalUniforms,
    private readonly reveal: Record<RevealGroup, RevealUniforms>,
  ) {}

  create(source: SceneMaterial, instance: InstanceUniforms, options: MaterialOptions = {}) {
    const map = this.textures.get(source.pattern, source.patternScale ?? 1);
    const transparent = source.opacity !== undefined && source.opacity < 1;
    const material = new MeshStandardMaterial({
      color: new Color(source.color),
      roughness: source.roughness,
      metalness: source.metalness,
      map,
      transparent,
      opacity: source.opacity ?? 1,
      depthWrite: !transparent || (source.opacity ?? 1) > 0.5,
      side: options.side ?? (options.sectionCaps ? DoubleSide : FrontSide),
      envMapIntensity: source.class === "glass" ? 1.2 : source.class === "metal" ? 0.9 : 0.55,
    });
    if (source.emissive) {
      material.emissive = new Color(source.emissive);
      material.emissiveIntensity = 0;
      material.userData.emissive = true;
    }
    const uniforms = {
      ...this.globals,
      ...this.reveal[revealGroupOf(source.class)],
      ...instance,
      uSectionCaps: { value: options.sectionCaps ? 1 : 0 },
    };
    extendStandardMaterial(material, uniforms);
    material.userData.sourceId = source.id;
    this.created.push(material);
    return material;
  }

  dispose() {
    this.created.forEach((m) => m.dispose());
    this.created.length = 0;
  }
}
