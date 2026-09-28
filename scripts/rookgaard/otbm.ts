export type OtbmItem = {
  id: number;
  count?: number;
  actionId?: number;
  uniqueId?: number;
  text?: string;
  teleport?: { x: number; y: number; z: number };
  items?: OtbmItem[];
};

export type OtbmTile = {
  x: number;
  y: number;
  z: number;
  houseId?: number;
  flags: number;
  items: OtbmItem[];
};

export type OtbmArea = {
  wantsArea(x: number, y: number, z: number): boolean;
  wantsTile(x: number, y: number, z: number): boolean;
};

const ESCAPE = 0xfd;
const START = 0xfe;
const END = 0xff;

const MAP_DATA = 2;
const TILE_AREA = 4;
const TILE = 5;
const ITEM = 6;
const HOUSE_TILE = 14;

const TILE_FLAGS = 3;
const TILE_GROUND = 9;

const ATTR = {
  actionId: 4,
  uniqueId: 5,
  text: 6,
  desc: 7,
  teleport: 8,
  depotId: 10,
  runeCharges: 12,
  houseDoorId: 14,
  count: 15,
  duration: 16,
  decayingState: 17,
  writtenDate: 18,
  writtenBy: 19,
  sleeperGuid: 20,
  sleepStart: 21,
  charges: 22,
} as const;

type Node = { type: number; props: Uint8Array; children: Node[] };

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.pos >= this.bytes.length;
  }
  u8(): number {
    return this.bytes[this.pos++]!;
  }
  u16(): number {
    const v = this.bytes[this.pos]! | (this.bytes[this.pos + 1]! << 8);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const b = this.bytes;
    const v = (b[this.pos]! | (b[this.pos + 1]! << 8) | (b[this.pos + 2]! << 16)) >>> 0;
    const high = b[this.pos + 3]! * 0x1000000;
    this.pos += 4;
    return v + high;
  }
  string(): string {
    const length = this.u16();
    const text = new TextDecoder("latin1").decode(this.bytes.subarray(this.pos, this.pos + length));
    this.pos += length;
    return text;
  }
}

/**
 * OTBM is a tree of nodes framed by START and END bytes, with ESCAPE in front of
 * any data byte that happens to equal one of the three. A node's own data comes
 * before its first child, so it can be read without walking the children.
 */
function leadingData(bytes: Uint8Array, start: number): Uint8Array {
  const out: number[] = [];
  for (let i = start + 2; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === ESCAPE) out.push(bytes[++i]!);
    else if (b === START || b === END) break;
    else out.push(b);
  }
  return Uint8Array.from(out);
}

function skipNode(bytes: Uint8Array, start: number): number {
  let depth = 0;
  for (let i = start; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === ESCAPE) i++;
    else if (b === START) {
      depth++;
      i++;
    } else if (b === END && --depth === 0) return i + 1;
  }
  throw new Error(`OTBM node at byte ${start} is never closed`);
}

function childStarts(bytes: Uint8Array, start: number): number[] {
  const out: number[] = [];
  let i = start + 2;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === ESCAPE) i += 2;
    else if (b === START) {
      out.push(i);
      i = skipNode(bytes, i);
    } else if (b === END) return out;
    else i++;
  }
  throw new Error(`OTBM node at byte ${start} is never closed`);
}

function readNode(bytes: Uint8Array, start: number): { node: Node; end: number } {
  const type = bytes[start + 1]!;
  const props: number[] = [];
  const children: Node[] = [];
  let i = start + 2;
  while (i < bytes.length) {
    const b = bytes[i]!;
    if (b === ESCAPE) {
      props.push(bytes[i + 1]!);
      i += 2;
    } else if (b === START) {
      const child = readNode(bytes, i);
      children.push(child.node);
      i = child.end;
    } else if (b === END) {
      return { node: { type, props: Uint8Array.from(props), children }, end: i + 1 };
    } else {
      props.push(b);
      i++;
    }
  }
  throw new Error(`OTBM node at byte ${start} is never closed`);
}

function readItem(node: Node): OtbmItem {
  const r = new Reader(node.props);
  const item: OtbmItem = { id: r.u16() };
  while (!r.done) {
    const attr = r.u8();
    if (attr === ATTR.count) item.count = r.u8();
    else if (attr === ATTR.actionId) item.actionId = r.u16();
    else if (attr === ATTR.uniqueId) item.uniqueId = r.u16();
    else if (attr === ATTR.text) item.text = r.string();
    else if (attr === ATTR.teleport) item.teleport = { x: r.u16(), y: r.u16(), z: r.u8() };
    else if (attr === ATTR.desc || attr === ATTR.writtenBy) r.string();
    else if (attr === ATTR.depotId || attr === ATTR.charges) r.u16();
    else if (
      attr === ATTR.runeCharges ||
      attr === ATTR.houseDoorId ||
      attr === ATTR.decayingState
    ) {
      r.u8();
    } else if (
      attr === ATTR.duration ||
      attr === ATTR.writtenDate ||
      attr === ATTR.sleeperGuid ||
      attr === ATTR.sleepStart
    ) {
      r.u32();
    } else break;
  }
  const contents = node.children.filter((c) => c.type === ITEM).map(readItem);
  if (contents.length > 0) item.items = contents;
  return item;
}

function readTile(node: Node, baseX: number, baseY: number, z: number): OtbmTile {
  const r = new Reader(node.props);
  const tile: OtbmTile = { x: baseX + r.u8(), y: baseY + r.u8(), z, flags: 0, items: [] };
  if (node.type === HOUSE_TILE) tile.houseId = r.u32();
  while (!r.done) {
    const attr = r.u8();
    if (attr === TILE_FLAGS) tile.flags = r.u32();
    else if (attr === TILE_GROUND) tile.items.push({ id: r.u16() });
    else throw new Error(`tile ${tile.x},${tile.y},${z} has unknown attribute ${attr}`);
  }
  for (const child of node.children) if (child.type === ITEM) tile.items.push(readItem(child));
  return tile;
}

/**
 * Reads the tiles an area asks for. A whole world is tens of megabytes, so a
 * tile area outside the region is skipped by scanning to its END byte rather
 * than by building it.
 */
export function readOtbmTiles(bytes: Uint8Array, area: OtbmArea): OtbmTile[] {
  const tiles: OtbmTile[] = [];
  const ROOT = 4;
  for (const mapStart of childStarts(bytes, ROOT)) {
    if (bytes[mapStart + 1] !== MAP_DATA) continue;
    for (const areaStart of childStarts(bytes, mapStart)) {
      if (bytes[areaStart + 1] !== TILE_AREA) continue;
      const header = new Reader(leadingData(bytes, areaStart));
      const baseX = header.u16();
      const baseY = header.u16();
      const z = header.u8();
      if (!area.wantsArea(baseX, baseY, z)) continue;
      for (const node of readNode(bytes, areaStart).node.children) {
        if (node.type !== TILE && node.type !== HOUSE_TILE) continue;
        const tile = readTile(node, baseX, baseY, z);
        if (area.wantsTile(tile.x, tile.y, tile.z)) tiles.push(tile);
      }
    }
  }
  return tiles;
}
