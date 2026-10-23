import type { ParseArgsOptionsConfig } from "node:util";

export type Parsed = {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
};

export type Outcome = {
  exitCode: number;
  seed: number | null;
  json: Record<string, unknown>;
  text: string;
};

export type Command = {
  name: string;
  summary: string;
  usage: string;
  options: ParseArgsOptionsConfig;
  help: readonly [flag: string, text: string][];
  run(args: Parsed): Promise<Outcome> | Outcome;
};

export class UsageError extends Error {}

export type Commit = { sha: string | null; dirty: boolean };

export function commitOf(cwd: string): Commit {
  const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd });
  if (head.exitCode !== 0) return { sha: null, dirty: false };
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd });
  return {
    sha: head.stdout.toString().trim(),
    dirty: status.stdout.toString().trim() !== "",
  };
}

export function describeCommit(commit: Commit): string {
  if (!commit.sha) return "no git commit";
  return commit.dirty ? `commit ${commit.sha}, with uncommitted changes` : `commit ${commit.sha}`;
}

export function wholeNumber(
  value: string | boolean | undefined,
  flag: string,
  fallback: number,
  least = Number.MIN_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (typeof value !== "string" || value.trim() === "" || !Number.isSafeInteger(n) || n < least) {
    const floor = least === Number.MIN_SAFE_INTEGER ? "" : ` of at least ${least}`;
    throw new UsageError(`${flag} takes a whole number${floor}, not "${String(value)}".`);
  }
  return n;
}

export function choice<T extends string>(
  value: string | boolean | undefined,
  flag: string,
  choices: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (choices as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new UsageError(`${flag} takes ${choices.join(" or ")}, not "${String(value)}".`);
}

export function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export function table(rows: readonly (readonly string[])[], rightAligned: readonly number[] = []) {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          rightAligned.includes(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
