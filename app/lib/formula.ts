export type FormulaScope = {
  DURATION_SEC: number;
  REMAINING_SEC: number;
  ELAPSED_SEC: number;
  MAX_HP: number;
  HP: number;
  statuses: ReadonlyArray<{ defId: string }>;
};

export const FORMULA_VARIABLES = [
  "DURATION_SEC",
  "REMAINING_SEC",
  "ELAPSED_SEC",
  "MAX_HP",
  "HP",
] as const satisfies ReadonlyArray<keyof FormulaScope>;

export type Formula = {
  readonly source: string;
  evaluate(scope: FormulaScope): number;
};

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
 * Rounds half away from zero, unlike `Math.round`, which is asymmetric about
 * zero (`Math.round(-0.5)` is `-0` where `Math.round(0.5)` is `1`). A
 * non-finite result becomes 0 rather than `Infinity` or `NaN`, so a division
 * by zero in an authored formula cannot propagate into a body's hit points.
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

const HAS_STATUS = "has_status";

const OPERATORS = new Set(["+", "-", "*", "/", "%", "(", ")", ","]);

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
      if (end === -1) return null;
      tokens.push({ kind: "string", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    if (char >= "0" && char <= "9") {
      let end = i;
      while (end < source.length && /[0-9.]/.test(source[end]!)) end += 1;
      const value = Number(source.slice(i, end));
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

    if (args.length !== fn.arity) {
      throw new ParseError(`${name} takes ${fn.arity}`);
    }

    const apply = fn.apply;
    return (scope) => apply(args.map((arg) => arg(scope)));
  }

  private hasStatus(): Node {
    this.expectOp("(");
    const token = this.take();
    if (token.kind !== "string") {
      throw new ParseError(`${HAS_STATUS} takes a quoted status id`);
    }
    this.expectOp(")");
    const id = token.value;
    return (scope) => (scope.statuses.some((status) => status.defId === id) ? 1 : 0);
  }
}

export function constantFormula(value: number): Formula {
  const rounded = integerise(value);
  return { source: String(value), evaluate: () => rounded };
}

export function parseFormula(source: string): Formula | null {
  const tokens = tokenise(source);
  if (!tokens || tokens.length === 0) return null;

  try {
    const parser = new Parser(tokens);
    const root = parser.expression();
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
