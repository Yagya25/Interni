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

const BLACK = new Color(0, 0, 0);

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
    const material = new MeshStandardMaterial({
      side: options.side ?? (options.sectionCaps ? DoubleSide : FrontSide),
    });
    this.applyTo(material, source);
    const uniforms = {
      ...this.globals,
      ...this.reveal[revealGroupOf(source.class)],
      ...instance,
      uSectionCaps: { value: options.sectionCaps ? 1 : 0 },
    };
    extendStandardMaterial(material, uniforms);
    this.created.push(material);
    return material;
  }

  /**
   * Point an existing material at a different scene material, in place.
   *
   * Editing a surface or a slot this way keeps the mesh, its geometry and
   * its compiled program: nothing is rebuilt to recolour a sofa. The reveal
   * uniforms a material was created with stay bound to the class it was
   * built for, which only the landing page's per-class reveal reads.
   */
  applyTo(material: MeshStandardMaterial, source: SceneMaterial) {
    const map = this.textures.get(source.pattern, source.patternScale ?? 1);
    const transparent = source.opacity !== undefined && source.opacity < 1;
    // Swapping a texture or crossing the transparency boundary changes the
    // program's definitions, so the material has to be recompiled.
    if (material.map !== map || material.transparent !== transparent) material.needsUpdate = true;

    material.color.set(source.color);
    material.roughness = source.roughness;
    material.metalness = source.metalness;
    material.map = map;
    material.transparent = transparent;
    material.opacity = source.opacity ?? 1;
    material.depthWrite = !transparent || (source.opacity ?? 1) > 0.5;
    material.envMapIntensity = source.class === "glass" ? 1.2 : source.class === "metal" ? 0.9 : 0.55;

    if (source.emissive) {
      material.emissive.set(source.emissive);
      // A fixture starts dark; the light rig raises it with the lamp it drives.
      if (!material.userData.emissive) material.emissiveIntensity = 0;
      material.userData.emissive = true;
    } else if (material.userData.emissive) {
      material.emissive.set(BLACK);
      material.emissiveIntensity = 0;
      material.userData.emissive = false;
    }
    material.userData.sourceId = source.id;
  }

  dispose() {
    this.created.forEach((m) => m.dispose());
    this.created.length = 0;
  }
}
