import type { CSSProperties } from "react";
import type { WindowFrame } from "../lib/windowFrames";

const FILLS: Record<WindowFrame, string> = {
  stone: "#24202c",
  timber: "#2a2018",
  leather: "#2a1c14",
  burlap: "#2b2418",
  chest: "#221a14",
};

export function windowFrameStyle(frame: WindowFrame | undefined): CSSProperties | undefined {
  if (!frame) return undefined;
  return { "--frame-image": `url("/frames/${frame}.svg")`, "--gump-fill": FILLS[frame] };
}
