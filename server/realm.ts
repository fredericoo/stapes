export const REALM_LEADERS = 3;

export type Contender = {
  characterId: string;
  name: string;
  rating: number;
  createdAt: number;
};

export type Leader = { name: string; rating: number };

export type RealmState = { leaders: Leader[] };

/** On a tie the older character ranks first, so two characters level on rating do not swap places between refreshes. */
export function leadersOf(contenders: readonly Contender[]): Leader[] {
  return [...contenders]
    .sort(
      (a, b) =>
        b.rating - a.rating ||
        a.createdAt - b.createdAt ||
        (a.characterId < b.characterId ? -1 : 1),
    )
    .slice(0, REALM_LEADERS)
    .map(({ name, rating }) => ({ name, rating }));
}
