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

/** Window depth is smaller = nearer, so "in front" means a lower value. */
function expectInFront(near: number, far: number) {
  expect(near).toBeLessThan(far);
}

/** Screen pixel where a cell's own foot corner lands (no elevation shift). */
function footPixel(cellX: number, cellY: number) {
  return { sx: cellX * CELL_SIZE, sy: cellY * CELL_SIZE };
}

/**
 * The bug `../render/depthClump` exists for, in the two numbers that caused it.
 *
 * Anything standing in an open door shares its cell — the door is intangible,
 * so it takes up no elevation — and the door is a full level tall. At a pixel
 * in the band above the co-tenant's own height the door has a real surface and
 * the co-tenant has only art hanging outside its box, so the door was drawn
 * across the face of whoever stood in it and the top of any barrel left in it.
 * Merging the two into one extent is what leaves stack order to settle it.
 */
describe("something standing in a doorway", () => {
  const DOORWAY = { x: 0, y: 0 };
  const door = depthBox(DOORWAY.x, DOORWAY.y, 0, HEIGHT_PER_LEVEL);
  // A pixel in the band the door alone reaches: above a three-high co-tenant,
  // below the door's top.
  const HEAD_ELEV = HEIGHT_PER_LEVEL - 0.5;
  const head = {
    sx: DOORWAY.x * CELL_SIZE - HEAD_ELEV * PX_PER_HEIGHT,
    sy: DOORWAY.y * CELL_SIZE - HEAD_ELEV * PX_PER_HEIGHT,
  };
  // Whatever it is was appended onto the stack the door is already in, so it
  // outranks the door on any tie.
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
    // Each height unit shifts a face PX_PER_HEIGHT px up-left, so pixels
    // sampled up-left along the face read progressively higher. Staying north
    // keeps the south face from being the nearer one.
    expect(
      boxSurfaceElevation(column, 40 - PX_PER_HEIGHT, 40 - 2 * PX_PER_HEIGHT),
    ).toBe(1);
    expect(
      boxSurfaceElevation(
        column,
        40 - 2 * PX_PER_HEIGHT,
        40 - 3 * PX_PER_HEIGHT,
      ),
    ).toBe(2);
  });

  it("caps at the top face over the footprint", () => {
    const column = depthBox(4, 4, 1, 3);
    const { sx, sy } = footPixel(4, 4);
    // Up-left by the top face's own shift: still over the box, reading its top.
    expect(
      boxSurfaceElevation(
        column,
        sx + 4 - 3 * PX_PER_HEIGHT,
        sy + 4 - 3 * PX_PER_HEIGHT,
      ),
    ).toBe(3);
  });

  it("gives a missed ray the entry plane, not a face of the box", () => {
    const box = depthBox(4, 4, 0, 2);
    const { sx, sy } = footPixel(4, 4);

    // A deer's antlers: art up and east of the footprint, so the ray passes the
    // box on the outside. Reading the east face there would put them a hair off
    // the floor and let anything nearby cut through them.
    const antler = { sx: sx + CELL_SIZE - 0.5, sy: sy - CELL_SIZE + 1.5 };
    expect(boxSurfaceElevation(box, antler.sx, antler.sy)).toBeGreaterThan(1);

    // A crate's outline: one pixel up-left of the top face, i.e. just past the
    // silhouette. Pinning it to the top face is what let a neighbour whose real
    // surface reaches slightly higher there eat the outline.
    const topFace = { sx: sx - 2 * PX_PER_HEIGHT, sy: sy - 2 * PX_PER_HEIGHT };
    expect(
      boxSurfaceElevation(box, topFace.sx + 1, topFace.sy - 1),
    ).toBeGreaterThan(2);
  });

  it("stays continuous across the edge of the silhouette", () => {
    const column = depthBox(4, 4, 0, 2);
    // Walk east across the pixel where the east face ends and the miss begins.
    const sy = 4 * CELL_SIZE + 4;
    const edge = 5 * CELL_SIZE;
    const before = boxSurfaceElevation(column, edge - 0.5, sy);
    const after = boxSurfaceElevation(column, edge + 0.5, sy);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1 / PX_PER_HEIGHT);
  });
});

