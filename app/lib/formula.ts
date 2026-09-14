/**
 * A tiny arithmetic language, so an amount can be *interpreted* rather than
 * stored.
 *
 * A status heals a share of the maximum on a cadence set by that share, and a
 * poison bites harder the longer it has left; neither is a number an author can
 * type, and both are one line of arithmetic. That is the whole of what this is for — see
 * `./status`.
 *
 * ## Why a parser and not `eval`
 *
 * The source is authored data crossing a trust boundary, and this runs in a
 * Worker. `eval` and `new Function` would hand whatever is in `statuses.json`
 * the whole runtime; a recursive-descent parser over a fixed vocabulary can only
 * ever produce a number. It is also the only version of this that can be
 * asserted without a browser, which matters because the failure mode of a
 * mis-parsed formula is a fight that is quietly wrong rather than a crash.
 *
 * ## Compiled once, evaluated often
 *
 * {@link parseFormula} returns a closure tree, not an AST to be walked with a
 * switch. A status's effect is evaluated once a second per bearer and its
 * modifiers once per body per frame, so the shape that costs nothing at that
 * rate is the one where the interpretation has already happened.
 *
 * A source that does not parse reads as **no formula at all** — the same
 * discipline every resolver in `./interactions` is under, where a malformed
 * block means "this tile does not do that" rather than a world that will not
 * start.
 */

/**
 * What a formula may read.
 *
 * Every upper-case field is a whole number and a variable a formula can name.
 * `statuses` is the exception: it is what `has_status('id')` looks in, and is not a
 * variable — a list has no arithmetic to be in.
 */
export type FormulaScope = {
  /** The full rolled duration of this status instance, in whole seconds. */
  DURATION_SEC: number;
  /** Seconds left, rounded up — so a status with 1ms to run still reads 1. */
  REMAINING_SEC: number;
  /** `DURATION_SEC - REMAINING_SEC`. */
  ELAPSED_SEC: number;
  /**
   * The bearer's maximum health, **before** any status modifier touches it.
   *
   * Deliberately the unmodified figure: a status that raised max health and
   * healed a share of it would otherwise compound against itself every period.
   */
  MAX_HP: number;
  /** The bearer's health as it stands. */
  HP: number;
  /**
   * What the bearer is under, for `has_status('id')`.
   *
   * The instances themselves rather than a set of ids, so that building a
   * scope — once per bearer per tick, and once per instance per stat read —
   * allocates nothing: a body carries a status list already and the scope
   * points at it. The engine's own combat flag is in it like any other, which
   * is what lets a cadence read `has_status('combat')`.
   */
  statuses: ReadonlyArray<{ defId: string }>;
};

export const FORMULA_VARIABLES = [
  "DURATION_SEC",
  "REMAINING_SEC",
  "ELAPSED_SEC",
  "MAX_HP",
  "HP",
] as const satisfies ReadonlyArray<keyof FormulaScope>;

/** Compiled, and evaluated against a scope. */
export type Formula = {
  /** The source it was compiled from, kept for the editor to show back. */
  readonly source: string;
  /** The integer this formula is worth in this scope. See {@link integerise}. */
  evaluate(scope: FormulaScope): number;
};

/** An expression that has not been rounded yet. */
type Node = (scope: FormulaScope) => number;

const FUNCTIONS: Record<string, { arity: number; apply: (args: number[]) => number }> = {
  ceil: { arity: 1, apply: ([v]) => Math.ceil(v!) },
  floor: { arity: 1, apply: ([v]) => Math.floor(v!) },
  round: { arity: 1, apply: ([v]) => Math.round(v!) },
  abs: { arity: 1, apply: ([v]) => Math.abs(v!) },
  min: { arity: 2, apply: ([a, b]) => Math.min(a!, b!) },
  max: { arity: 2, apply: ([a, b]) => Math.max(a!, b!) },
};

