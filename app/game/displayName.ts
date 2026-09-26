import { RATING_GLYPH } from "../lib/mastery";
import { PLAYER_TILE_ID } from "./constants";
import { PVP_MARK } from "./pvp";
import type { TileDef } from "../lib/types";

export const UNNAMED_BODY = "Nobody";

export function bodyNameFor(
  body: { tileId: string; name?: string | null },
  tilesById: Record<string, TileDef>,
): string {
  if (body.tileId === PLAYER_TILE_ID) return body.name ?? UNNAMED_BODY;
  return tilesById[body.tileId]?.name ?? body.name ?? UNNAMED_BODY;
}

export function bodyNameIn(
  bodies: readonly { id: string; tileId: string; name?: string | null }[],
  tilesById: Record<string, TileDef>,
): (actorId: string) => string | null {
  return (actorId) => {
    const body = bodies.find((one) => one.id === actorId);
    if (!body) return null;
    return bodyNameFor(body, tilesById);
  };
}

export function fightingName(name: string, pvp: boolean): string {
  return pvp ? `${name} ${PVP_MARK}` : name;
}

export function sizedUpName(name: string, rating: number | null, looking: boolean): string {
  if (!looking || rating === null) return name;
  return `${name} ${RATING_GLYPH}${rating}`;
}
