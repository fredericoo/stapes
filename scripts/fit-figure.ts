import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PNG } from "pngjs";
import {
  DEFAULT_LOOK,
  FRAME_PX,
  SHEET_FACINGS,
  SHEET_POSES,
  rampFor,
  renderFigureFrame,
  type FigureLook,
  type FigureRig,
  type WalkPose,
} from "../app/lib/figure";
import { FIGURE_RIG } from "../app/lib/figureRig";
import type { Direction } from "../app/lib/types";

const ROOT = path.resolve(import.meta.dirname, "..");
const PEOPLE = path.join(ROOT, "data", "tilesets", "people.png");
const RIG_FILE = path.join(ROOT, "app", "lib", "figureRig.ts");

/** The naked human is the second character block in `people.png`, beside the player. */
const NAKED_X = 48;

const OUTLINE = "#2e222f";
const SKIN_TONES = ["#6e2727", "#cd683d", "#fbb954"];

/** Every part in the one skin colour and the hair in the outline colour, which is how the naked human is drawn. */
const BARE: FigureLook = {
  ...DEFAULT_LOOK,
  skin: "#cd683d",
  shirt: "#cd683d",
  lower: { style: "trousers", colour: "#cd683d" },
  shoes: "#cd683d",
  hair: { style: "short", colour: OUTLINE },
  beard: false,
  cloak: { style: "none", colour: OUTLINE },
};

const EMPTY = 0;
const DARK = 1;

type Classes = Uint8Array;
type Path = (string | number)[];

const USAGE = `Fit the figure's rig to the naked human in people.png and rewrite app/lib/figureRig.ts.

  bun run fit:figure              fit, starting from the rig as it stands
  bun run fit:figure --rounds 3   fewer rounds, for a quick look
  bun run fit:figure --score      print how well the current rig matches, and change nothing
  bun run fit:figure --preview <dir>   also write <dir>/fit.png: the naked human beside the fit, 8x`;

