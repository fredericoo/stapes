import * as THREE from "three";
import { humanSheetCanvas } from "../lib/humanSheets";
import { dressHuman, humanSheetTileset, type HumanLook } from "../lib/humanSprite";
import type { TileDef, TilesetDef } from "../lib/types";

type Sheet = { tileset: TilesetDef; texture: THREE.Texture | null };

/**
 * Gives a renderer a catalogue in which every human tile is anchored on a
 * composed sheet, and the textures for those sheets once they are built. A
 * sheet's tileset is handed over only with its texture, so a human is not
 * drawn at all for the moment before its sheet exists rather than drawn in
 * the missing-texture magenta.
 */
export class HumanTextures {
  private readonly dressedFor = new WeakMap<Record<string, TileDef>, Record<string, TileDef>>();
  private readonly sheets = new Map<string, Sheet>();
  private disposed = false;

  constructor(private readonly onSheet: (tileset: TilesetDef, texture: THREE.Texture) => void) {}

  /** The same catalogue in gives the same copy out, so a view handing it over every frame costs one lookup. */
  dress(tilesById: Record<string, TileDef>): Record<string, TileDef> {
    const cached = this.dressedFor.get(tilesById);
    if (cached) return cached;
    let dressed: Record<string, TileDef> | null = null;
    for (const [id, def] of Object.entries(tilesById)) {
      const human = dressHuman(def);
      if (!human) continue;
      dressed ??= { ...tilesById };
      dressed[id] = human.def;
      this.ensure(human.sheetId, human.look);
    }
    const out = dressed ?? tilesById;
    this.dressedFor.set(tilesById, out);
    return out;
  }

  /** Sheets whose textures are built, for a renderer to put back after replacing its tilesets. */
  ready(): { tileset: TilesetDef; texture: THREE.Texture }[] {
    return [...this.sheets.values()].flatMap(({ tileset, texture }) =>
      texture ? [{ tileset, texture }] : [],
    );
  }

  dispose() {
    this.disposed = true;
    for (const { texture } of this.sheets.values()) texture?.dispose();
    this.sheets.clear();
  }

  private ensure(id: string, look: HumanLook) {
    if (this.sheets.has(id)) return;
    const sheet: Sheet = { tileset: humanSheetTileset(id), texture: null };
    this.sheets.set(id, sheet);
    humanSheetCanvas(look)
      .then((canvas) => {
        if (this.disposed) return;
        sheet.texture = sheetTexture(canvas);
        this.onSheet(sheet.tileset, sheet.texture);
      })
      .catch((err: unknown) => {
        this.sheets.delete(id);
        console.warn(`human sheet failed to build: ${id}`, err);
      });
  }
}

/** Matches the settings a loaded tileset gets, so a composed sheet samples the same way. */
function sheetTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}
