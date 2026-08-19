---
name: pull-request-standards
description: >
  Writes clear PR descriptions for contributors of this repository. Always use when creating or
  updating pull request descriptions.
---

# Stapes PR Descriptions

Write functional PR descriptions that help reviewers quickly understand the change, intent, and impact.

Copied from [Shopify Hydrogen's `pull-request-standards` skill](https://github.com/Shopify/hydrogen/blob/preview/skills/pull-request-standards/SKILL.md) (MIT), minus its `Versioning` section, which is about changesets for a published package.

## Style

- Use short paragraphs, clear headlines, and bullets.
- Write in understandable, simple language. Avoid complex jargon and explain in the simplest possible way
- Use **bold** only for important emphasis.
- Be specific and concise.
- Do not be punchy, sassy, commercial, or launch-y.
- Do not include the whole diff.
- Highlight only what this PR touches.
- The first section is the **Why** of the PR and does not need a title.
- Mention any issues closed by the PR at the beginning.

## Before Writing

Identify the intent behind the pull request via:

- **Conversation context**: the user request, issue, spec, linked PRs, review thread, or task notes that explain why the work exists.
- **Diff** between the branch this PR is merging into and this PR.
- **Why**: the problem, drift, missing source of truth, or developer pain.
- **Developer impact**: public APIs, exports, examples, skills, docs, generated types, or migration work.
- **UX impact**: routes, buttons, UI states, forms, navigation, copy, loading states, or accessibility behavior.
- **Before/after**: the smallest useful old/new code or behavior comparison.
- **Manual testing**: the exact human workflow that proves the behavior works.
- **Boundaries and risk**: what was intentionally left out, known tradeoffs, or follow-up work deferred to later PRs.

## Template

Use only the sections that apply:

```md
Closes #[number]

TL;DR: [Short explanation of the problem and intent.]

## Before

[Short code snippet or behavior summary showing the previous state.]

## After

[Short code snippet or behavior summary showing the new state.]

## What this changes

- [Concrete change]
- [Concrete change]

## Developer impact

[Only if library users, examples, public exports, skills, types, or migration paths change.]

## UX impact

[Only if UI, routes, forms, buttons, navigation, loading states, copy, or accessibility behavior changes. Include screenshots or recordings — see Screenshots.]

## Out of scope

[Only if there are intentional boundaries, known tradeoffs, or risks reviewers should know about.]

**Out of scope**
- [What this PR deliberately does not address]


## Risk

- [What could break, what we are accepting as a tradeoff, or what needs extra scrutiny]

## How to Test

[Human-facing manual steps. Include setup, folder changes, dev server commands, environment assumptions, and behavior to verify.]
```

Do not include categories that do not apply.

## Rules

- Never assume the reader will have full context of the situation
- Prefer **source-of-truth** framing when the PR aligns server handlers, examples, generated types, or agent skills.
- Use conversation context to recover intent; the diff usually shows what changed, not why it changed.
- If the why is not clear from the diff, issue, spec, linked PRs, review thread, or current conversation, ask the user before drafting.
- Use before/after snippets for API and example migrations.
- Keep snippets short and focused on the changed contract.
- Separate developer-facing impact from implementation details.
- Include UX impact for any visible route, UI, navigation, or interaction change.
- Call out direct public entrypoint changes separately from internal refactors.
- Do not use linting, unit tests, integration tests, typechecks, or CI as `How to Test`.
- If there is no meaningful manual behavior to test, omit `How to Test`.
- `Out of scope` names what this PR does not try to solve. It is not a roadmap.
- `Risk` names what could go wrong, what we are knowingly accepting, or what deserves extra reviewer attention.

## Screenshots

If the change is visual, include screenshots or recordings to illustrate it.

- Show before **and** after, framed the same way, so the difference is the change and not the framing.
- Give every image alt text describing what it shows.
- Wrap gifs and videos in `<details>`. They autoplay, and looping motion is an accessibility problem for whoever is reviewing.

```md
<details>
  <summary>Walking past a lantern, before and after</summary>
  <img src="..." alt="The lantern's light pops between two levels as the player walks past it">
</details>
```

### Getting an image into the body

GitHub's upload endpoint is part of its web editor, not part of the API `gh`
drives, so there is no flag that attaches a file. The
[`gh image`](https://github.com/drogers0/gh-image) extension borrows the
browser's GitHub session to reach it, and prints the markdown to paste:

```sh
gh extension install drogers0/gh-image   # once
gh image shot-before.png shot-after.png  # prints ![shot-before.png](https://github.com/user-attachments/…)
```

**A `user-attachments` URL 404s to anything without a session, and that is not a
failed upload.** This repository is private, so its attachments are readable only
by somebody signed in and allowed to see it — which is every reviewer, in a
browser, and no `curl`. Checking one from a shell and concluding the upload broke
costs more time than the upload did.

### Capturing the files

Screenshots have to exist on disk before any of the above. Agent browser tooling
generally hands an image back to the conversation rather than writing a file, so
reach for Playwright, which is already a dev dependency:

```js
const page = await browser.newPage();
await page.goto("http://localhost:5173/play");
await page.locator("aside").screenshot({ path: "shot-before.png" });
```

Shooting a **locator** rather than the page is what makes a before/after pair
comparable: the same element is the same size in both, so the only difference
left is the change. Set `deviceScaleFactor: 2` — this game is pixel art, and a
1× capture of it is mush.

## Manual Testing

`How to Test` is for local manual verification by a human. Assume a MacBook unless told otherwise.

Include every step needed to exercise the behavior:

This is an example of the level of detail expected. Do not force every PR into this exact flow.

```md
## How to Test

1. Run `pnpm install` to install dependencies.
2. Run `pnpm dev` to start the dev server.
3. Open `http://localhost:5173/play`.
4. Hold shift and hover a wall tile.
5. Confirm the tile is outlined in blue and named in a label above it.
6. Release shift and walk into the wall.
7. Confirm the outline is gone and the player does not pass through.
```

## Anti-Patterns

- Do not write only a diff summary.
- Do not include headings that do not apply.
- Do not hide developer or UX impact in implementation bullets.
- Do not describe unrelated future work in `What this changes`. Use `Out of scope` only for boundaries of this PR.
- Do not use `pnpm typecheck`, unit tests, or CI as manual testing instructions.
- Do not over-explain code that TypeScript or the diff already makes obvious.
- Do not ship a visual change without a screenshot or recording.
