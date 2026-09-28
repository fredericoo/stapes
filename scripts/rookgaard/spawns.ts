export type Spawn = {
  kind: "monster" | "npc";
  name: string;
  x: number;
  y: number;
  z: number;
};

/**
 * A creature's position is written relative to the centre of the spawn it is
 * in, and the floor is the spawn's. Spawns with nobody in them are self-closing
 * tags, so the pattern has to tell the two forms apart or it reads the next
 * spawn's creatures as this one's.
 */
export function readSpawns(xml: string): Spawn[] {
  const out: Spawn[] = [];
  for (const spawn of xml.matchAll(/<spawn\s([^>]*?)(\/>|>([\s\S]*?)<\/spawn>)/g)) {
    const body = spawn[3];
    if (!body) continue;
    const centre = attributes(spawn[1]!);
    const cx = Number(centre.centerx);
    const cy = Number(centre.centery);
    const cz = Number(centre.centerz);
    for (const creature of body.matchAll(/<(monster|npc)\s([^>]*?)\/>/g)) {
      const at = attributes(creature[2]!);
      out.push({
        kind: creature[1] as Spawn["kind"],
        name: at.name!,
        x: cx + Number(at.x),
        y: cy + Number(at.y),
        z: cz,
      });
    }
  }
  return out;
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of source.matchAll(/(\w+)="([^"]*)"/g)) out[a[1]!] = a[2]!;
  return out;
}
