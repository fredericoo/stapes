import * as v from "valibot";

const corner = v.tuple([
  v.pipe(v.number(), v.integer()),
  v.pipe(v.number(), v.integer()),
  v.pipe(v.number(), v.integer()),
]);

const areaSchema = v.pipe(
  v.object({ from: corner, to: corner }),
  v.check(
    ({ from, to }) => from.every((n, i) => n <= to[i]!),
    "an area's from is its lowest x, y and z and its to the highest",
  ),
);

const exceptionSchema = v.object({
  check: v.pipe(v.string(), v.minLength(1)),
  kind: v.pipe(v.string(), v.minLength(1)),
  areas: v.pipe(v.array(areaSchema), v.minLength(1)),
  reason: v.pipe(v.string(), v.minLength(1, "every exception says why it is deliberate")),
});

export type VerifyException = v.InferOutput<typeof exceptionSchema>;

export type Area = VerifyException["areas"][number];

export function parseExceptions(raw: unknown): VerifyException[] {
  return v.parse(v.array(exceptionSchema), raw);
}

export type Located = { kind: string; x: number; y: number; z: number };

export type Excused<P> = P & { reason: string };

export type StaleException = { kind: string; area: Area; reason: string };

export type Applied<P> = { failing: P[]; excused: Excused<P>[]; stale: StaleException[] };

export function describeArea({ from, to }: Area): string {
  const span = (a: number, b: number) => (a === b ? `${a}` : `${a}..${b}`);
  return `${span(from[0], to[0])},${span(from[1], to[1])} L${span(from[2], to[2])}`;
}

const contains = ({ from, to }: Area, { x, y, z }: Located) =>
  x >= from[0] && x <= to[0] && y >= from[1] && y <= to[1] && z >= from[2] && z <= to[2];

/**
 * Splits `problems` into the ones inside an area an exception for `check`
 * names for their kind, and the rest. An area that excuses nothing comes back
 * as stale, so the list cannot outlive what it excuses.
 */
export function applyExceptions<P extends Located>(
  check: string,
  problems: readonly P[],
  exceptions: readonly VerifyException[],
): Applied<P> {
  const areas = exceptions
    .filter((exception) => exception.check === check)
    .flatMap(({ kind, areas, reason }) => areas.map((area) => ({ kind, area, reason })));
  const used = new Set<(typeof areas)[number]>();
  const failing: P[] = [];
  const excused: Excused<P>[] = [];
  for (const problem of problems) {
    const match = areas.find((a) => a.kind === problem.kind && contains(a.area, problem));
    if (match) {
      used.add(match);
      excused.push({ ...problem, reason: match.reason });
    } else {
      failing.push(problem);
    }
  }
  const stale = areas.filter((a) => !used.has(a));
  return { failing, excused, stale };
}
