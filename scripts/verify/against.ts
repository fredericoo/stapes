import { existsSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { percent, table, UsageError } from "./cli";

const ROOT = join(import.meta.dir, "../..");

const ENVELOPE = new Set(["command", "commit", "dirty", "seed"]);

function git(args: readonly string[]) {
  const run = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  return { ok: run.exitCode === 0, out: run.stdout.toString().trim(), err: run.stderr.toString() };
}

/**
 * Looks for an installed package rather than for the folder, because vitest
 * keeps its cache in a `node_modules/.vite` of its own inside a worktree that
 * has no install.
 */
function nodeModules(): string {
  for (let dir = ROOT; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules/valibot"))) return join(dir, "node_modules");
    if (dirname(dir) === dir) {
      throw new Error("No node_modules above this checkout; run bun install.");
    }
  }
}

export type Baseline = {
  ref: string;
  commit: string;
  dependenciesDiffer: boolean;
  report: Record<string, unknown>;
};

/**
 * Runs `bun scripts/verify.ts <args> --json` on `ref`, in a temporary worktree
 * that borrows this checkout's node_modules through a symlink. The link is
 * removed by itself before the worktree is, so nothing that deletes the
 * worktree can reach through it into the real node_modules.
 */
export function runAgainst(ref: string, args: readonly string[]): Baseline {
  const resolved = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!resolved.ok) throw new UsageError(`--against: "${ref}" is not a commit in this repository.`);
  const commit = git(["rev-parse", "--short", resolved.out]).out;
  const modules = nodeModules();

  const scratch = mkdtempSync(join(tmpdir(), "stapes-verify-"));
  const tree = join(scratch, "tree");
  const link = join(tree, "node_modules");
  const added = git(["worktree", "add", "--detach", tree, resolved.out]);
  if (!added.ok) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(`git worktree add failed: ${added.err.trim()}`);
  }
  try {
    symlinkSync(modules, link, "dir");
    const run = Bun.spawnSync([process.execPath, "scripts/verify.ts", ...args, "--json"], {
      cwd: tree,
    });
    let report: Record<string, unknown>;
    try {
      report = JSON.parse(run.stdout.toString()) as Record<string, unknown>;
    } catch {
      const said = run.stderr.toString().trim().split("\n").slice(-3).join(" ");
      throw new UsageError(`--against: ${ref} (${commit}) could not run verify: ${said}`);
    }
    if (typeof report.error === "string") {
      throw new UsageError(`--against: on ${ref} (${commit}), ${report.error}`);
    }
    const sameDependencies = git([
      "diff",
      "--quiet",
      resolved.out,
      "--",
      "package.json",
      "bun.lock",
    ]);
    return {
      ref,
      commit,
      dependenciesDiffer: !sameDependencies.ok,
      report: Object.fromEntries(Object.entries(report).filter(([key]) => !ENVELOPE.has(key))),
    };
  } finally {
    if (existsSync(link)) unlinkSync(link);
    git(["worktree", "remove", "--force", tree]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function keyOf(item: unknown): string | null {
  if (typeof item !== "object" || item === null) return null;
  const key = (item as { key?: unknown }).key;
  return typeof key === "string" ? key : null;
}

/**
 * A list item is named by its `key` where it has one, so a hand or a creature
 * is matched by name rather than by where it falls in the list.
 */
function figures(value: unknown, path: string, out: Map<string, number>) {
  if (typeof value === "number") {
    out.set(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => figures(item, `${path}[${keyOf(item) ?? i}]`, out));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key !== "key") figures(item, path ? `${path}.${key}` : key, out);
    }
  }
}

export type Change = {
  figure: string;
  base: number | null;
  now: number | null;
  change: number | null;
};

export function changes(base: Record<string, unknown>, now: Record<string, unknown>) {
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  figures(base, "", before);
  figures(now, "", after);
  const changed: Change[] = [];
  let unchanged = 0;
  for (const figure of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(figure) ?? null;
    const is = after.get(figure) ?? null;
    if (was !== null && is !== null && was === is) {
      unchanged++;
      continue;
    }
    const change = was !== null && is !== null ? Math.round((is - was) * 1e6) / 1e6 : null;
    changed.push({ figure, base: was, now: is, change });
  }
  return { changed, unchanged };
}

const FRACTIONS =
  /(^|\.)(share|low|high|hit|missed|dodged|absorbed)$|(^|\.)(statusUptime|loadouts)\./;

function shown(figure: string, value: number | null): string {
  if (value === null) return "absent";
  if (FRACTIONS.test(figure)) return percent(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function signed(figure: string, change: number | null): string {
  if (change === null) return "";
  const fraction = FRACTIONS.test(figure);
  let digits = fraction
    ? (change * 100).toFixed(1)
    : change.toFixed(Number.isInteger(change) ? 0 : 2);
  if (Number(digits) === 0) digits = digits.replace("-", "");
  else if (Number(digits) > 0) digits = `+${digits}`;
  return fraction ? `${digits} pts` : digits;
}

export function changesText(baseline: Baseline, found: ReturnType<typeof changes>): string {
  const title = `change against ${baseline.ref} (${baseline.commit})`;
  const note = baseline.dependenciesDiffer
    ? `\npackage.json or bun.lock differ on ${baseline.ref}; it ran with this checkout's node_modules.`
    : "";
  if (found.changed.length === 0) {
    return `${title}: all ${found.unchanged} figures are the same.${note}`;
  }
  const rows = found.changed.map(({ figure, base, now, change }) => [
    figure,
    shown(figure, base),
    shown(figure, now),
    signed(figure, change),
  ]);
  return `${title}: ${found.changed.length} figures changed, ${found.unchanged} did not.${note}\n\n${table(
    [["figure", baseline.ref, "now", "change"], ...rows],
    [1, 2, 3],
  )}`;
}
