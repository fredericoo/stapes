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
