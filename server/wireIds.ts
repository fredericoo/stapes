import { residentOwnerId } from "../app/game/actors";
import type { PlacedTile } from "../app/lib/types";
import type { ServerMessage } from "../app/net/protocol";

const ALIAS_PREFIX = "~";
const ALIAS_RADIX = 36;

/**
 * An id shorter than the shortest resident's is sent as it is. Character ids
 * are UUIDs and residents are `npc:x,y,z,i`, so every id the live world mints
 * is aliased, and the short ids tests use pass through and stay readable.
 */
const SHORTEST_ALIASED_ID = residentOwnerId({ x: 0, y: 0, z: 0, stackIndex: 0 }).length;

const ID_KEYS: ReadonlySet<string> = new Set([
  "actorId",
  "actorIds",
  "castBy",
  "ids",
  "kingId",
  "npcId",
  "owner",
  "selfId",
  "target",
  "targetId",
]);

/**
 * One table for the process rather than one per `GameServer`, because
 * `chunkJson`'s text caches are module-wide too. An alias is never reused, so a
 * text cached with one stays true for as long as the process runs.
 */
const aliasById = new Map<string, string>();
const idByAlias = new Map<string, string>();
let nextAlias = 0;

const wiredStacks = new WeakMap<PlacedTile[], PlacedTile[]>();

export function wireId(id: string): string {
  if (id.length < SHORTEST_ALIASED_ID && !id.startsWith(ALIAS_PREFIX)) return id;
  let alias = aliasById.get(id);
  if (alias === undefined) {
    alias = `${ALIAS_PREFIX}${(nextAlias++).toString(ALIAS_RADIX)}`;
    aliasById.set(id, alias);
    idByAlias.set(alias, id);
  }
  return alias;
}

/** An id the server never aliased comes back as it was sent, as before aliases existed. */
export function realId(sent: string): string {
  return idByAlias.get(sent) ?? sent;
}

export function realIdsInCommand(text: string): string {
  if (!text.includes(ALIAS_PREFIX)) return text;
  return text
    .split(/(\s+)/)
    .map((token) => (token.startsWith(ALIAS_PREFIX) ? realId(token) : token))
    .join("");
}

export function wireStack(stack: PlacedTile[]): PlacedTile[] {
  const kept = wiredStacks.get(stack);
  if (kept) return kept;
  const wired = wireArray(stack, false) as PlacedTile[];
  wiredStacks.set(stack, wired);
  return wired;
}

/**
 * Returns the value itself when it names nobody by a long id, and otherwise a
 * copy with each id replaced, keys in their original order so the JSON differs
 * only in the ids.
 */
export function toWire<T>(value: T): T {
  return wireValue(value, false) as T;
}

export function wireJson(message: ServerMessage): string {
  return JSON.stringify(toWire(message));
}

function wireValue(value: unknown, isId: boolean): unknown {
  if (typeof value === "string") return isId ? wireId(value) : value;
  if (Array.isArray(value)) return wireArray(value, isId);
  if (value === null || typeof value !== "object") return value;
  return wireObject(value as Record<string, unknown>);
}

function wireArray(list: readonly unknown[], isId: boolean): readonly unknown[] {
  let out: unknown[] | null = null;
  for (let i = 0; i < list.length; i++) {
    const was = list[i];
    const now = wireValue(was, isId);
    if (now === was) continue;
    out ??= list.slice();
    out[i] = now;
  }
  return out ?? list;
}

function wireObject(record: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const key in record) {
    const was = record[key];
    const now =
      key === "stack" && Array.isArray(was)
        ? wireStack(was as PlacedTile[])
        : wireValue(was, ID_KEYS.has(key));
    if (now === was) continue;
    out ??= { ...record };
    out[key] = now;
  }
  return out ?? record;
}
