type Entry = { lists: ReadonlyArray<ReadonlyArray<number>>; text: string };

const HASH_SEED = 0x811c9dc5;
const HASH_MULTIPLIER = 31;

/**
 * Text kept against a tuple of integer lists, for one tick: clients whose cuts
 * are the same indices into the same frame are sent the same payload, so it is
 * written once. The hash only picks a bucket; a hit needs every list equal.
 */
export class TextByLists {
  private readonly byHash = new Map<number, Entry[]>();

  textFor(lists: ReadonlyArray<ReadonlyArray<number>>, write: () => string): string {
    const key = hashLists(lists);
    const bucket = this.byHash.get(key);
    if (bucket === undefined) {
      const text = write();
      this.byHash.set(key, [{ lists, text }]);
      return text;
    }
    for (const entry of bucket) if (sameLists(entry.lists, lists)) return entry.text;
    const text = write();
    bucket.push({ lists, text });
    return text;
  }
}

/** Each list's length is mixed in before its items, so `[1,2],[3]` and `[1],[2,3]` hash apart. */
export function hashLists(lists: ReadonlyArray<ReadonlyArray<number>>): number {
  let h = HASH_SEED;
  for (let l = 0; l < lists.length; l++) {
    const list = lists[l]!;
    h = (Math.imul(h, HASH_MULTIPLIER) + list.length) | 0;
    for (let k = 0; k < list.length; k++) h = (Math.imul(h, HASH_MULTIPLIER) + list[k]!) | 0;
  }
  return h;
}

function sameLists(
  a: ReadonlyArray<ReadonlyArray<number>>,
  b: ReadonlyArray<ReadonlyArray<number>>,
): boolean {
  if (a.length !== b.length) return false;
  for (let l = 0; l < a.length; l++) if (!sameList(a[l]!, b[l]!)) return false;
  return true;
}

function sameList(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