function classify(rgba: Uint8ClampedArray, i: number, tones: readonly string[]): number {
  if (rgba[i + 3] === 0) return EMPTY;
  const hex = `#${[rgba[i]!, rgba[i + 1]!, rgba[i + 2]!].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const tone = tones.indexOf(hex);
  return tone >= 0 ? 2 + tone : DARK;
}

async function targets(): Promise<Map<string, Classes>> {
  const png = PNG.sync.read(await fs.readFile(PEOPLE));
  const out = new Map<string, Classes>();
  SHEET_FACINGS.forEach((facing, row) => {
    SHEET_POSES.forEach((pose, col) => {
      const classes = new Uint8Array(FRAME_PX * FRAME_PX);
      for (let y = 0; y < FRAME_PX; y++) {
        for (let x = 0; x < FRAME_PX; x++) {
          const i = ((row * FRAME_PX + y) * png.width + NAKED_X + col * FRAME_PX + x) * 4;
          classes[y * FRAME_PX + x] = classify(
            png.data as unknown as Uint8ClampedArray,
            i,
            SKIN_TONES,
          );
        }
      }
      out.set(`${facing}/${pose}`, classes);
    });
  });
  return out;
}

const RENDERED_TONES = rampFor(BARE.skin);

function frameScore(rig: FigureRig, facing: Direction, pose: WalkPose, target: Classes): number {
  const art = renderFigureFrame(BARE, facing, pose, rig);
  let union = 0;
  let got = 0;
  const renderedTones = [0, 0, 0];
  const targetTones = [0, 0, 0];
  for (let p = 0; p < target.length; p++) {
    const r = classify(art, p * 4, RENDERED_TONES);
    const t = target[p]!;
    if (r > DARK) renderedTones[r - 2]!++;
    if (t > DARK) targetTones[t - 2]!++;
    if (r === EMPTY && t === EMPTY) continue;
    union++;
    if (r === t) got += 1;
    else if (r > DARK && t > DARK) got += 0.25;
    else if (r !== EMPTY && t !== EMPTY) got += 0.1;
  }
  /**
   * Where each tone falls rarely lines up pixel for pixel, so matching tones
   * alone cannot tell a dark figure from a light one. This term compares how
   * much of the skin is each tone, which is what reads as the figure's value.
   */
  const skin = Math.max(1, targetTones[0]! + targetTones[1]! + targetTones[2]!);
  const toneError =
    renderedTones.reduce((sum, n, i) => sum + Math.abs(n - targetTones[i]!), 0) / skin;
  return got / union - 0.3 * toneError;
}

function get(obj: unknown, p: Path): number {
  return p.reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], obj) as number;
}

function set(obj: unknown, p: Path, value: number) {
  const parent = p
    .slice(0, -1)
    .reduce<unknown>((o, k) => (o as Record<string | number, unknown>)[k], obj);
  (parent as Record<string | number, number>)[p.at(-1)!] = value;
}

function framePaths(facing: Direction, pose: WalkPose): Path[] {
  const base: Path = ["facings", facing, "poses", pose];
  const paths: Path[] = [
    [...base, "at", 0],
    [...base, "at", 1],
    [...base, "hipZ"],
    [...base, "shoulderZ"],
  ];
  for (const side of [0, 1]) {
    for (const axis of [0, 1]) paths.push([...base, "feet", side, axis]);
    for (const axis of [0, 1, 2]) {
      paths.push([...base, "elbows", side, axis]);
      paths.push([...base, "hands", side, axis]);
    }
  }
  return paths;
}

function headPaths(facing: Direction): Path[] {
  return [0, 1, 2].map((axis) => ["facings", facing, "head", axis]);
}

function buildPaths(rig: FigureRig): Path[] {
  return Object.keys(rig.build).map((key) => ["build", key]);
}

const LIMITS: Record<string, [number, number]> = {
  headR: [0.8, 2.2],
  headWidth: [0.7, 1.4],
  headHeight: [0.6, 1.3],
  torsoWidth: [0.6, 2],
  torsoDepth: [0.3, 1.2],
  legR: [0.3, 0.9],
  footR: [0.3, 0.9],
  armR: [0.3, 0.8],
  handR: [0.3, 0.7],
  highlightAbove: [0.3, 0.98],
  shadowBelow: [-0.5, 0.6],
  coverage: [0.2, 0.7],
};

function clampFor(p: Path, value: number): number {
  const limit = LIMITS[String(p.at(-1))];
  return limit ? Math.min(limit[1], Math.max(limit[0], value)) : value;
}

/** One pass of coordinate descent: each parameter tries a step either way and keeps whichever scores better. */
function descend(rig: FigureRig, paths: Path[], step: number, score: (r: FigureRig) => number) {
  let best = score(rig);
  for (const p of paths) {
    const start = get(rig, p);
    for (const delta of [step, -step]) {
      set(rig, p, clampFor(p, start + delta));
      const s = score(rig);
      if (s > best + 1e-9) {
        best = s;
        break;
      }
      set(rig, p, start);
    }
  }
  return best;
}

function round2(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 100) / 100;
  if (Array.isArray(value)) return value.map(round2);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round2(v)]));
  }
  return value;
}

async function writeRig(rig: FigureRig) {
  const body = JSON.stringify(round2(rig), null, 2);
  const source = `import type { FigureRig } from "./figure";

/** Written by \`bun run fit:figure\`, which fits every number here to the naked human in \`people.png\`. Edit by hand only to try a value before fitting again. */
export const FIGURE_RIG: FigureRig = ${body};
`;
  await fs.writeFile(RIG_FILE, source);
  const format = Bun.spawnSync(["bunx", "oxfmt", RIG_FILE], { cwd: ROOT });
  if (format.exitCode !== 0) throw new Error(format.stderr.toString());
}

async function writePreview(dir: string, rig: FigureRig) {
  const zoom = 8;
  const people = PNG.sync.read(await fs.readFile(PEOPLE));
  const width = FRAME_PX * 6 * zoom;
  const height = FRAME_PX * 4 * zoom;
  const png = new PNG({ width, height });
  const backdrop = [0x23, 0x90, 0x63];
  SHEET_FACINGS.forEach((facing, row) => {
    SHEET_POSES.forEach((pose, col) => {
      const fit = renderFigureFrame(BARE, facing, pose, rig);
      for (let y = 0; y < FRAME_PX * zoom; y++) {
        for (let x = 0; x < FRAME_PX * zoom; x++) {
          const sx = Math.floor(x / zoom);
          const sy = Math.floor(y / zoom);
          const src = ((row * FRAME_PX + sy) * people.width + NAKED_X + col * FRAME_PX + sx) * 4;
          const own = (sy * FRAME_PX + sx) * 4;
          const left = ((row * FRAME_PX * zoom + y) * width + col * FRAME_PX * zoom + x) * 4;
          const right = left + 3 * FRAME_PX * zoom * 4;
          for (let c = 0; c < 3; c++) {
            png.data[left + c] = people.data[src + 3] ? people.data[src + c]! : backdrop[c]!;
            png.data[right + c] = fit[own + 3] ? fit[own + c]! : backdrop[c]!;
          }
          png.data[left + 3] = 255;
          png.data[right + 3] = 255;
        }
      }
    });
  });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "fit.png"), PNG.sync.write(png));
  console.log(`Wrote ${path.join(dir, "fit.png")}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      rounds: { type: "string" },
      score: { type: "boolean" },
      preview: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const target = await targets();
  const rig = structuredClone(FIGURE_RIG);
  const facingScore = (r: FigureRig, facing: Direction) =>
    SHEET_POSES.reduce(
      (sum, pose) => sum + frameScore(r, facing, pose, target.get(`${facing}/${pose}`)!),
      0,
    ) / 3;
  const totalScore = (r: FigureRig) =>
    SHEET_FACINGS.reduce((sum, facing) => sum + facingScore(r, facing), 0) / 4;

  const report = (label: string) => {
    const rows = SHEET_FACINGS.map(
      (facing) =>
        `${facing} ${SHEET_POSES.map((pose) => frameScore(rig, facing, pose, target.get(`${facing}/${pose}`)!).toFixed(3)).join(" ")}`,
    );
    console.log(`${label}: ${totalScore(rig).toFixed(4)}   ${rows.join("   ")}`);
  };

  report("start");
  if (!values.score) {
    const rounds = Number(values.rounds ?? 8);
    let step = 0.5;
    for (let round = 1; round <= rounds; round++) {
      for (const facing of SHEET_FACINGS) {
        for (const pose of SHEET_POSES) {
          const t = target.get(`${facing}/${pose}`)!;
          for (let pass = 0; pass < 2; pass++) {
            descend(rig, framePaths(facing, pose), step, (r) => frameScore(r, facing, pose, t));
          }
        }
        descend(rig, headPaths(facing), step, (r) => facingScore(r, facing));
      }
      descend(rig, buildPaths(rig), step / 2, totalScore);
      report(`round ${round} step ${step.toFixed(3)}`);
      step = Math.max(0.05, step * 0.7);
    }
    await writeRig(rig);
    console.log(`Wrote ${path.relative(ROOT, RIG_FILE)}`);
  }
  if (values.preview) await writePreview(values.preview, rig);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
