import { describe, expect, it } from "vitest";
import {
  absoluteElevation,
  boxSurface,
  DEPTH_LEAST_BODY,
  boxSurfaceElevation,
  depthBox,
  depthStackBias,
  drawOrder,
  fragDepth,
  PX_PER_HEIGHT,
} from "./geometry";
import { CELL_SIZE, HEIGHT_PER_LEVEL } from "./types";

function expectInFront(near: number, far: number) {
  expect(near).toBeLessThan(far);
}

function footPixel(cellX: number, cellY: number) {
  return { sx: cellX * CELL_SIZE, sy: cellY * CELL_SIZE };
}

describe("something standing in a doorway", () => {
  const DOORWAY = { x: 0, y: 0 };
  const door = depthBox(DOORWAY.x, DOORWAY.y, 0, HEIGHT_PER_LEVEL);
  const HEAD_ELEV = HEIGHT_PER_LEVEL - 0.5;
  const head = {
    sx: DOORWAY.x * CELL_SIZE - HEAD_ELEV * PX_PER_HEIGHT,
    sy: DOORWAY.y * CELL_SIZE - HEAD_ELEV * PX_PER_HEIGHT,
  };
  const doorBias = depthStackBias(0, 0);
  const bodyBias = depthStackBias(0, 1);

  it("loses its top to the door when each is boxed by its own volume", () => {
    const cutToVolume = depthBox(DOORWAY.x, DOORWAY.y, 0, HEIGHT_PER_LEVEL - 1);
    expectInFront(
      fragDepth(door, head.sx, head.sy, doorBias),
      fragDepth(cutToVolume, head.sx, head.sy, bodyBias),
    );
  });

  it("keeps it once the two share the clump's extent", () => {
    const clumped = depthBox(DOORWAY.x, DOORWAY.y, 0, HEIGHT_PER_LEVEL);
    expectInFront(
      fragDepth(clumped, head.sx, head.sy, bodyBias),
      fragDepth(door, head.sx, head.sy, doorBias),
    );
  });
});

describe("absoluteElevation", () => {
  it("combines level floor with in-stack elevation", () => {
    expect(absoluteElevation(0, 0)).toBe(0);
    expect(absoluteElevation(0, 2)).toBe(2);
    expect(absoluteElevation(1, 0)).toBe(HEIGHT_PER_LEVEL);
    expect(absoluteElevation(1, 1)).toBe(HEIGHT_PER_LEVEL + 1);
  });
});

describe("drawOrder", () => {
  it("lets east win over a taller western tile on the same row", () => {
    const westTall = drawOrder(5, 10, absoluteElevation(0, 3), 2);
    const eastRoof = drawOrder(6, 10, absoluteElevation(1, 0), 0);
    expect(eastRoof).toBeGreaterThan(westTall);
  });

  it("lets south win over a northern tile on a superior level", () => {
    const south = drawOrder(5, 10, absoluteElevation(0, 3), 2);
    const northRoof = drawOrder(5, 9, absoluteElevation(1, 0), 0);
    expect(south).toBeGreaterThan(northRoof);
  });

  it("orders same-cell stacks by absolute elevation across levels", () => {
    const lower = drawOrder(3, 3, absoluteElevation(0, 1), 0);
    const upper = drawOrder(3, 3, absoluteElevation(1, 0), 0);
    expect(upper).toBeGreaterThan(lower);
  });
});

