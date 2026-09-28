export const GROUP = {
  none: 0,
  ground: 1,
  container: 2,
  teleport: 7,
  magicField: 8,
  splash: 11,
  fluid: 12,
  door: 13,
} as const;

export const FLAG = {
  blockSolid: 1 << 0,
  blockProjectile: 1 << 1,
  blockPathfind: 1 << 2,
  hasHeight: 1 << 3,
  pickupable: 1 << 5,
  moveable: 1 << 6,
  floorChangeDown: 1 << 8,
  floorChangeNorth: 1 << 9,
  floorChangeEast: 1 << 10,
  floorChangeSouth: 1 << 11,
  floorChangeWest: 1 << 12,
  alwaysOnTop: 1 << 13,
  hangable: 1 << 16,
  vertical: 1 << 17,
  horizontal: 1 << 18,
} as const;

export type ItemType = {
  id: number;
  group: number;
  flags: number;
  name: string;
  topOrder: number;
  description?: string;
};

type OtbNode = { type: number; data: number[]; children: OtbNode[] };

function otbNodes(bytes: Uint8Array): OtbNode {
  const stack: OtbNode[] = [];
  let root: OtbNode | null = null;
  for (let i = 4; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0xfd) stack.at(-1)!.data.push(bytes[++i]!);
    else if (b === 0xfe) {
      const node: OtbNode = { type: bytes[++i]!, data: [], children: [] };
      if (stack.length > 0) stack.at(-1)!.children.push(node);
      else root = node;
      stack.push(node);
    } else if (b === 0xff) {
      stack.pop();
      if (stack.length === 0) break;
    } else stack.at(-1)!.data.push(b);
  }
  if (!root) throw new Error("items.otb has no root node");
  return root;
}

const SERVER_ID = 0x10;
const TOP_ORDER = 0x2b;

/**
 * `items.otb` holds what the server knows about each item id: its group, its
 * flags, and for things drawn above the ground, the order they stack in.
 * `items.xml` holds the names, which is what most of the translation reads.
 */
export function readItemTypes(otb: Uint8Array, xml: string): Map<number, ItemType> {
  const types = new Map<number, ItemType>();
  for (const node of otbNodes(otb).children) {
    const d = node.data;
    const flags = (d[0]! | (d[1]! << 8) | (d[2]! << 16) | (d[3]! << 24)) >>> 0;
    const type: ItemType = { id: 0, group: node.type, flags, name: "", topOrder: 0 };
    let i = 4;
    while (i < d.length) {
      const attr = d[i]!;
      const length = d[i + 1]! | (d[i + 2]! << 8);
      if (attr === SERVER_ID) type.id = d[i + 3]! | (d[i + 4]! << 8);
      if (attr === TOP_ORDER) type.topOrder = d[i + 3]!;
      i += 3 + length;
    }
    types.set(type.id, type);
  }

  for (const match of xml.matchAll(/<item\s([^>]*?)(\/>|>([\s\S]*?)<\/item>)/g)) {
    const attrs: Record<string, string> = {};
    for (const a of match[1]!.matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
    const description = match[3]?.match(/<attribute\s+key="description"\s+value="([^"]*)"/i)?.[1];
    const from = Number(attrs.fromid ?? attrs.id);
    const to = Number(attrs.toid ?? attrs.id);
    for (let id = from; id <= to; id++) {
      const type = types.get(id) ?? { id, group: GROUP.none, flags: 0, name: "", topOrder: 0 };
      if (attrs.name) type.name = attrs.name.toLowerCase();
      if (description) type.description = description;
      types.set(id, type);
    }
  }
  return types;
}
