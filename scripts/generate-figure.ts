import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import * as v from "valibot";
import { Rng } from "../app/game/rng";
import { DataStore } from "../app/lib/dataStore";
import {
  CLOAK_STYLES,
  DEFAULT_LOOK,
  HAIR_STYLES,
  LOWER_STYLES,
  SHEET_HEIGHT_PX,
  SHEET_WIDTH_PX,
  drawsFromCharacterBlock,
  figureLookSchema,
  randomLook,
  renderFigureSheet,
  type FigureLook,
} from "../app/lib/figure";
import type { TilesetDef } from "../app/lib/types";
import { DiskBlobs } from "../server/blobs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA = path.join(ROOT, "data");
const PREVIEW_ZOOM = 6;
const PREVIEW_BACKDROP = [0x23, 0x90, 0x63];

const USAGE = `Render a walking character sheet from the paper-doll parts in app/lib/figureParts.json.

  bun run generate:figure --name baker --hair bob --hair-colour fbb954 --legs robe
  bun run generate:figure --random --seed 7 --out /tmp/someone.png --preview /tmp
  bun run generate:figure --batch looks.json

Where it goes (one of):
  --name <name>          write data/tilesets/<slug>.png and add it to data/tilesets.json
  --out <file.png>       write only this PNG; data/ is not touched
  --batch <file.json>    an array of { name, look?, random?, seed?, tile? }, each saved as --name

The look starts from the default, or from --look or --random, and the flags below override it:
  --look <json|file>     a whole or partial look, in the shape --print-look prints
  --random               a random look; --seed <n> makes it repeatable
  --skin <hex>
  --hair <${HAIR_STYLES.join("|")}>
  --hair-colour <hex>
  --beard, --no-beard
  --shirt <hex>
  --trim <hex>           the collar and belt
  --legs <${LOWER_STYLES.join("|")}>
  --legs-colour <hex>
  --shoes <hex>
  --cloak <${CLOAK_STYLES.join("|")}>
  --cloak-colour <hex>

Colours are snapped to STAPES_PALETTE. Write them without the # (ae2334), or quote them,
since an unquoted # starts a shell comment.

Also:
  --tile <id>            move this tile's anchor onto the new sheet (needs --name)
  --preview <dir>        also write <slug>.preview.png there: the sheet at ${PREVIEW_ZOOM}x on grass
  --print-look           print each resolved look as JSON
  --help`;

type PartialLook = {
  skin?: string;
  hair?: Partial<FigureLook["hair"]>;
  beard?: boolean;
  shirt?: string;
  trim?: string;
  lower?: Partial<FigureLook["lower"]>;
  shoes?: string;
  cloak?: Partial<FigureLook["cloak"]>;
};

type Job = { name: string; look: FigureLook; out?: string; tile?: string };

const batchEntrySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  look: v.optional(v.record(v.string(), v.unknown())),
  random: v.optional(v.boolean()),
  seed: v.optional(v.number()),
  tile: v.optional(v.string()),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hex(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith("#") ? value : `#${value}`;
}

function overlay(base: FigureLook, over: PartialLook): FigureLook {
  const merged = {
    ...base,
    ...over,
    hair: { ...base.hair, ...over.hair },
    lower: { ...base.lower, ...over.lower },
    cloak: { ...base.cloak, ...over.cloak },
  };
  const parsed = v.safeParse(figureLookSchema, merged);
  if (!parsed.success) {
    const problems = parsed.issues.map((i) => {
      const at = i.path?.map((p) => p.key).join(".") ?? "look";
      return `  ${at}: ${i.message}`;
    });
    throw new Error(`That is not a look:\n${problems.join("\n")}`);
  }
  return parsed.output;
}

async function readJsonArg(value: string): Promise<unknown> {
  const text = value.trimStart().startsWith("{") ? value : await fs.readFile(value, "utf8");
  return JSON.parse(text);
}

