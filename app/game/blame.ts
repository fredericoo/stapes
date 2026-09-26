export type Blame = {
  source: string;
  by?: string;
};

const CAUSE_LABEL = "Cause of death:";

export function causeOfDeath(blame: Blame): string {
  const cause = blame.by ? `${blame.source} by ${blame.by}` : blame.source;
  return `${CAUSE_LABEL} ${cause}`;
}

export function possessive(owner: string | null, thing: string): string {
  return owner ? `${owner}'s ${thing}` : thing;
}
