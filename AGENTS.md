# Stapes

A tile world you can walk around in and edit. Each tile is 8×8 pixels, drawn in
an oblique cabinet projection with Three.js.

## The shape of it

- **`server/` is one Bun process holding one world in memory.** `server/GameServer.ts`
  is the simulation; `server/world.ts` is the checkpoint loop, the alarm timer and
  the drain around it.
- **`app/` is a static bundle that runs in a tab.** There is no server rendering
  and no shared runtime — only shared *modules*, which is why `app/game/` and
  `app/lib/` are imported by both halves.
- **Exactly one process may hold the database.** `server/lock.ts` opens it with
  `PRAGMA locking_mode = EXCLUSIVE` so a second one fails at open. Two processes
  on one world persist a board blended from two timelines. Do not remove this to
  make a rolling deploy work.
- **Authored content lives in `data/`** and is copied into the store on deploy.
  The world being played prefers its own checkpoint, so writing content alone
  changes nothing anybody can see.

## Where things are written down

- **`docs/notes.md`** — the long notes: every subsystem, the decisions behind it,
  and the costs already measured. Read the relevant section before changing that
  subsystem, and add to it when you learn something the next person would repeat.
- **`.agents/skills/`** — skills that load on demand (renderer performance,
  React Router).
- **`.claude/skills/pull-request-standards/`** — how to write a PR description here.
- **`README.md`** — every script, and what it is for.

`CLAUDE.md` is a symlink to this file.

## No unit test reads `data/map.json`

`data/map.json` is the world being authored. It is edited constantly — from
the in-game editor as much as by hand — and every edit is a legitimate one. A
unit test that reads it turns "somebody moved the shopkeeper" or "somebody
roofed a building" into a red build that says nothing about the code, so the
test gets re-baselined until nobody trusts it.

**Build the scenario the test is about.** `app/lib/fixtureTown.ts` is the
stand-in world for anything that needs a whole map — a generated town at a
fixed scale, so the lighting budgets it backs stop drifting with the content.
For anything smaller, build the cells by hand: `emptyMap` plus `replaceStack`,
or a local `mapAt([...])` helper like the ones in `app/lib/lighting.test.ts`
and `app/lib/levelVisibility.test.ts`.

`data/tiles.json` is the opposite case and stays real. Heights,
`lightPassing`, per-frame emitter radii and interaction blocks are what these
subsystems reason about, and a fixture tile with an invented radius tests the
fixture. Keep the tile catalogue; build the geometry.

This covers claims about the shipped world too — "the shopkeeper is placed
somewhere", "the map is mostly static tiles". They read as safe because they
name no coordinate, and they still fail on an ordinary afternoon's authoring.
If a claim really is about the world we ship, it belongs in the Playwright run
against a real world, not in `vitest`.

## Say what you mean

This applies to everything written here: commit messages, PR titles and
descriptions, `docs/notes.md`, and code comments.

Mannered prose substitutes metaphor and flourish for direct statement. Instead
of "a parameter worth varying," the mannered writer produces "a dial worth
turning." Instead of "this point still matters," they write "this point earns
its keep." The phrases exist to display the writer, not to convey the idea, and
readers can tell. That is why mannered prose irritates: it makes the reader work
harder so the writer can perform. It is also imprecise. Metaphors drag in
connotations the writer did not choose and cannot control. The fix is to say
what you mean. When a literal phrase is available, use it.

## A commit is one revert, and a PR title is the commit main keeps

Every PR here is squash-merged, so the PR title *is* the commit message on
`main` — permanently, and it is the only line anybody bisecting, skimming
`git log`, or writing release notes will ever read. Branch commits are for the
reviewer; the PR title is for everybody who comes after.

### A task is finished when there is a draft PR

Green tests on a local branch are not a delivered change. **Every task ends in
a pull request, and every pull request opens as a draft** — `gh pr create
--draft`, no exceptions, however small or however certain the change. Then hand
back the URL and stop. Marking a PR ready asks a reviewer to spend time on it,
and only the author should decide when to ask.

