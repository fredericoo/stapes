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
