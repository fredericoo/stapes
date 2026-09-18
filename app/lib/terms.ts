/**
 * The words the game uses for the things it measures, in one place.
 *
 * A module of its own for the reason `./duration` is: two surfaces answer the
 * same question about different subjects — an item's card says what a weapon is
 * worth (`../game/itemCard`), the stats panel says what a body is worth
 * (`../components/StatsPanel`) — and a player reading one after the other has to
 * meet the same word for the same thing. Neither module should import the other,
 * so the vocabulary lives where both can reach it.
 *
 * They had drifted. The card said `dmg`, `hit`, `every`, `reach` and `def`; the
 * panel said `Damage`, `Accuracy`, `Atk Spd`, `Range` and `Defence`. Five
 * readings, ten spellings, and one of the pairs was not even the same
 * measurement: the panel's `Accuracy` was `hitChance`, which is the probability
 * a swing lands, while `accuracy` is the weapon's own field and is also what a
 * defender's evasion is contested against. A reader comparing the sword in their
 * hand against the body holding it was matching abbreviations by position.
 *
 * ## One word, one measurement
 *
 * A term is named for what it measures, never for the surface it is drawn on.
 * **A label has to fit the narrowest surface that draws it**, which is the stats
 * panel's grid: two columns inside a 224px chrome column, so a caption past
 * about eight characters is truncated with an ellipsis. "Hit chance" and "Swing
 * every" both read well on a card and both came back as "Hit chan…" and "Swing
 * e…" in the panel, which is the drift this module exists to stop arriving by a
 * different road. Where the word will not fit, shorten the *word*, for
 * everybody.
 *
 * The *value* is a different matter and is each surface's own:
 * `../game/attributes`'s `shortReach` says "2–8c" under a `Range` the card
 * heads "2–8 cells, fired". A figure has no drift to cause, because a reader
 * matching two surfaces up matches the captions.
 *
 * Whole words rather than the abbreviations the card used to carry. The card's
 * rule is that a row is a caption and a figure rather than a sentence, which
 * "Blocks — 1 a blow" broke and "Defence 4" does not: one noun is still a
 * caption. The abbreviations bought about four characters and cost every row a
 * {@link Term.spoken} override, because `def` read aloud is not a word.
 */

/** One measurement, as a caption and as something that can be read aloud. */
export type Term = {
  /** What a column heading or a row caption says. One noun where possible. */
  label: string;
  /**
   * The same thing as a clause, for the route that reads a card aloud.
   *
   * Absent wherever {@link label} is already one, which is most of them — that
   * is what picking whole words bought. It exists for the few labels that only
   * parse against the figure beside them: "Swing: 1.2s" read out is not a
   * sentence, and "a blow every 1.2s" is.
   */
  spoken?: string;
};

/**
 * Every measurement a player-facing row reports, keyed by what it measures.
 *
 * The key is the stable name — a test looks a row up by it and React keys a list
 * on it — so it is the thing to rename last and the label is the thing to rename
 * freely.
 */
export const TERMS = {
  /** What a blow is worth, as the band it can land in. @see `../game/combat`'s `damageBand` */
  damage: { label: "Damage" },
  /** What a blow is worth when the figure is negative and mends instead. */
  heal: { label: "Heal" },
  /** Hit points, moved: swallowed off a loaf, ticked back by a charm. */
  health: { label: "Health" },
  /** Flat reduction on every blow that lands, worn or held. */
  defence: { label: "Defence" },
  /**
   * How often a swing connects with anything at all.
   *
   * The probability, which is why it is not called accuracy: `accuracy` is a
   * weapon's own field and one side of a contest, and the two answer different
   * questions. @see `./battler`'s `FightingStats.accuracy`
   */
  hit: { label: "Hit", spoken: "chance to land" },
  /** The wait between blows, which is a duration and has to read as one. */
  swing: { label: "Swing", spoken: "a blow every" },
  /** How far a blow carries. Named "range" rather than "reach" so the card and the panel agree. */
  range: { label: "Range" },
  /** One side of the dodge contest. @see `../game/combat`'s `dodgeChance` */
  evasion: { label: "Evasion" },
  /** Ground covered, as a rate. */
  move: { label: "Move" },
  /** How much a container holds, against what is in this one. */
  slots: { label: "Slots" },
  /** Which square a container goes in, or that it goes in none. */
  worn: { label: "Worn" },
  /** How often a charm acts, which is the whole of what a charm costs. */
  cadence: { label: "Acts every" },
  /** The wait before a stone may be pressed again. */
  cooldown: { label: "Cooldown" },
  /** Who a stone's bolt lands on. */
  subject: { label: "Hits" },
  /** That a conjure puts something in a cell, and not what. */
  conjure: { label: "Puts" },
} as const satisfies Record<string, Term>;

export type TermKey = keyof typeof TERMS;

/** What a row's caption says. */
export function termLabel(term: TermKey): string {
  return TERMS[term].label;
}

/**
 * The same caption as a clause, for the route that speaks it.
 *
 * Falls through to the label, which is the common case and the reason
 * {@link Term.spoken} is optional rather than a second column to fill in.
 */
export function termSpoken(term: TermKey): string {
  // Widened to `Term` on the way out, because `as const` narrows each entry to
  // the fields it happens to carry and most of them do not carry this one.
  const { label, spoken }: Term = TERMS[term];
  return spoken ?? label;
}

/**
 * What a block of player-facing rows is headed with.
 *
 * Here beside the terms for the same reason the terms are here at all — the card
 * and the panel both head lists, and a section that meant one thing in two
 * spellings is the same drift one row over. They are strings rather than
 * {@link Term}s because a heading is never read against a figure, so there is
 * nothing for a spoken form to differ from.
 */
export const HEADINGS = {
  /** The panel that says what you are. */
  stats: "Stats",
  /** What is running on this body. */
  effects: "Effects",
  /** What you have practised. */
  masteries: "Masteries",
  /** What that currently comes to with a weapon in your hand. */
  combat: "Combat",
  /** The kinds of blow a worn thing is unusually good against. */
  resists: "Resists",
  /** What an item asks of whoever uses it. */
  requires: "Requires",
  /** What a connecting blow leaves behind. */
  onHit: "On hit",
  /** What a cast leaves behind. */
  onCast: "On cast",
  /** What wearing or carrying a thing hands over, with no roll in the way. */
  grants: "Grants",
} as const;

/** An en dash, which is what a span between two figures is set with. */
const EN_DASH = "–";

/**
 * A band of whole numbers, as the one reading it is.
 *
 * **One figure where the ends agree**, because "6–6" is a range with nothing in
 * it and invites the reader to look for a spread that is not there. That case is
 * real: a weapon may be authored with no variance at all.
 *
 * @see `../game/combat`'s `damageBand`, which is where the ends come from.
 */
export function bandLabel(min: number, max: number): string {
  return min === max ? `${min}` : `${min}${EN_DASH}${max}`;
}
