export type Term = {
  label: string;
  spoken?: string;
};

export const TERMS = {
  damage: { label: "Damage" },
  heal: { label: "Heal" },
  health: { label: "Health" },
  defence: { label: "Defence" },
  hit: { label: "Hit", spoken: "chance to land" },
  swing: { label: "Swing", spoken: "a blow every" },
  range: { label: "Range" },
  evasion: { label: "Evasion" },
  move: { label: "Move" },
  slots: { label: "Slots" },
  worn: { label: "Worn" },
  cadence: { label: "Acts every" },
  cooldown: { label: "Cooldown" },
  subject: { label: "Hits" },
  conjure: { label: "Puts" },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof TERMS;

export function termLabel(term: TermKey): string {
  return TERMS[term].label;
}

export function termSpoken(term: TermKey): string {
  const { label, spoken }: Term = TERMS[term];
  return spoken ?? label;
}

export const HEADINGS = {
  stats: "Stats",
  effects: "Effects",
  masteries: "Masteries",
  combat: "Combat",
  resists: "Resists",
  requires: "Requires",
  onHit: "On hit",
  onCast: "On cast",
  grants: "Grants",
} as const;

const EN_DASH = "–";

export function bandLabel(min: number, max: number): string {
  return min === max ? `${min}` : `${min}${EN_DASH}${max}`;
}