describe("boxSurfaceElevation", () => {
  it("reads the top face over the middle of a flat tile", () => {
    const flat = depthBox(4, 4, 0, 0);
    const { sx, sy } = footPixel(4, 4);
    expect(boxSurfaceElevation(flat, sx + 4, sy + 4)).toBe(0);
  });

  it("climbs the east face as pixels move west across a tall tile", () => {
    const column = depthBox(4, 4, 0, 4);
    expect(boxSurfaceElevation(column, 40 - PX_PER_HEIGHT, 40 - 2 * PX_PER_HEIGHT)).toBe(1);
    expect(boxSurfaceElevation(column, 40 - 2 * PX_PER_HEIGHT, 40 - 3 * PX_PER_HEIGHT)).toBe(2);
  });

  it("caps at the top face over the footprint", () => {
    const column = depthBox(4, 4, 1, 3);
    const { sx, sy } = footPixel(4, 4);
    expect(
      boxSurfaceElevation(column, sx + 4 - 3 * PX_PER_HEIGHT, sy + 4 - 3 * PX_PER_HEIGHT),
    ).toBe(3);
  });

  it("gives a missed ray the entry plane, not a face of the box", () => {
    const box = depthBox(4, 4, 0, 2);
    const { sx, sy } = footPixel(4, 4);

    const antler = { sx: sx + CELL_SIZE - 0.5, sy: sy - CELL_SIZE + 1.5 };
    expect(boxSurfaceElevation(box, antler.sx, antler.sy)).toBeGreaterThan(1);

    const topFace = { sx: sx - 2 * PX_PER_HEIGHT, sy: sy - 2 * PX_PER_HEIGHT };
    expect(boxSurfaceElevation(box, topFace.sx + 1, topFace.sy - 1)).toBeGreaterThan(2);
  });

  it("stays continuous across the edge of the silhouette", () => {
    const column = depthBox(4, 4, 0, 2);
    const sy = 4 * CELL_SIZE + 4;
    const edge = 5 * CELL_SIZE;
    const before = boxSurfaceElevation(column, edge - 0.5, sy);
    const after = boxSurfaceElevation(column, edge + 0.5, sy);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1 / PX_PER_HEIGHT);
  });
});

