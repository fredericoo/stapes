export type Expression<S> = (scope: S) => number;

export type NumericFunction =
  | { arity: 1; apply: (a: number) => number }
  | { arity: 2; apply: (a: number, b: number) => number };

export type Grammar<S> = {
  readonly variables: Readonly<Record<string, Expression<S>>>;
  readonly functions: Readonly<Record<string, NumericFunction>>;
  readonly lookups?: Readonly<Record<string, (key: string) => Expression<S>>>;
};

export const COMMON_FUNCTIONS: Readonly<Record<string, NumericFunction>> = {
  ceil: { arity: 1, apply: Math.ceil },
  floor: { arity: 1, apply: Math.floor },
  round: { arity: 1, apply: Math.round },
  abs: { arity: 1, apply: Math.abs },
  min: { arity: 2, apply: Math.min },
  max: { arity: 2, apply: Math.max },
};

type Token =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "string"; value: string }
  | { kind: "op"; value: string };

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

class Parser<S> {
  private at = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly grammar: Grammar<S>,
  ) {}

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

  expression(minPrecedence = 1): Expression<S> {
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

  private unary(): Expression<S> {
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

  private primary(): Expression<S> {
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

    const { variables } = this.grammar;
    if (!Object.hasOwn(variables, token.value)) {
      throw new ParseError(`unknown name "${token.value}"`);
    }
    return variables[token.value]!;
  }

  private call(name: string): Expression<S> {
    const { functions, lookups } = this.grammar;
    if (lookups && Object.hasOwn(lookups, name)) return this.lookup(name, lookups[name]!);

    if (!Object.hasOwn(functions, name)) throw new ParseError(`unknown function "${name}"`);
    const fn = functions[name]!;

    this.expectOp("(");
    const args: Expression<S>[] = [];
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

    /**
     * One closure per arity rather than mapping over the arguments, so that
     * evaluating a call allocates nothing: a particle's formulas run for every
     * particle on every frame.
     */
    const a = args[0]!;
    if (fn.arity === 1) {
      const apply = fn.apply;
      return (scope) => apply(a(scope));
    }
    const b = args[1]!;
    const apply = fn.apply;
    return (scope) => apply(a(scope), b(scope));
  }

  private lookup(name: string, build: (key: string) => Expression<S>): Expression<S> {
    this.expectOp("(");
    const token = this.take();
    if (token.kind !== "string") {
      throw new ParseError(`${name} takes a quoted id`);
    }
    this.expectOp(")");
    return build(token.value);
  }
}

export function compileExpression<S>(source: string, grammar: Grammar<S>): Expression<S> | null {
  const tokens = tokenise(source);
  if (!tokens || tokens.length === 0) return null;

  try {
    const parser = new Parser(tokens, grammar);
    const root = parser.expression();
    if (!parser.atEnd()) return null;
    return root;
  } catch (error) {
    if (error instanceof ParseError) return null;
    throw error;
  }
}