/**
 * Round half **away from zero**, so a heal and a poison of the same size are the
 * same size.
 *
 * `Math.round` is asymmetric about zero in JavaScript — `Math.round(-0.5)` is
 * `-0` where `Math.round(0.5)` is `1` — which would quietly make every poison a
 * shade weaker than the equivalent heal, in a way nobody would find by reading
 * the formula. An author who wants a direction writes `ceil` or `floor` and this
 * is a no-op over it.
 *
 * A non-finite result — a division by zero, an overflow — is **nothing
 * happened**, not `Infinity`. The alternative is a number that propagates into
 * hit points and a body that dies or becomes immortal because of a typo.
 */
export function integerise(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.sign(value) * Math.round(Math.abs(value));
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "string"; value: string }
  | { kind: "op"; value: string };

/**
 * The one function whose argument is a name rather than a number.
 *
 * `has_status('combat')` is 1 while the bearer is under the status with that id and
 * 0 otherwise, so it can be multiplied into any arithmetic — `(2 - has_status('combat'))`
 * halves a period out of combat. **Single-quoted, and only single-quoted**,
 * because every formula lives inside a JSON string, where a double quote is an
 * escape nobody should have to type. A status id can hold a hyphen
 * (`food-poisoning`), which is why it cannot be a bare name: the tokeniser
 * would read the hyphen as a minus.
 *
 * Not in {@link FUNCTIONS}, whose entries take numbers; it is parsed on its own
 * in {@link Parser.call}. Named for what it asks rather than a bare `has`, so a
 * later `has_item` or `has_tag` reads as its sibling rather than its overload.
 */
const HAS_STATUS = "has_status";

const OPERATORS = new Set(["+", "-", "*", "/", "%", "(", ")", ","]);

/** Split the source into tokens, or null on a character with no meaning here. */
function tokenise(source: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      i += 1;
      continue;
    }

    if (OPERATORS.has(char)) {
      tokens.push({ kind: "op", value: char });
      i += 1;
      continue;
    }

    if (char === "'") {
      const end = source.indexOf("'", i + 1);
      // An unterminated quote is a refusal, not a string to the end: `has_status('x`
      // is a typo, and reading it as `x` would hide the half the author meant.
      if (end === -1) return null;
      tokens.push({ kind: "string", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    if (char >= "0" && char <= "9") {
      let end = i;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end += 1;
      const value = Number(source.slice(i, end));
      // `1.2.3` parses as NaN rather than as something surprising.
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: "number", value });
      i = end;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = i;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end]!)) end += 1;
      tokens.push({ kind: "name", value: source.slice(i, end) });
      i = end;
      continue;
    }

    return null;
  }

  return tokens;
}

/**
 * Precedence climbing over two levels, which is all the language has.
 *
 * Thrown rather than returned as a null at every step: the recursion is five
 * functions deep and threading a failure through each of them would be most of
 * the module. It is caught once, at {@link parseFormula}, and turned back into
 * the null that everything outside sees.
 */
class ParseError extends Error {}

const BINARY: Record<string, { precedence: number; apply: (a: number, b: number) => number }> = {
  "+": { precedence: 1, apply: (a, b) => a + b },
  "-": { precedence: 1, apply: (a, b) => a - b },
  "*": { precedence: 2, apply: (a, b) => a * b },
  "/": { precedence: 2, apply: (a, b) => a / b },
  "%": { precedence: 2, apply: (a, b) => a % b },
};

class Parser {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private take(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new ParseError("unexpected end");
    this.at += 1;
    return token;
  }

  private expectOp(value: string) {
    const token = this.take();
    if (token.kind !== "op" || token.value !== value) {
      throw new ParseError(`expected "${value}"`);
    }
  }

  atEnd(): boolean {
    return this.at >= this.tokens.length;
  }

