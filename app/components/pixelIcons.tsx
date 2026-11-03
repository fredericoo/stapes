import type { ComponentType } from "react";

export type PixelIconProps = {
  size?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
};

export type PixelIcon = ComponentType<PixelIconProps>;

const GRID = 12;

/**
 * A cell is `size / 12` CSS pixels. Rounding to a multiple of 6 keeps every
 * cell a whole device pixel at 2x, the same trade the interface font makes.
 */
const ICON_SIZE_STEP_PX = 6;

const DEFAULT_ICON_SIZE_PX = 24;

const OUTLINE = "#0d0a10";

const CURRENT = "*";

const PALETTE: Record<string, string> = {
  k: OUTLINE,
  w: "#f4f0e6",
  l: "#b3abc4",
  g: "#7a728d",
  d: "#48425a",
  r: "#d83a3a",
  R: "#8a1f2a",
  p: "#ff9a8a",
  y: "#ffd23f",
  o: "#d4a03c",
  O: "#7a5418",
  t: "#d39a5c",
  b: "#9a6434",
  B: "#5a3519",
  E: "#2d6a4f",
  u: "#3f8fe0",
  U: "#1f4f8a",
  c: "#9ad8ff",
  v: "#b15cff",
  V: "#6a2aa0",
  s: "#f0b78a",
  S: "#b97a50",
  f: "#ff8a1f",
  P: "#ead9ad",
  Q: "#b8955a",
  [CURRENT]: "currentColor",
};

function snappedSize(size: number): number {
  return Math.max(ICON_SIZE_STEP_PX, Math.round(size / ICON_SIZE_STEP_PX) * ICON_SIZE_STEP_PX);
}

/**
 * Every empty cell touching a painted one, corners included, is filled with
 * the outline colour: the same one-brick 3×3 outline the world's labels wear,
 * so an icon reads against the world, a window or a sprite alike.
 */
function spritePaths(rows: readonly string[]): Array<{ fill: string; d: string }> {
  const top = Math.floor((GRID - rows.length) / 2);
  const grid: string[][] = Array.from({ length: GRID }, () => Array<string>(GRID).fill("."));
  for (const [y, row] of rows.entries()) {
    for (const [x, cell] of [...row].entries()) {
      if (x < GRID) grid[top + y]![x] = cell;
    }
  }
  const painted = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < GRID && y < GRID && grid[y]![x] !== ".";
  const cells = new Map<string, string[]>();
  const add = (key: string, x: number, y: number) => {
    const list = cells.get(key) ?? [];
    list.push(`M${x} ${y}h1v1h-1z`);
    cells.set(key, list);
  };
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const cell = grid[y]![x]!;
      if (cell !== ".") {
        add(cell, x, y);
        continue;
      }
      let touches = false;
      for (let dy = -1; dy <= 1 && !touches; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (painted(x + dx, y + dy)) {
            touches = true;
            break;
          }
        }
      }
      if (touches) add("k", x, y);
    }
  }
  return [...cells].map(([key, d]) => ({ fill: PALETTE[key] ?? OUTLINE, d: d.join("") }));
}

function sprite(rows: readonly string[]): PixelIcon {
  const paths = spritePaths(rows);
  return function Icon({ size = DEFAULT_ICON_SIZE_PX, className, ...rest }: PixelIconProps) {
    const px = snappedSize(size);
    return (
      <svg
        viewBox={`0 0 ${GRID} ${GRID}`}
        width={px}
        height={px}
        shapeRendering="crispEdges"
        className={className}
        xmlns="http://www.w3.org/2000/svg"
        {...rest}
      >
        {paths.map(({ fill, d }) => (
          <path key={fill} fill={fill} d={d} />
        ))}
      </svg>
    );
  };
}

export const IconApple = sprite([
  "......B.....",
  ".....bEE....",
  "..rprrrrrR..",
  ".rpprrrrrrR.",
  ".rprrrrrrrR.",
  ".rrrrrrrrrR.",
  ".rrrrrrrrRR.",
  "..rrrrrrRR..",
  "...rrRRR....",
]);

export const IconBackpack = sprite([
  "....BBBB....",
  "...B....B...",
  "..tbbbbbbB..",
  ".tbbbbbbbbB.",
  ".tbtttttbbB.",
  ".tbbboobbbB.",
  ".tbbbbbbbbB.",
  ".tbbbbbbbbB.",
  ".tbbbbbbbbB.",
  "..BBBBBBBB..",
]);

export const IconBox = sprite([
  "..tttttttB..",
  ".tbbbbbbbbB.",
  ".tbbbbbbbbB.",
  ".oooooooooO.",
  ".tbbbyybbbB.",
  ".tbbbOObbbB.",
  ".tbbbbbbbbB.",
  ".tbbbbbbbbB.",
  ".BBBBBBBBBB.",
]);

export const IconBoot = sprite([
  "..oooO......",
  "..tbbB......",
  "..tbbB......",
  "..tbbB......",
  "..tbbbbB....",
  "..tbbbbbbB..",
  "..tbbbbbbbB.",
  ".BBBBBBBBBB.",
]);

