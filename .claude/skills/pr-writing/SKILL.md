---
name: pr-writing
description: Write a pull request for this repo — title, body, and the screenshots a visual change owes its reviewer. Use when opening a PR, rewriting a PR description, or when asked to "write a PR", "open a PR", or "update the PR description".
user_invocable: true
---

# Writing a pull request

The structure is Shopify's [Hydrogen PR template](https://github.com/Shopify/hydrogen/blob/main/.github/PULL_REQUEST_TEMPLATE.md), which asks three questions in an order that makes a reviewer's job possible. The voice is this repo's own: prose, not bullet soup.

## Before writing

Read the whole branch, not the last commit:

```bash
git diff main...HEAD
gh pr list --limit 5   # the titles here are the convention
```

A branch with six commits gets one description covering all six. `git log -1` will lie to you about the scope.

## Title

A sentence about what changed for the person using it. Start with a verb, give as much context as necessary and as little as possible, no trailing punctuation, under 72 characters.

This repo does not use conventional commits in PR titles. It joins two clauses with "and" when a change has two halves worth naming:

- Cut tile outlines from the sprite's own quad
- Weapons stop listing what they ask, and say how they sit in your hands
- Lay the house floors under its walls, and close the stair well

Name the outcome, not the patch. "Fix `pickInteractiveAt`" says nothing; "Picking asks one cell, and a cursor stops costing the whole map" says what a reader will notice.

## Body

Three questions, in this order, in prose:

1. **WHY are these changes introduced?** The problem, not the patch. Link the issue or the report. For anything large or complex, say why you chose this solution and what you weighed against it — start the discussion rather than waiting to be asked for it.
2. **WHAT is this pull request doing?** What was committed, and what a reader will see. Before/after screenshots for anything visual — see below.
3. **HOW to test your changes?** Enough for a reviewer to verify locally without asking you a question first.

Then, only when they apply:

- **`## Checked`** — what you actually verified, with numbers where there are numbers. Test counts, measured timings, what you tried by hand and what it did. This is the section that earns trust; an unverified claim costs more than an admitted gap.
- **`## Noticed, not touched`** — pre-existing problems you found and deliberately left. Say they are pre-existing.
- **Post-merge steps** — secrets to set, buckets to seed, a `pnpm reset` to run. Delete the heading when there are none.

Headings are for a body that needs them. A three-line fix is three lines of prose.

## Screenshots and visual changes

This is a renderer. If the change alters anything a player sees — sprites, lighting, labels, outlines, layout, the editor's chrome — the PR owes a picture, and a description without one is incomplete.

- **Before and after, not just after.** A single screenshot proves the new thing exists; the pair proves it is better. Same camera, same tile, same time of day, so the diff is the change and not the framing.
- **Alt text on every image**, describing what the screenshot shows. A reviewer on a phone, on a bad connection, or using a screen reader still has to be able to follow the argument.
- **Wrap gifs and videos in `<details>`.** They autoplay, and a page of looping motion is an accessibility problem for whoever is reviewing it.

```markdown
<details>
  <summary>Walking past a lantern, before and after</summary>
  <img src="..." alt="The lantern's light pops between two levels as the player walks past it">
</details>
```

For a performance change, the equivalent of a screenshot is the number: the profiler readout before and after, measured the same way at the same spot.

## Draft, always

Every PR opened from an agent session is created as a draft, without exception:

```bash
gh pr create --draft --title "..." --body "..."
```

Pushing to a branch whose PR is already open converts it back:

```bash
gh pr ready --undo
```

`gh pr edit --draft` does not exist. Never un-draft a PR — that is the author's call, made after they have read it.

## Pushing

Workflow files under `.github/workflows/` are rejected over HTTPS. Push with the SSH remote:

```bash
git push git@github.com:fredericoo/stapes.git <branch>:<branch>
```

## Never

- A non-draft PR
- A changelog of your commits — the body describes the change, not your afternoon
- Defensive framing: "I tried to", "this might not be perfect", "sorry if"
- Tables and diagrams on a small change
- A visual change with no picture
