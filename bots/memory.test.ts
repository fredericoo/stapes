import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Landmarks, SAME_PLACE_CELLS } from "./memory";

let dir: string | null = null;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

it("shares what one bot saw with another that opens the same file, one place per wanderer", () => {
  dir = mkdtempSync(join(tmpdir(), "landmarks-"));
  const path = join(dir, "world.db");
  const finder = new Landmarks(path);
  finder.saw("blacksmith", { x: 10, y: 10, z: 0 }, 0);
  finder.saw("blacksmith", { x: 14, y: 10, z: 0 }, 1);
  finder.saw("blacksmith", { x: 10 + SAME_PLACE_CELLS * 4, y: 10, z: 0 }, 2);
  finder.close();

  const other = new Landmarks(path);
  expect(other.where("blacksmith", { x: 0, y: 10, z: 0 }, 3)).toEqual([
    { x: 14, y: 10, z: 0 },
    { x: 10 + SAME_PLACE_CELLS * 4, y: 10, z: 0 },
  ]);

  other.missing("blacksmith", { x: 13, y: 9, z: 0 });
  expect(other.where("blacksmith", { x: 0, y: 10, z: 0 }, 4)).toEqual([
    { x: 10 + SAME_PLACE_CELLS * 4, y: 10, z: 0 },
  ]);
  other.close();
});

it("shares deaths at the strongest rating that died there, how far each rating has been, and where bots are reborn", () => {
  dir = mkdtempSync(join(tmpdir(), "landmarks-"));
  const path = join(dir, "world.db");
  const first = new Landmarks(path);
  first.died({ x: 60, y: 0, z: 0 }, 5, 0);
  first.died({ x: 62, y: 0, z: 0 }, 3, 1);
  first.ventured(0, 3, 40, 2);
  first.ventured(0, 3, 30, 3);
  first.ventured(0, 7, 90, 4);
  first.reborn({ x: 1, y: 2, z: 0 }, 5);
  first.close();

  const other = new Landmarks(path);
  expect(other.deaths(6)).toEqual([{ at: { x: 62, y: 0, z: 0 }, rating: 5 }]);
  expect([other.farthest(0, 2, 6), other.farthest(0, 5, 6), other.farthest(0, 7, 6)]).toEqual([
    0, 40, 90,
  ]);
  expect(other.farthest(-1, 7, 6)).toBe(0);
  expect(other.home(6)).toEqual({ x: 1, y: 2, z: 0 });
  other.close();
});