const BULB = [
  "....yyyy....",
  "...ywwyyy...",
  "..ywyyyyyo..",
  "..yyyyyyyo..",
  "..yyyyyyyo..",
  "...yyyyyo...",
  "....yyoo....",
  "....llll....",
  "....gggg....",
  ".....dd.....",
];

export const IconBulb = sprite(BULB);

export const IconBulbOff = sprite(
  BULB.map((row) => row.replace(/y/g, "g").replace(/w/g, "l").replace(/o/g, "d")),
);

export const IconChangelog = sprite([
  "..PPPPPPPQ..",
  "..PggggPPQ..",
  "..PPPPPPPQ..",
  "..PgggggPQ..",
  "..PPPPPPPQ..",
  "..PggggPPQ..",
  "..PPPPPPPQ..",
  "..PgggPPPQ..",
  "..PPPPPPPQ..",
  "..QQQQQQQQ..",
]);

export const IconChat = sprite([
  ".wwwwwwwwwl.",
  ".wdddddwwwl.",
  ".wwwwwwwwwl.",
  ".wdddwwwwwl.",
  ".wwwwwwwwwl.",
  ".llwwllllll.",
  "...wl.......",
  "...l........",
]);

export const IconClose = sprite([
  ".**......**.",
  ".***....***.",
  "..***..***..",
  "...******...",
  "....****....",
  "....****....",
  "...******...",
  "..***..***..",
  ".***....***.",
  ".**......**.",
]);

export const IconDiamond = sprite([
  "...cwcccu...",
  "..cwccccuU..",
  ".ccccccuuuU.",
  "..cccuuuUU..",
  "...ccuuUU...",
  "....cuUU....",
  ".....UU.....",
]);

export const IconDoor = sprite([
  "....tbbB....",
  "...tbbbbB...",
  "..tbBbbBbB..",
  "..tbBbbBbB..",
  "..tbBbbByB..",
  "..tbBbbBbB..",
  "..tbBbbBbB..",
  "..tbBbbBbB..",
  "..tbBbbBbB..",
  ".dddddddddd.",
]);

export const IconDroplet = sprite([
  ".....cu.....",
  "....cuuU....",
  "....cuuU....",
  "...cuuuuU...",
  "..cwuuuuuU..",
  "..cwuuuuuU..",
  "..cuuuuuuU..",
  "..uuuuuuUU..",
  "...uuuuUU...",
  "....UUUU....",
]);

export const IconExit = sprite([
  ".gggggg.....",
  ".gBBBBg.r...",
  ".gBBBBg.rr..",
  ".gBrrrrrrrr.",
  ".gBrrrrrrrr.",
  ".gBBBBg.rr..",
  ".gBBBBg.r...",
  ".gBBBBg.....",
  ".gggggg.....",
]);

export const IconEye = sprite([
  "...llllll...",
  "..lwwwwwwl..",
  ".lwwwuuwwwl.",
  ".lwwuUUuwwl.",
  ".lwwwuuwwwl.",
  "..lwwwwwwl..",
  "...llllll...",
]);

export const IconEyeOff = sprite([
  ".........r..",
  "...lllllr...",
  "..lggggrgl..",
  ".lgggdrgggl.",
  ".lggdrddggl.",
  ".lggrddgggl.",
  "..lrgggggl..",
  "..rllllll...",
]);

export const IconFeedback = sprite([
  ".wwwwwwwwwl.",
  ".wwwwrwwwwl.",
  ".wwwwrwwwwl.",
  ".wwwwwwwwwl.",
  ".wwwwrwwwwl.",
  ".llwwllllll.",
  "...wl.......",
  "...l........",
]);

export const IconFire = sprite([
  "......f.....",
  ".....ff.....",
  "....fff..f..",
  "...fffff.ff.",
  "..fffyyfffR.",
  ".rffyyyyffR.",
  ".rfyywwyyfR.",
  ".rfyywwyyfR.",
  "..rffyyffR..",
  "...RRRRRR...",
]);

export const IconFace = sprite([
  "...BBBBBB...",
  "..BBBBBBBB..",
  "..BssssssB..",
  "..ssdssdsS..",
  "..sssssssS..",
  "..ssRRRRsS..",
  "...ssssSS...",
  "....SSSS....",
]);

export const IconGift = sprite([
  "...yy..yy...",
  "....yyyy....",
  ".vvvvyyvvvV.",
  ".VVVVyyVVVV.",
  "..vvvyyvvV..",
  "..vvvyyvvV..",
  "..vvvyyvvV..",
  "..vvvyyvvV..",
  "..VVVyyVVV..",
]);

export const IconHand = sprite([
  "...s.s.s....",
  "...s.s.s.s..",
  "...s.s.s.s..",
  "...sssssss..",
  ".s.ssssssS..",
  ".ssssssssS..",
  "..sssssssS..",
  "...ssssSS...",
  "....ssSS....",
]);

export const IconHeart = sprite([
  "..rrr..rrr..",
  ".rpprrrrrrr.",
  ".rprrrrrrrr.",
  ".rrrrrrrrrR.",
  ".rrrrrrrrrR.",
  "..rrrrrrRR..",
  "...rrrrRR...",
  "....rrRR....",
  ".....RR.....",
]);

