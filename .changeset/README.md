# Changesets

Every pull request adds one file here, written for players: it becomes a line in `CHANGELOG.md`, on the GitHub Release and in the Discord post when the next release ships.

```bash
bunx changeset add
```

Pick `minor` for something new a player can do or see, `patch` for a fix or a change to something that already exists. Write one or two plain sentences in the second person about what changed in the game, not in the code:

```md
---
"the-last-stones": minor
---

Wolves now hear you as well as see you, so breaking line of sight no longer shakes them off.
```

A pull request a player cannot notice — bots, tooling, tests, docs, a refactor — adds an empty changeset instead, which says so on purpose:

```bash
bunx changeset add --empty
```
