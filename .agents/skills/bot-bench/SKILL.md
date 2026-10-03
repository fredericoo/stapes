---
name: bot-bench
description: >
  Benches a branch's bots against origin/main with `bun run bench:bots` and
  puts the comparison table in the PR description. Use whenever a change
  touches bots/**, or the odds and combat code bots reason with
  (app/game/combatMetrics.ts, app/lib/battler.ts, app/lib/brain.ts,
  app/lib/conditions.ts), or when asked whether a bot change made bots
  better or worse.
---

# Bot bench

A bot change is judged by how bots play, not by whether its tests pass. Every
PR that changes bot behaviour carries a bench of the branch against
`origin/main`.

## When

Run it when the diff touches:

- anything under `bots/`
- the odds and combat code the bots read: `app/game/combatMetrics.ts`,
  `app/lib/battler.ts`, `app/lib/brain.ts`, `app/lib/conditions.ts`

A change that only edits tests, logs or docs there needs no bench.

## How

Commit first: B is a commit, not the working tree.

```sh
git fetch origin
BUN_OPTIONS= bun run bench:bots --b HEAD
```

- `--a` defaults to `origin/main`, `--b` to `HEAD`. Either takes any ref,
  including a PR fetched with `git fetch origin pull/<n>/head:refs/bench/pr-<n>`.
- `--bots 6 --hours 1 --seeds 8` are the defaults. Each seed is one run of
  each version, and `--jobs` (one fewer than the cores) run at once. A run of
  six bots for a game-hour took about 55 minutes with eleven at once on a
  12-core Mac, so the defaults take about two hours: run it in the
  background and write the table to a file.
- Empty `BUN_OPTIONS` so `--smol`, if your shell sets it, does not slow every
  run.
- Progress goes to stderr; the table is the only thing on stdout, so
  `> bench.md` keeps it.

Paste the table into the PR description under a `## Bench` heading, with the
command line that produced it.

## Reading it

Each row is one metric. The A and B columns are the mean over seeds with a
95% interval; `B−A` is the mean of the per-seed differences, with its own 95%
interval. The same seed gives both versions the same bots with the same
temperaments, so the difference is paired and much tighter than the two
intervals beside it suggest.

- **significant: yes** means the `B−A` interval leaves out zero. Say which
  rows moved and in which direction, and whether that was the PR's intent.
- **significant: no** is not "no effect", only "not shown at this many
  seeds". If the PR claims an effect that is not significant, run more seeds
  (`--seeds 16`) or longer (`--hours 2`) before claiming it.
- Eight metrics are tested at once, so at 95% one of them comes up
  significant by chance about a third of the time. A lone significant row the
  change has no reason to move is weak evidence; rerun with more seeds.
- Gold, gear worth and top mastery are where bots end, so they need hours to
  separate; deaths and kills per hour separate sooner.

## What it measures

- **deaths/h**, **kills/h** — per bot-hour, counted in the server's `kill`,
  so both versions are counted the same way whatever their bots log. Kills
  are of anything but another bench bot.
- **gold** — the currency a bot carries at the end.
- **gear worth** — `gearWorth` summed over what it wears at the end, measured
  by the checkout you run from, not by either version.
- **top mastery** — its highest mastery level at the end.
- **time recovering %** — share of time `Bot.recovering` was set.
- **bag walks made/h**, **abandoned/h** — `go_to` goals at the planner's
  `lostKitAt` that ended `done`, and ones that ended `failed`, in a death or
  under another goal.