  expression(minPrecedence = 1): Node {
    let left = this.unary();

    for (;;) {
      const token = this.peek();
      if (!token || token.kind !== "op") break;
      const operator = BINARY[token.value];
      if (!operator || operator.precedence < minPrecedence) break;
      this.at += 1;
      // Left-associative, so the right-hand side stops at anything this
      // operator would rather bind first.
      const right = this.expression(operator.precedence + 1);
      const apply = operator.apply;
      const lhs = left;
      left = (scope) => apply(lhs(scope), right(scope));
    }

    return left;
  }

  private unary(): Node {
    const token = this.peek();
    if (token?.kind === "op" && token.value === "-") {
      this.at += 1;
      const operand = this.unary();
      return (scope) => -operand(scope);
    }
    // A leading `+` is legal and means nothing, which is friendlier than
    // refusing a formula somebody wrote for symmetry with the negative case.
    if (token?.kind === "op" && token.value === "+") {
      this.at += 1;
      return this.unary();
    }
    return this.primary();
  }

  private primary(): Node {
    const token = this.take();

    if (token.kind === "number") {
      const value = token.value;
      return () => value;
    }

    if (token.kind === "op" && token.value === "(") {
      const inner = this.expression();
      this.expectOp(")");
      return inner;
    }

    // A string is not a value: it is only ever the argument of `has_status`, and
    // `'combat' + 1` has no arithmetic to be.
    if (token.kind !== "name") throw new ParseError("expected a value");

    const next = this.peek();
    if (next?.kind === "op" && next.value === "(") {
      return this.call(token.value);
    }

    if (!(FORMULA_VARIABLES as readonly string[]).includes(token.value)) {
      throw new ParseError(`unknown name "${token.value}"`);
    }
    const name = token.value as (typeof FORMULA_VARIABLES)[number];
    return (scope) => scope[name];
  }

  private call(name: string): Node {
    if (name === HAS_STATUS) return this.hasStatus();

    const fn = FUNCTIONS[name];
    if (!fn) throw new ParseError(`unknown function "${name}"`);

    this.expectOp("(");
    const args: Node[] = [];
    for (;;) {
      args.push(this.expression());
      const next = this.peek();
      if (next?.kind === "op" && next.value === ",") {
        this.at += 1;
        continue;
      }
      break;
    }
    this.expectOp(")");

    // Arity is checked here rather than left to `undefined` arriving in the
    // implementation, where `min(3)` would silently be `NaN` and read as an
    // effect that did nothing.
    if (args.length !== fn.arity) {
      throw new ParseError(`${name} takes ${fn.arity}`);
    }

    const apply = fn.apply;
    return (scope) => apply(args.map((arg) => arg(scope)));
  }

  /** `has_status('id')`: one while the bearer is under that status, else zero. See {@link HAS_STATUS}. */
  private hasStatus(): Node {
    this.expectOp("(");
    const token = this.take();
    if (token.kind !== "string") {
      throw new ParseError(`${HAS_STATUS} takes a quoted status id`);
    }
    this.expectOp(")");
    const id = token.value;
    return (scope) =>
      scope.statuses.some((status) => status.defId === id) ? 1 : 0;
  }
}

/**
 * A formula that is always this number.
 *
 * For a field that may be authored as either — a status cadence is a plain
 * `3000` on every status written before it could be a formula — so the reader
 * evaluates one shape and the number is not a second branch at every use.
 */
export function constantFormula(value: number): Formula {
  const rounded = integerise(value);
  return { source: String(value), evaluate: () => rounded };
}

/** Compile a formula, or null when the source is not one. */
export function parseFormula(source: string): Formula | null {
  const tokens = tokenise(source);
  if (!tokens || tokens.length === 0) return null;

  try {
    const parser = new Parser(tokens);
    const root = parser.expression();
    // Trailing rubbish is a refusal rather than something to ignore: `1 2` is a
    // typo, and reading it as `1` would hide the half the author meant.
    if (!parser.atEnd()) return null;
    return {
      source,
      evaluate: (scope) => integerise(root(scope)),
    };
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}