Pushing agent work to a branch whose PR is already marked ready leaves
unreviewed changes under that label, so convert it back: `gh pr ready --undo`.
There is no `--draft` flag on `gh pr edit`; it fails after the push has landed,
and the PR stays marked ready.

The description is a different document with its own rules — see the
`pull-request-standards` skill in `.claude/skills/`.

### Commit messages

Conventional commits, `type(scope): summary`:

- **Types**: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`,
  `build`, `ci`.
- **Scope** is optional and is the part of the system that changed, not the
  directory: `server`, `renderer`, `combat`, `magic`, `content`, `map`,
  `editor`, `deploy`.
- **Summary** is imperative, lowercase, no trailing period, under ~72
  characters.

**Name the mechanism, in the words the codebase uses.** The summary line has
one job: somebody reading only that line should know which part of the system
changed and what it now does. Use the real names — `perception`, `brainRuntime`,
`equipment`, `WorldStore` — not a description of the resulting experience.

```
feat(brain): add a hearing sense to creature perception   # good
feat(equipment): require two free hands to swing a greatsword
fix(combat): stop counting a shield as a weapon

A wolf comes when it hears something                      # narrates, does not say what changed
feat(brain): improve creature behaviour                   # says nothing
fix(combat): fix bug in combat                            # says less than nothing
```

**The evocative version goes in the body, never on the first line.** It is good
context — it is often the clearest statement of *why* the change exists — but it
belongs under the summary, or in the PR description, where there is room for it:

```
feat(brain): add a hearing sense to creature perception

A wolf now comes when it hears something. Sight alone made every creature
trivially avoidable: break line of sight and it forgot you existed. Hearing
gives it a second input that walls do not block, so retreating around a corner
buys you distance rather than safety.
```

**The body carries the why and the how.** State the problem that made the
change necessary, the decision you made, and anything in the diff that will
look wrong to somebody reading it cold — a constant that seems arbitrary, an
approach you rejected, a workaround that exists for a reason. Leave the body
off only when the summary genuinely is the whole story.

### One commit per reversible unit of work

The test is mechanical: **`git revert` of that one commit must leave the tree
working and the story coherent.** Nothing else in the commit should have to
come along with it, and nothing missing should break it.

- A rename across forty files is one commit. The rename plus the behaviour
  change it made possible is two.
- A drive-by fix or a formatting pass in code you were already touching gets
  its own commit, so a reviewer can skip it and a revert of your feature does
  not silently take it back out.
- Work that is only meaningful together — a new field, its migration, and the
  call site that reads it — is one commit, because splitting it means one of
  the pieces is a commit that does not run.

**Commits describe the change, never the process of arriving at it.** These are
the ones that keep appearing and are always wrong:

```
address PR feedback          # fold it into the commit it fixes (git commit --fixup + rebase -i --autosquash)
fix tests                    # if the tests were red, the commit that broke them was not finished
phase 2: wire up the store   # the plan is not the history; name what changed
wip / checkpoint / cleanup   # squash it away before the PR is opened
```

Rewriting your own branch to get there is expected and cheap — nobody has
pulled it. A branch whose history is six honest commits reviews far better than
one with twenty that retell your afternoon.

### PR titles

The same grammar, one level up: a PR title is the conventional-commit summary
for the *whole* branch. Same types, same scope, same imperative voice, same
rule that it names the mechanism rather than the experience.

If you cannot write one summary that covers the branch, the branch is doing
more than one thing, and the honest fix is two PRs.
`feat(magic): add arcane stones and the casting they unlock` is a PR;
`feat: stones, plus a shield fix, plus a rename` is a queue.

The flavour still has a home — it is the first line of the PR description, where
the reviewer reads it with the diff in front of them. It is not the title.

The PR *description* is a different document with its own rules — see the
`pull-request-standards` skill in `.claude/skills/`.

**A note on the existing history.** Most of what is on `main` is narrative prose
with no type prefix — `A wolf comes when it hears something`,
`Both hands swing, and shields stop being weapons` — from before this section
existed. That is exactly what this section is moving away from: the lines read
well and tell you nothing about which code moved. They are not being rewritten,
so expect the log to look mixed for a while. Do not copy them.