describe("fragDepth", () => {
  it("puts a raised south-east tile in front of the ground tile it covers", () => {
    const ground = depthBox(5, 9, 0, 0);
    const roof = depthBox(6, 10, HEIGHT_PER_LEVEL, HEIGHT_PER_LEVEL);
    const sx = 44;
    const sy = 76;
    expectInFront(fragDepth(roof, sx, sy), fragDepth(ground, sx, sy));
  });

  it("puts a tall column's flank in front of the ground tile behind it", () => {
    const ground = depthBox(5, 9, 0, 0);
    const column = depthBox(6, 10, 0, 4);
    const sx = 44;
    const sy = 76;
    expectInFront(fragDepth(column, sx, sy), fragDepth(ground, sx, sy));
  });

  it("separates coplanar surfaces by stack bias alone", () => {
    const floor = depthBox(0, 0, 0, 0);
    const rug = depthBox(0, 0, 0, 0);
    const p = footPixel(0, 0);
    expectInFront(fragDepth(rug, p.sx + 4, p.sy + 4, 1), fragDepth(floor, p.sx + 4, p.sy + 4, 0));
  });

  it("puts a southern coplanar overhang in front of its northern neighbour", () => {
    const north = depthBox(5, 9, 0, 0);
    const south = depthBox(5, 10, 0, 0);
    const sx = 5 * CELL_SIZE + 4;
    const sy = 10 * CELL_SIZE + 2;
    expectInFront(fragDepth(south, sx, sy), fragDepth(north, sx, sy));
  });

  it("puts an eastern coplanar overhang in front of its western neighbour", () => {
    const west = depthBox(5, 10, 0, 0);
    const east = depthBox(6, 10, 0, 0);
    const sx = 6 * CELL_SIZE + 2;
    const sy = 10 * CELL_SIZE + 4;
    expectInFront(fragDepth(east, sx, sy), fragDepth(west, sx, sy));
  });

  it("hands the plane between two cells to the southern sprite", () => {
    const southFlat = depthBox(5, 11, 0, 0);
    const northTall = depthBox(5, 10, 0, HEIGHT_PER_LEVEL);
    const sx = 5 * CELL_SIZE + 4;
    const sy = 10 * CELL_SIZE + 4;
    expectInFront(fragDepth(southFlat, sx, sy), fragDepth(northTall, sx, sy));

    const northRaised = depthBox(5, 10, HEIGHT_PER_LEVEL, HEIGHT_PER_LEVEL * 2);
    expectInFront(fragDepth(northRaised, sx, sy), fragDepth(southFlat, sx, sy));
  });

  describe("art outside the silhouette", () => {
    const CRATE_HEIGHT = HEIGHT_PER_LEVEL / 2;
    const crate = depthBox(0, 0, 0, CRATE_HEIGHT);
    const outline = { sx: -1, sy: -CRATE_HEIGHT * PX_PER_HEIGHT - 1 };

    it("keeps an outline in front of the tall neighbour on its own diagonal", () => {
      const wall = depthBox(1, -1, 0, HEIGHT_PER_LEVEL);
      const sx = outline.sx + CELL_SIZE / 2;
      expectInFront(
        fragDepth(crate, sx, outline.sy, depthStackBias(0, 1)),
        fragDepth(wall, sx, outline.sy, depthStackBias(0, 1)),
      );
    });

    it("keeps an outline in front of the tall neighbour due north", () => {
      const wall = depthBox(0, -1, 0, HEIGHT_PER_LEVEL);
      expectInFront(
        fragDepth(crate, outline.sx, outline.sy, depthStackBias(0, 1)),
        fragDepth(wall, outline.sx, outline.sy, depthStackBias(0, 1)),
      );
    });

    it("keeps a tall sprite's overhang in front of what it hangs over", () => {
      const deer = depthBox(0, 0, 0, HEIGHT_PER_LEVEL);
      const wall = depthBox(1, -1, 0, HEIGHT_PER_LEVEL);
      const antler = { sx: CELL_SIZE - 0.5, sy: -CELL_SIZE + 1.5 };
      expectInFront(
        fragDepth(deer, antler.sx, antler.sy, depthStackBias(0, 1)),
        fragDepth(wall, antler.sx, antler.sy, depthStackBias(0, 1)),
      );
    });

    it("keeps a head hanging over the wall corner it stands beside", () => {
      const deer = depthBox(0, 0, 0, HEIGHT_PER_LEVEL);
      const wall = depthBox(-1, 1, 0, HEIGHT_PER_LEVEL);
      const head = { sx: -CELL_SIZE + 0.5, sy: CELL_SIZE - 2.5 };
      expectInFront(
        fragDepth(deer, head.sx, head.sy, depthStackBias(0, 2)),
        fragDepth(wall, head.sx, head.sy, depthStackBias(0, 1)),
      );
    });

    it("still lets the neighbour in front win over the overhang", () => {
      const deer = depthBox(0, 0, 0, HEIGHT_PER_LEVEL);
      const wall = depthBox(1, 0, 0, HEIGHT_PER_LEVEL);
      const antler = { sx: CELL_SIZE - 0.5, sy: -CELL_SIZE + 1.5 };
      expectInFront(
        fragDepth(wall, antler.sx, antler.sy, depthStackBias(0, 1)),
        fragDepth(deer, antler.sx, antler.sy, depthStackBias(0, 1)),
      );
    });

    describe("art hanging into the cell in front", () => {
      const rat = depthBox(0, 0, 0, 1);
      const tailCell = { x: 0, y: 1 };

      function tailPixels() {
        const { sx, sy } = footPixel(tailCell.x, tailCell.y);
        return Array.from({ length: CELL_SIZE * CELL_SIZE }, (_, i) => ({
          sx: sx + (i % CELL_SIZE),
          sy: sy + Math.floor(i / CELL_SIZE),
        }));
      }

      function pixelsWhereRatWins(neighbour: ReturnType<typeof depthBox>) {
        return tailPixels().filter(
          ({ sx, sy }) =>
            fragDepth(rat, sx, sy, depthStackBias(0, 1)) <
            fragDepth(neighbour, sx, sy, depthStackBias(0, 0)),
        ).length;
      }

      it("keeps the whole tail in front of the flat floor it hangs over", () => {
        const floor = depthBox(tailCell.x, tailCell.y, 0, 0);
        expect(pixelsWhereRatWins(floor)).toBe(CELL_SIZE * CELL_SIZE);
      });

      it("still hides the tail behind a wall in that cell", () => {
        const wall = depthBox(tailCell.x, tailCell.y, 0, HEIGHT_PER_LEVEL);
        expect(pixelsWhereRatWins(wall)).toBe(0);
      });

      it("still hides the tail behind a low prop in that cell", () => {
        const grass = depthBox(tailCell.x, tailCell.y, 0, 1);
        expect(pixelsWhereRatWins(grass)).toBe(0);
      });

      it("leaves the floor two cells in front in front of the tail", () => {
        const beyond = depthBox(tailCell.x, tailCell.y + 1, 0, 0);
        expect(pixelsWhereRatWins(beyond)).toBe(0);
      });

      describe("a heap, which is flat art that is not floor", () => {
        const heap = depthBox(0, 0, 0, DEPTH_LEAST_BODY);

        function pixelsWhereHeapWins(neighbour: ReturnType<typeof depthBox>) {
          return tailPixels().filter(
            ({ sx, sy }) =>
              fragDepth(heap, sx, sy, depthStackBias(0, 1)) <
              fragDepth(neighbour, sx, sy, depthStackBias(0, 0)),
          ).length;
        }

        it("keeps its southern sprites in front of the floor in front", () => {
          const floor = depthBox(tailCell.x, tailCell.y, 0, 0);
          expect(pixelsWhereHeapWins(floor)).toBe(CELL_SIZE * CELL_SIZE);
        });

        it("is still hidden by anything standing in that cell", () => {
          const grass = depthBox(tailCell.x, tailCell.y, 0, 1);
          const wall = depthBox(tailCell.x, tailCell.y, 0, HEIGHT_PER_LEVEL);
          expect(pixelsWhereHeapWins(grass)).toBe(0);
          expect(pixelsWhereHeapWins(wall)).toBe(0);
        });

        it("is still behind the floor two cells in front", () => {
          const beyond = depthBox(tailCell.x, tailCell.y + 1, 0, 0);
          expect(pixelsWhereHeapWins(beyond)).toBe(0);
        });

        it("survives the crossing to a float32 attribute", () => {
          for (const foot of [0, 16, -16, 48, -48]) {
            expect(Math.fround(foot + DEPTH_LEAST_BODY)).toBeGreaterThan(Math.fround(foot));
          }
        });

        it("does not climb over what is stacked above it in its own cell", () => {
          const decal = depthBox(0, 0, 0, 0);
          const p = footPixel(0, 0);
          for (let i = 0; i < CELL_SIZE * CELL_SIZE; i++) {
            const sx = p.sx + (i % CELL_SIZE);
            const sy = p.sy + Math.floor(i / CELL_SIZE);
            expectInFront(
              fragDepth(decal, sx, sy, depthStackBias(0, 2)),
              fragDepth(heap, sx, sy, depthStackBias(0, 1)),
            );
          }
        });
      });

      it("rescues a body's near side there, but not a flat sprite's", () => {
        const underFoot = { sx: 6, sy: CELL_SIZE + 2 };
        const body = depthBox(0, 0, 0, 1);
        const decal = depthBox(0, 0, 0, 0);
        expect(boxSurface(body, underFoot.sx, underFoot.sy).overhang).toBe(true);
        expect(boxSurface(decal, underFoot.sx, underFoot.sy).overhang).toBe(false);
      });
    });
  });

  it("gives every fragment inside one art pixel the same depth", () => {
    const column = depthBox(6, 10, 0, 4);
    const base = fragDepth(column, 44, 76);
    for (const dx of [0, 0.25, 0.5, 0.75, 0.99]) {
      for (const dy of [0, 0.25, 0.5, 0.75, 0.99]) {
        expect(fragDepth(column, 44 + dx, 76 + dy)).toBe(base);
      }
    }
    expect(fragDepth(column, 45, 76)).not.toBe(base);
  });

  it("lets an upper-level height-0 tile beat a full lower stack top", () => {
    const lowerTop = depthBox(2, 1, absoluteElevation(-1, 1), absoluteElevation(-1, 2));
    const grass = depthBox(2, 1, absoluteElevation(0, 0), absoluteElevation(0, 0));
    const p = footPixel(2, 1);
    expectInFront(
      fragDepth(grass, p.sx + 4, p.sy + 4, depthStackBias(0, 0)),
      fragDepth(lowerTop, p.sx + 4, p.sy + 4, depthStackBias(-1, 2)),
    );
  });

  it("stays inside the normalised depth range for extreme placements", () => {
    const far = depthBox(200, 200, absoluteElevation(8, 4), absoluteElevation(8, 6));
    const d = fragDepth(far, 200 * CELL_SIZE, 200 * CELL_SIZE, 16);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });

  it("keeps a mid-walk mover behind the east stack and above the destination floor", () => {
    const col = 5;
    const row = 10;
    const eastStack = depthBox(col + 1, row, 0, 4);
    const destFloor = depthBox(col, row + 1, 0, 0);
    const mover = depthBox(col, row + 0.5, 0, 2);
    const moverBias = 1;

    const againstStack = {
      sx: (col + 1) * CELL_SIZE + 1,
      sy: row * CELL_SIZE + 4,
    };
    expectInFront(
      fragDepth(eastStack, againstStack.sx, againstStack.sy),
      fragDepth(mover, againstStack.sx, againstStack.sy, moverBias),
    );

    const overFloor = {
      sx: col * CELL_SIZE + 4,
      sy: (row + 1) * CELL_SIZE + 2,
    };
    expectInFront(
      fragDepth(mover, overFloor.sx, overFloor.sy, moverBias),
      fragDepth(destFloor, overFloor.sx, overFloor.sy),
    );
  });
});
