# Conventions

## Language

- Every message to the owner is in his or her language (`owner_language` in `company/org.yaml`, set from the app's language). Code, commits and identifiers can be in English.

## git

- A worktree per task: `<repo>/.worktrees/<task>`, on a new branch. hq opens it and removes it.
- Merge: `gh pr merge --squash --delete-branch`, after independent review and CI, unless the charter says otherwise.
- Closing a worktree without `--force`. What was not saved goes to `refs/company/preserved/<task>`.
- Night queue labels: `company:night`, priority `p0`–`p3`, and `needs-decision`.

## State and files

- **Do not keep state in `/tmp`.** It is wiped on boot. The company's state: `~/.local/state/agent-company/`.
- Secrets do not go into the repo or into memory.

## Time

- The company's timezone is `timezone` in `company/org.yaml`. It is the only source for the time.
- Dates are written DD/MM/YYYY.
- Time estimates in hours, at agent pace.

## Interface

- Symbols, not colours. Icons from one set, Material Symbols, no emoji.
