import type { StatusDef } from "../lib/status";
import type { PlacedTile } from "../lib/types";
import { possessive } from "./blame";

export function conjuredName(
  name: string,
  placed: Pick<PlacedTile, "castBy">,
  nameOf: (actorId: string) => string | null,
): string {
  if (!placed.castBy) return name;
  return possessive(nameOf(placed.castBy), name);
}

export function sparesStander(
  placed: Pick<PlacedTile, "castBy">,
  status: StatusDef | undefined,
  who: string | undefined,
  reaches: (casterId: string) => boolean = REACHES,
): boolean {
  const castBy = placed.castBy;
  if (who === undefined || castBy === undefined) return false;
  if (status?.tone !== "bad") return false;
  return castBy === who || !reaches(castBy);
}

const REACHES = () => true;
