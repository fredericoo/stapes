/** What a bot remembers: the last this many things that happened to it. */
export const MEMORY_LINES = 24;

export type Recalled = {
  /** Rises by one per line, so a reader can tell which lines arrived since it last looked. */
  readonly seq: number;
  readonly atMs: number;
  readonly line: string;
  /** Another player said it. */
  readonly heard: boolean;
};

export class Recollection {
  private lines: Recalled[] = [];
  private nextSeq = 1;

  add(atMs: number, line: string, heard = false) {
    this.lines.push({ seq: this.nextSeq++, atMs, line, heard });
    if (this.lines.length > MEMORY_LINES) this.lines.shift();
  }

  recent(): readonly Recalled[] {
    return this.lines.slice();
  }
}