describe("fragDepth", () => {
  /**
   * Cells one step down-right and HEIGHT_PER_LEVEL height units up project to
   * the very same pixels, so this is where sprites actually overlap and depth
   * has to decide.
   */
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
    // Two flat tiles stacked in one cell — identical geometry, so only the
    // bias can order them.
    const floor = depthBox(0, 0, 0, 0);
    const rug = depthBox(0, 0, 0, 0);
    const p = footPixel(0, 0);
    expectInFront(
      fragDepth(rug, p.sx + 4, p.sy + 4, 1),
      fragDepth(floor, p.sx + 4, p.sy + 4, 0),
    );
  });

  it("puts a southern coplanar overhang in front of its northern neighbour", () => {
    // Height-0 multi-cell sprites share elev at overlap pixels; without a
    // plane bias, depth is a coin flip (merge order looks random).
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
    // A southern sprite's overhanging art enters its own box on exactly the
    // plane the northern tile's south face occupies, so the two read the same
    // elevation at every shared pixel and nothing in the geometry can separate
    // them. The plane bias does, south first — which is what keeps a crate's
    // top outline drawn over the wall standing behind it.
    const southFlat = depthBox(5, 11, 0, 0);
    const northTall = depthBox(5, 10, 0, HEIGHT_PER_LEVEL);
    const sx = 5 * CELL_SIZE + 4;
    const sy = 10 * CELL_SIZE + 4;
    expectInFront(fragDepth(southFlat, sx, sy), fragDepth(northTall, sx, sy));

    // Real elevation still dominates: lift the northern tile a whole level and
    // it beats the overhang and the bias together.
    const northRaised = depthBox(5, 10, HEIGHT_PER_LEVEL, HEIGHT_PER_LEVEL * 2);
    expectInFront(fragDepth(northRaised, sx, sy), fragDepth(southFlat, sx, sy));
  });

  /**
   * Art overhangs its box: sprites are authored in a 2x2-cell slot, while the
   * box is one cell of footprint by the tile's declared height. The overhang is
   * where the tile's outline lives, so losing it is immediately visible.
   */
  describe("art outside the silhouette", () => {
    // A crate: half a level, so its silhouette is CELL_SIZE + half a level's
    // worth of pixels square, and the top row of its outline sits one pixel
    // above that.
    const CRATE_HEIGHT = HEIGHT_PER_LEVEL / 2;
    const crate = depthBox(0, 0, 0, CRATE_HEIGHT);
    const outline = { sx: -1, sy: -CRATE_HEIGHT * PX_PER_HEIGHT - 1 };

    it("keeps an outline in front of the tall neighbour on its own diagonal", () => {
      // (x+1, y-1) shares the crate's depth diagonal, and its south face climbs
      // right through the crate's top edge on screen. Sampled where that face
      // actually is — half a cell east, where the wall art starts.
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
      // The deer's antlers: drawn up and east of its footprint, over the cell
      // north-east of it. Reading a face of the deer's own box there sorted
      // them onto the floor, and the neighbour sliced straight through.
      const deer = depthBox(0, 0, 0, HEIGHT_PER_LEVEL);
      const wall = depthBox(1, -1, 0, HEIGHT_PER_LEVEL);
      const antler = { sx: CELL_SIZE - 0.5, sy: -CELL_SIZE + 1.5 };
      expectInFront(
        fragDepth(deer, antler.sx, antler.sy, depthStackBias(0, 1)),
        fragDepth(wall, antler.sx, antler.sy, depthStackBias(0, 1)),
      );
    });

    it("keeps a head hanging over the wall corner it stands beside", () => {
      // The deer's own frame draws its head down-left, over the cell to its
      // south-west. That cell's wall is on the same depth diagonal, so its face
      // and the head's entry plane are the same plane and tie at every shared
      // pixel — and the plane bias hands ties to the more southern cell, which
      // is the wall. The overhang bias is what keeps the head.
      const deer = depthBox(0, 0, 0, HEIGHT_PER_LEVEL);
      const wall = depthBox(-1, 1, 0, HEIGHT_PER_LEVEL);
      const head = { sx: -CELL_SIZE + 0.5, sy: CELL_SIZE - 2.5 };
      expectInFront(
        fragDepth(deer, head.sx, head.sy, depthStackBias(0, 2)),
        fragDepth(wall, head.sx, head.sy, depthStackBias(0, 1)),
      );
    });

    it("still lets the neighbour in front win over the overhang", () => {
      // Same overhang, but now the wall is due east — genuinely one step nearer
      // the camera — so it must occlude the antlers.
      const deer = depthBox(0, 0, 0, HEIGHT_PER_LEVEL);
      const wall = depthBox(1, 0, 0, HEIGHT_PER_LEVEL);
      const antler = { sx: CELL_SIZE - 0.5, sy: -CELL_SIZE + 1.5 };
      expectInFront(
        fragDepth(wall, antler.sx, antler.sy, depthStackBias(0, 1)),
        fragDepth(deer, antler.sx, antler.sy, depthStackBias(0, 1)),
      );
    });

    /**
     * The mirror image: art hanging *down-right*, over the cells in front. A
     * rat is drawn with its body either side of the cell it stands in, so a
     * cell of tail falls past the box's foot.
     *
     * These assert over the whole overhanging cell rather than one pixel,
     * because the failure was never all-or-nothing: the foot plane and the
     * floor's top face tie everywhere, and the plane bias decided the tie one
     * way above the cell's diagonal and the other way below it, biting the tail
     * in half along a 45° line.
     */
    describe("art hanging into the cell in front", () => {
      const rat = depthBox(0, 0, 0, 1);
      const tailCell = { x: 0, y: 1 };

      /** Every pixel of the cell the tail hangs into. */
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
        // Grass is only half a level tall — the smallest thing that stands
        // above the foot plane, and it must still win everywhere.
        const grass = depthBox(tailCell.x, tailCell.y, 0, 1);
        expect(pixelsWhereRatWins(grass)).toBe(0);
      });

      it("leaves the floor two cells in front in front of the tail", () => {
        const beyond = depthBox(tailCell.x, tailCell.y + 1, 0, 0);
        expect(pixelsWhereRatWins(beyond)).toBe(0);
      });

      /**
       * A heap of berries is the one flat thing that hangs over the cell in
       * front, because its sprites are spread across their own cell rather than
       * drawn dead centre — see `../render/pileLayout`. It is an object lying on
       * the ground and not more ground, so it says so with
       * {@link DEPTH_LEAST_BODY}, and these are the two halves of that being
       * safe: it wins the tie it should, and it moves nothing it should not.
       */
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

        /**
         * The box crosses to the GPU as a `Float32Array`, and the predicate on
         * the far side is `top > foot`. A body too small to survive that
         * rounding at the elevations a map actually reaches would be a fix that
         * worked in this file and nowhere else.
         */
        it("survives the crossing to a float32 attribute", () => {
          for (const foot of [0, 16, -16, 48, -48]) {
            expect(Math.fround(foot + DEPTH_LEAST_BODY)).toBeGreaterThan(
              Math.fround(foot),
            );
          }
        });

        /**
         * The whole reason the body is a hair rather than a height. A lift that
         * reached one stack index would put a heap over the blood splashed on
         * top of it, which is a thing the stack already has an answer for.
         */
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
        // Sampled in the down-right half of the cell, where the ray misses
        // under the foot; the up-left half misses past the far faces instead
        // and is rescued for any box, flat or not.
        const underFoot = { sx: 6, sy: CELL_SIZE + 2 };
        const body = depthBox(0, 0, 0, 1);
        const decal = depthBox(0, 0, 0, 0);
        expect(boxSurface(body, underFoot.sx, underFoot.sy).overhang).toBe(
          true,
        );
        expect(boxSurface(decal, underFoot.sx, underFoot.sy).overhang).toBe(
          false,
        );
      });
    });
  });

  /**
   * Depth must be uniform across an art pixel. A fragment is finer than a texel
   * once zoomed, so if depth varied within one, a crossing between two sprites
   * would cut the texel in half and draw a smooth diagonal seam through the
   * pixel art.
   */
  it("gives every fragment inside one art pixel the same depth", () => {
    const column = depthBox(6, 10, 0, 4);
    const base = fragDepth(column, 44, 76);
    for (const dx of [0, 0.25, 0.5, 0.75, 0.99]) {
      for (const dy of [0, 0.25, 0.5, 0.75, 0.99]) {
        expect(fragDepth(column, 44 + dx, 76 + dy)).toBe(base);
      }
    }
    // Neighbouring texels still differ, so ordering is not flattened.
    expect(fragDepth(column, 45, 76)).not.toBe(base);
  });

  it("lets an upper-level height-0 tile beat a full lower stack top", () => {
    // Exactly-full level -1 top and level-0 grass share abs elev 0.
    const lowerTop = depthBox(
      2,
      1,
      absoluteElevation(-1, 1),
      absoluteElevation(-1, 2),
    );
    const grass = depthBox(
      2,
      1,
      absoluteElevation(0, 0),
      absoluteElevation(0, 0),
    );
    const p = footPixel(2, 1);
    expectInFront(
      fragDepth(grass, p.sx + 4, p.sy + 4, depthStackBias(0, 0)),
      fragDepth(lowerTop, p.sx + 4, p.sy + 4, depthStackBias(-1, 2)),
    );
  });

  it("stays inside the normalised depth range for extreme placements", () => {
    const far = depthBox(
      200,
      200,
      absoluteElevation(8, 4),
      absoluteElevation(8, 6),
    );
    const d = fragDepth(far, 200 * CELL_SIZE, 200 * CELL_SIZE, 16);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });

  /**
   * The case that motivated per-pixel depth. Mid-step the mover has to be
   * behind the tall stack beside it AND in front of the floor it is stepping
   * onto — two orderings no single depth value per sprite can hold at once.
   */
  it("keeps a mid-walk mover behind the east stack and above the destination floor", () => {
    const col = 5;
    const row = 10;
    const eastStack = depthBox(col + 1, row, 0, 4);
    const destFloor = depthBox(col, row + 1, 0, 0);
    const mover = depthBox(col, row + 0.5, 0, 2);
    const moverBias = 1;

    // A pixel on the east stack's west flank, level with the mover's row.
    const againstStack = {
      sx: (col + 1) * CELL_SIZE + 1,
      sy: row * CELL_SIZE + 4,
    };
    expectInFront(
      fragDepth(eastStack, againstStack.sx, againstStack.sy),
      fragDepth(mover, againstStack.sx, againstStack.sy, moverBias),
    );

    // A pixel over the destination floor, where the mover's feet are landing.
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