export const IconHuman = sprite([
  ".....ss.....",
  "....ssss....",
  ".....SS.....",
  "..uuuuuuuu..",
  "..u.uuuu.u..",
  "..s.uuuu.s..",
  "....BBBB....",
  "....B..B....",
  "....B..B....",
  "...BB..BB...",
]);

export const IconMapPin = sprite([
  "....rrrr....",
  "...rpprrR...",
  "..rprwwrrR..",
  "..rrrwwrrR..",
  "..rrrrrrrR..",
  "...rrrrrR...",
  "....rrrR....",
  ".....rR.....",
  ".....R......",
]);

export const IconMenu = sprite([
  ".**********.",
  ".**********.",
  "............",
  ".**********.",
  ".**********.",
  "............",
  ".**********.",
  ".**********.",
]);

export const IconMinus = sprite([".**********.", ".**********."]);

export const IconMove = sprite([
  ".....ww.....",
  "....wwww....",
  ".....ww.....",
  "..w..ww..w..",
  ".wwwwwwwwww.",
  ".wwwwwwwwww.",
  "..w..ww..w..",
  ".....ww.....",
  "....wwww....",
  ".....ww.....",
]);

export const IconPickaxe = sprite([
  "..llllllll..",
  ".ld..tb..dl.",
  ".d...tb...d.",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....BB.....",
]);

export const IconPlus = sprite([
  ".....**.....",
  ".....**.....",
  ".....**.....",
  ".....**.....",
  ".**********.",
  ".**********.",
  ".....**.....",
  ".....**.....",
  ".....**.....",
  ".....**.....",
]);

export const IconSave = sprite([
  ".uulllllluU.",
  ".uullldlluU.",
  ".uulllllluU.",
  ".uuuuuuuuuU.",
  ".uwwwwwwwuU.",
  ".uwddddwwuU.",
  ".uwwwwwwwuU.",
  ".uwddwwwwuU.",
  ".uwwwwwwwuU.",
  ".UUUUUUUUUU.",
]);

export const IconSearch = sprite([
  "..ooooo.....",
  ".owcccco....",
  ".occcccO....",
  ".occcccO....",
  ".occcccO....",
  "..OOOOOb....",
  ".......bb...",
  "........bb..",
  ".........bb.",
  "..........B.",
]);

export const IconSettings = sprite([
  "...ww..ll...",
  "....wwll....",
  ".w.wwllll.g.",
  ".wwwlllllgg.",
  "..wll..lgg..",
  "..lll..ggd..",
  ".lllllggddd.",
  ".l.llggdd.d.",
  "....ggdd....",
  "...gg..dd...",
]);

export const IconShirt = sprite([
  "...cu..uc...",
  "..cuuuuuuU..",
  ".cuuuuuuuuU.",
  ".uuuuuuuuuU.",
  "...uuuuuuU..",
  "...uuuuuuU..",
  "...uuuuuuU..",
  "...uuuuuuU..",
  "...uuuuuuU..",
  "...UUUUUUU..",
]);

export const IconSkull = sprite([
  "...wwwwww...",
  "..wwwwwwwwl.",
  ".wwwwwwwwwl.",
  ".wkkwwwkkwl.",
  ".wkkwwwkkwl.",
  ".wwwwkwwwwl.",
  "..wwwwwwwl..",
  "...wkwkwl...",
  "...lllll....",
]);

export const IconStar = sprite([
  ".....yy.....",
  ".....yy.....",
  "....ywyy....",
  ".yyyywyyyyo.",
  "..yyyyyyyo..",
  "...yyyyyo...",
  "...yyyyyo...",
  "..yyyo.yyo..",
  "..yo....yo..",
]);

export const IconSwitch = sprite([
  ".......rr...",
  ".......rR...",
  "......bb....",
  ".....bb.....",
  "....bb......",
  "..llllllll..",
  "..lggggggd..",
  "..dddddddd..",
]);

export const IconSword = sprite([
  ".........wl.",
  "........wl..",
  ".......wl...",
  "......wl....",
  ".o...wl.....",
  "..o.wl......",
  "...ol.......",
  "..boO.......",
  ".B...O......",
]);

export const IconTalk = sprite([
  ".PPPPPPPPPQ.",
  ".PPPPPPPPPQ.",
  ".PPdPdPdPPQ.",
  ".PPPPPPPPPQ.",
  ".QQQQQPPQQQ.",
  "......PQ....",
  ".....PQ.....",
]);

export const IconTarget = sprite([
  "...rrrrrr...",
  "..rwwwwwwr..",
  ".rwwrrrrwwr.",
  ".rwrwwwwrwr.",
  ".rwrwrrwrwr.",
  ".rwrwrrwrwr.",
  ".rwrwwwwrwr.",
  ".rwwrrrrwwr.",
  "..rwwwwwwr..",
  "...rrrrrr...",
]);

export const IconTools = sprite([
  "..lllllld...",
  "..lwwwwldd..",
  "..dddddddd..",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....tb.....",
  ".....BB.....",
]);
