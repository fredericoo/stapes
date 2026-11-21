import { DEFAULT_HOUSE_CONFIG } from "../proceduralSettings";
import type { MapNode, Point } from "./doc";

type Raw = Record<string, unknown>;

const d = DEFAULT_HOUSE_CONFIG;

/** A version 1 house put its door two cells in from a corner when it was not centred. */
const DOOR_INSET = 2;

function doorPoint(row: unknown, column: unknown): Point | null {
  const x: Point =
    column === "west"
      ? { x: DOOR_INSET, y: 0, pinX: "left" }
      : column === "east"
        ? { x: DOOR_INSET, y: 0, pinX: "right" }
        : { x: 0, y: 0, pinX: "center" };
  if (row === "north") return { ...x, pinY: "top" };
  if (row === "south") return { ...x, pinY: "bottom" };
  if (column === "west") return { x: 0, y: 0, pinX: "left", pinY: "center" };
  if (column === "east") return { x: 0, y: 0, pinX: "right", pinY: "center" };
  return null;
}

function keysOf(node: Raw, into: Set<string>) {
  if (typeof node.key === "string") into.add(node.key);
  if (Array.isArray(node.children)) for (const c of node.children) keysOf(c as Raw, into);
}

/**
 * Version 1 kept a house's storeys, door and roof in its props. Version 2
 * has a Floor layer for each storey, the door as a point on the ground
 * floor, and the roof as a Roof layer.
 */
function houseFrom(node: Raw, taken: Set<string>): Raw {
  const props = (node.props ?? {}) as Raw;
  const key = (suffix: string) => {
    let next = `${String(node.key)}-${suffix}`;
    for (let n = 2; taken.has(next); n++) next = `${String(node.key)}-${suffix}-${n}`;
    taken.add(next);
    return next;
  };
  const storeys = typeof props.storeys === "number" ? props.storeys : d.storeys;
  const door =
    props.door === null
      ? null
      : doorPoint(props.doorRow ?? d.doorRow, props.doorColumn ?? d.doorColumn);
  const parts: MapNode[] = [];
  for (let i = 0; i < storeys; i++) {
    parts.push({
      type: "floor",
      key: key(i === 0 ? "ground" : `floor-${i + 1}`),
      props: i === 0 && door ? { use: "empty", doors: [door] } : { use: "empty" },
    });
  }
  const colour = props.roofColour === undefined ? d.roofColour : props.roofColour;
  if (colour !== null) {
    parts.push({
      type: "roof",
      key: key("roof"),
      props: {
        colour,
        pitch: props.roofPitch ?? d.roofPitch,
        orientation: props.roofOrientation ?? d.roofOrientation,
      },
    });
  }
  const kept = Object.fromEntries(
    Object.entries(props).filter(
      ([name, value]) =>
        ["wall", "floor", "window", "windowSpacing"].includes(name) ||
        (name === "door" && value !== null),
    ),
  );
  return {
    ...node,
    props: kept,
    children: [...parts, ...(Array.isArray(node.children) ? node.children : [])],
  };
}

/** Brings a saved tree of an earlier version up to the current one; anything else is returned as it was. */
export function migrateDoc(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || (raw as Raw).version !== 1) return raw;
  const doc = raw as Raw;
  if (!doc.root || typeof doc.root !== "object") return raw;
  const taken = new Set<string>();
  keysOf(doc.root as Raw, taken);
  const visit = (node: Raw): Raw => {
    const children = Array.isArray(node.children)
      ? { children: node.children.map((c) => visit(c as Raw)) }
      : {};
    const next: Raw = { ...node, ...children };
    return next.type === "house" ? houseFrom(next, taken) : next;
  };
  return { ...doc, version: 2, root: visit(doc.root as Raw) };
}
