/** `by` is prose for the reader, and can name a spell or a trap; `byId` is the actor answerable. */
export type Blame = {
  source: string;
  by?: string;
  byId?: string;
};

const CAUSE_LABEL = "Cause of death:";

export function describeBlame(blame: Blame): string {
  return blame.by ? `${blame.source} by ${blame.by}` : blame.source;
}

export function causeOfDeath(blame: Blame): string {
  return `${CAUSE_LABEL} ${describeBlame(blame)}`;
}

export function possessive(owner: string | null, thing: string): string {
  return owner ? `${owner}'s ${thing}` : thing;
}
