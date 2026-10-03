import type { ComponentType, SVGProps } from "react";
import { Apple } from "pixelarticons/react/Apple.js";
import { Backpack } from "pixelarticons/react/Backpack.js";
import { Box } from "pixelarticons/react/Box.js";
import { Close } from "pixelarticons/react/Close.js";
import { Comment } from "pixelarticons/react/Comment.js";
import { DiamondGem } from "pixelarticons/react/DiamondGem.js";
import { DoorClosed } from "pixelarticons/react/DoorClosed.js";
import { Eye } from "pixelarticons/react/Eye.js";
import { EyeOff } from "pixelarticons/react/EyeOff.js";
import { Fire } from "pixelarticons/react/Fire.js";
import { Gift } from "pixelarticons/react/Gift.js";
import { Hand } from "pixelarticons/react/Hand.js";
import { Heart } from "pixelarticons/react/Heart.js";
import { Human } from "pixelarticons/react/Human.js";
import { Lightbulb } from "pixelarticons/react/Lightbulb.js";
import { LightbulbOff } from "pixelarticons/react/LightbulbOff.js";
import { Logout } from "pixelarticons/react/Logout.js";
import { MapPin } from "pixelarticons/react/MapPin.js";
import { Menu } from "pixelarticons/react/Menu.js";
import { Message } from "pixelarticons/react/Message.js";
import { MessageText } from "pixelarticons/react/MessageText.js";
import { Minus } from "pixelarticons/react/Minus.js";
import { Move } from "pixelarticons/react/Move.js";
import { Plus } from "pixelarticons/react/Plus.js";
import { Save } from "pixelarticons/react/Save.js";
import { SettingsCog } from "pixelarticons/react/SettingsCog.js";
import { Shirt } from "pixelarticons/react/Shirt.js";
import { Skull } from "pixelarticons/react/Skull.js";
import { Smile } from "pixelarticons/react/Smile.js";
import { Switch } from "pixelarticons/react/Switch.js";
import { Sword } from "pixelarticons/react/Sword.js";
import { Target } from "pixelarticons/react/Target.js";
import { Tools } from "pixelarticons/react/Tools.js";

export type PixelIconProps = {
  size?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
};

export type PixelIcon = ComponentType<PixelIconProps>;

/**
 * pixelarticons draw on a 24-unit box in 2-unit cells, so a cell is
 * `size / 12` CSS pixels. Rounding to a multiple of 6 keeps every cell a whole
 * device pixel at 2x, the same trade the interface font makes.
 */
const ICON_SIZE_STEP_PX = 6;

const DEFAULT_ICON_SIZE_PX = 24;

function snappedSize(size: number): number {
  return Math.max(ICON_SIZE_STEP_PX, Math.round(size / ICON_SIZE_STEP_PX) * ICON_SIZE_STEP_PX);
}

function pixelIcon(Svg: ComponentType<SVGProps<SVGSVGElement>>): PixelIcon {
  return function Icon({ size = DEFAULT_ICON_SIZE_PX, className, ...rest }: PixelIconProps) {
    const px = snappedSize(size);
    return (
      <Svg width={px} height={px} shapeRendering="crispEdges" className={className} {...rest} />
    );
  };
}

const GLYPH_CELL_UNITS = 2;

const GLYPH_OFFSET_UNITS = 1;

/**
 * The same 11×11 grid pixelarticons draw on — 2-unit cells starting one unit
 * in — written one character per cell, for the icons the set does not have.
 */
function glyphPath(rows: readonly string[]): string {
  const cells: string[] = [];
  for (const [y, row] of rows.entries()) {
    for (const [x, cell] of [...row].entries()) {
      if (cell !== "#") continue;
      const left = GLYPH_OFFSET_UNITS + x * GLYPH_CELL_UNITS;
      const top = GLYPH_OFFSET_UNITS + y * GLYPH_CELL_UNITS;
      cells.push(`M${left} ${top}h${GLYPH_CELL_UNITS}v${GLYPH_CELL_UNITS}h-${GLYPH_CELL_UNITS}z`);
    }
  }
  return cells.join("");
}

function glyph(rows: readonly string[]): ComponentType<SVGProps<SVGSVGElement>> {
  const d = glyphPath(rows);
  return function Glyph(props: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" {...props}>
        <path d={d} />
      </svg>
    );
  };
}

const Boot = glyph([
  "...........",
  ".####......",
  ".#..#......",
  ".#..#......",
  ".#..#......",
  ".#..####...",
  ".#.....##..",
  ".#......#..",
  ".#......##.",
  ".#########.",
  ".#########.",
]);

const Droplet = glyph([
  ".....#.....",
  "....#.#....",
  "....#.#....",
  "...#...#...",
  "..#.....#..",
  "..#.....#..",
  ".#.......#.",
  ".#.......#.",
  ".#.......#.",
  "..#.....#..",
  "...#####...",
]);

const Pickaxe = glyph([
  "..#######..",
  ".#...#...#.",
  "#....#....#",
  ".....#.....",
  ".....#.....",
  ".....#.....",
  ".....#.....",
  ".....#.....",
  ".....#.....",
  ".....#.....",
  ".....#.....",
]);

export const IconApple = pixelIcon(Apple);
export const IconBackpack = pixelIcon(Backpack);
export const IconBox = pixelIcon(Box);
export const IconBoot = pixelIcon(Boot);
export const IconBulb = pixelIcon(Lightbulb);
export const IconBulbOff = pixelIcon(LightbulbOff);
export const IconChat = pixelIcon(Message);
export const IconClose = pixelIcon(Close);
export const IconDiamond = pixelIcon(DiamondGem);
export const IconDoor = pixelIcon(DoorClosed);
export const IconDroplet = pixelIcon(Droplet);
export const IconExit = pixelIcon(Logout);
export const IconEye = pixelIcon(Eye);
export const IconEyeOff = pixelIcon(EyeOff);
export const IconFeedback = pixelIcon(MessageText);
export const IconFire = pixelIcon(Fire);
export const IconFace = pixelIcon(Smile);
export const IconGift = pixelIcon(Gift);
export const IconHand = pixelIcon(Hand);
export const IconHeart = pixelIcon(Heart);
export const IconHuman = pixelIcon(Human);
export const IconMapPin = pixelIcon(MapPin);
export const IconMenu = pixelIcon(Menu);
export const IconMinus = pixelIcon(Minus);
export const IconMove = pixelIcon(Move);
export const IconPickaxe = pixelIcon(Pickaxe);
export const IconPlus = pixelIcon(Plus);
export const IconSave = pixelIcon(Save);
export const IconSettings = pixelIcon(SettingsCog);
export const IconShirt = pixelIcon(Shirt);
export const IconSkull = pixelIcon(Skull);
export const IconSwitch = pixelIcon(Switch);
export const IconSword = pixelIcon(Sword);
export const IconTalk = pixelIcon(Comment);
export const IconTarget = pixelIcon(Target);
export const IconTools = pixelIcon(Tools);