function startingLook(random: boolean, seed: number | undefined): FigureLook {
  if (!random) return DEFAULT_LOOK;
  const rng =
    seed === undefined
      ? Math.random
      : (
          (r) => () =>
            r.next()
        )(new Rng(seed));
  return randomLook(rng);
}

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      out: { type: "string" },
      batch: { type: "string" },
      look: { type: "string" },
      random: { type: "boolean" },
      seed: { type: "string" },
      skin: { type: "string" },
      hair: { type: "string" },
      "hair-colour": { type: "string" },
      beard: { type: "boolean" },
      "no-beard": { type: "boolean" },
      shirt: { type: "string" },
      trim: { type: "string" },
      legs: { type: "string" },
      "legs-colour": { type: "string" },
      shoes: { type: "string" },
      cloak: { type: "string" },
      "cloak-colour": { type: "string" },
      tile: { type: "string" },
      preview: { type: "string" },
      "print-look": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const destinations = [values.name, values.out, values.batch].filter((d) => d !== undefined);
  if (destinations.length !== 1) {
    throw new Error("Say where the sheet goes: exactly one of --name, --out or --batch.");
  }
  if (values.tile && !values.name) {
    throw new Error("--tile moves a tile onto a registered sheet, so it needs --name.");
  }

  const jobs: Job[] = [];
  if (values.batch) {
    const raw = await readJsonArg(values.batch);
    const entries = v.parse(v.array(batchEntrySchema), raw);
    for (const entry of entries) {
      const base = startingLook(entry.random ?? false, entry.seed);
      jobs.push({
        name: entry.name,
        look: overlay(base, (entry.look ?? {}) as PartialLook),
        tile: entry.tile,
      });
    }
  } else {
    const seed = values.seed === undefined ? undefined : Number(values.seed);
    if (seed !== undefined && !Number.isInteger(seed)) throw new Error("--seed is a whole number.");
    let look = startingLook(values.random ?? false, seed);
    if (values.look) look = overlay(look, (await readJsonArg(values.look)) as PartialLook);
    const flags: PartialLook = {
      skin: hex(values.skin),
      shirt: hex(values.shirt),
      trim: hex(values.trim),
      shoes: hex(values.shoes),
      beard: values["no-beard"] ? false : values.beard,
      hair: {
        style: values.hair as FigureLook["hair"]["style"],
        colour: hex(values["hair-colour"]),
      },
      lower: {
        style: values.legs as FigureLook["lower"]["style"],
        colour: hex(values["legs-colour"]),
      },
      cloak: {
        style: values.cloak as FigureLook["cloak"]["style"],
        colour: hex(values["cloak-colour"]),
      },
    };
    look = overlay(look, JSON.parse(JSON.stringify(flags)) as PartialLook);
    const name = values.name ?? path.basename(values.out!, path.extname(values.out!));
    jobs.push({ name, look, out: values.out, tile: values.tile });
  }

  const store = new DataStore(new DiskBlobs(DATA));
  const registered = jobs.some((j) => !j.out);
  const tilesets = registered ? await store.readTilesets() : [];
  const tiles = jobs.some((j) => j.tile) ? await store.readTiles() : [];

  for (const job of jobs) {
    if (!slugify(job.name)) {
      throw new Error(`"${job.name}" has no letters or digits to name a file after.`);
    }
    if (!job.tile) continue;
    const tile = tiles.find((t) => t.id === job.tile);
    if (!tile) throw new Error(`No tile called ${job.tile} in data/tiles.json.`);
    if (!drawsFromCharacterBlock(tile)) {
      throw new Error(
        `${job.tile} walks from a block shaped differently from the player's, so a character sheet would draw it in pieces.`,
      );
    }
  }

  for (const job of jobs) {
    const id = slugify(job.name);
    const png = encodePng(renderFigureSheet(job.look), SHEET_WIDTH_PX, SHEET_HEIGHT_PX);

    if (job.out) {
      await fs.mkdir(path.dirname(path.resolve(job.out)), { recursive: true });
      await fs.writeFile(job.out, png);
      console.log(`Wrote ${job.out}`);
    } else {
      const def: TilesetDef = {
        id,
        name: job.name,
        file: `${id}.png`,
        width: SHEET_WIDTH_PX,
        height: SHEET_HEIGHT_PX,
      };
      await store.writeTilesetPng(def.file, png);
      const at = tilesets.findIndex((t) => t.id === id);
      if (at >= 0) tilesets[at] = def;
      else tilesets.push(def);
      console.log(`Wrote data/tilesets/${def.file} as tileset ${id}`);
    }

    if (job.tile) {
      tiles.find((t) => t.id === job.tile)!.anchor = { tilesetId: id, x: 0, y: 0 };
      console.log(`${job.tile} now draws from ${id}`);
    }

    if (values.preview) {
      const file = path.join(values.preview, `${id}.preview.png`);
      await fs.mkdir(values.preview, { recursive: true });
      await fs.writeFile(file, preview(renderFigureSheet(job.look)));
      console.log(`Wrote ${file}`);
    }

    if (values["print-look"]) console.log(JSON.stringify({ name: job.name, look: job.look }));
  }

  if (registered) await store.writeTilesets(tilesets);
  if (tiles.length > 0) await store.writeTiles(tiles);
}

function encodePng(rgba: Uint8ClampedArray, width: number, height: number) {
  const png = new PNG({ width, height });
  png.data.set(rgba);
  return new Uint8Array(PNG.sync.write(png)) as Uint8Array<ArrayBuffer>;
}

function preview(sheet: Uint8ClampedArray) {
  const width = SHEET_WIDTH_PX * PREVIEW_ZOOM;
  const height = SHEET_HEIGHT_PX * PREVIEW_ZOOM;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src =
        (Math.floor(y / PREVIEW_ZOOM) * SHEET_WIDTH_PX + Math.floor(x / PREVIEW_ZOOM)) * 4;
      const dst = (y * width + x) * 4;
      const opaque = sheet[src + 3]! > 0;
      for (let c = 0; c < 3; c++)
        png.data[dst + c] = opaque ? sheet[src + c]! : PREVIEW_BACKDROP[c]!;
      png.data[dst + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
