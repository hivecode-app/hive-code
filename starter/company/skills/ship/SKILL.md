---
name: ship
description: Take a finished task from branch to merged in the agent company, and prepare a production GO request. Use when a task's code is ready - it covers commit, push, PR, independent review, CI, worker squash-merge, worktree cleanup, and the GO summary for production.
---

# Ship: from branch to merge, and from there to GO

Per the default charter in `company/company.md`. If the project has a deviation in its charter (`company/projects/<p>.md`), the deviation wins. A deviation that is not written does not exist.

## 1. Before the PR

- Work in the task's worktree (`<repo>/.worktrees/<task>`), on its own branch. Not on `main`. hq opens it in the charter's checkout, and the path appears in the task message.
- Run [verify](../verify/SKILL.md). No PR without verification.

## 2. Commit and PR

- Commit with a message that explains why, not only what. At the end of the message, the attribution line the harness gives.
- `git push -u origin <branch>`.
- `gh pr create` with a body in the owner's language: what changed, why, how it was verified, and what was not verified.
- **One task is one PR.** Content and data (question banks, catalogs, translations, assets, generated files) go in a separate commit, or in a separate PR if that is more convenient. The reviewer checks content by sampling and validation, not line by line.
- **A PR of more than about 1,000 lines of code** (excluding content): before review, check whether it mixes two things that do not depend on each other. If so, split it into two PRs. If not, leave it as it is.

## 3. Independent review

- `request_review(pr)` opens a reviewer in a clean context ([reviewer](../reviewer/SKILL.md)). If the tool does not exist yet, open a subagent in a clean context with the reviewer skill, without edit tools.
- **One round, fixes, and one narrow round** ([reviewer](../reviewer/SKILL.md#rounds-one-full-one-narrow)).
- **changes in the full review:** fix. A high or medium finding is fixed with a test that fails before the fix. Push, and ask for one narrow review on the diff of the fixes only.
- **A `### For a ticket` finding in the narrow review** (new, and not coming from the fixes): does not block. Open a ticket for it and link it in the PR.
- **changes in the narrow review:** there is no further round. Fix, add a test, wait for green CI, and write a comment on the PR with `fixed-after-narrow: <headRefOid>` and what was fixed.
- **New code after approval** (an extra feature, or a rebase with real conflicts): not a fix. It gets its own review of the new code, under the same rule.
- **approve:** continue.

## 4. CI and merge

- **The project's CI check** is the charter's `ci_check`: the name of the GitHub check a merge waits for.
- Wait for it until it finishes, then check that it passed on the PR's latest commit:
  ```bash
  gh pr checks <n> --watch --interval 20
  gh pr checks <n> --json name,state --jq '[.[] | select(.name == "<ci_check>")] | last | .state'   # must be SUCCESS
  ```
  - **FAILURE:** read the log (`gh run view <run> --log-failed`), fix, push, and wait again.
  - **No check by that name**, or it is stuck in pending for more than 15 minutes: do not merge. If CI runs on a local runner, it is probably down (`systemctl --user status` of the runner in the charter). Report to whoever sent the task.
  - **The charter says `ci: none`:** there is nothing to wait for. The review is the gate.
- **The worker merges by itself, only when the check is green:** `gh pr merge <n> --squash --delete-branch`.
- **Cleanup:** hq opened the task's worktree, and hq also closes it when the task closes (`status` with `state: "done"`). It saves uncommitted work to `refs/company/preserved/<task>` and removes without `--force`. Do not remove it yourself: it is the shift's cwd. A worktree you opened yourself (when you did not get one from hq) is removed the same way.
- What was learned goes into the project's memory (`remember`), and the task closes with a short summary.
- **"What to check":** if the task is still waiting for the owner, close it with `awaiting` and `awaiting_note` (one line in the owner's words) and `pr`: `deploy` when merged and waiting for GO or for a deploy, `check` when it is already in production and the owner needs to check something personally, `verify` when the owner needs to check before release (for example a build in TestFlight). `check` and `verify` show up for the owner immediately in the "Needs you" list with "Done" and "Failed". The team lead can mark or correct this in `close_team`, even after the task closed.

## 5. Production: the GO request

Deploy to production only after the owner's GO, unless the charter writes a deviation. The request is sent with `request_go`, in the owner's language, short, and read on the phone:

```
GO to production · <project> · <version or PR>
What goes in: <2–4 lines, in product terms>
Risk: <what can break, and who will feel it>
Rollback: <the command or the previous version, and how long it takes>
```

- **At night:** do not deploy without a written deviation. The request goes into "GO waiting" for the morning.
- After the deploy: check that the service answers, and that the project's probes pass (when they exist). Report in one line.
- **The deploy reports to hq** what went in: `POST /api/deploys` with `project`, `sha`, `target` and `prs` (PR numbers in the project's repo) or `tasks` (task ids). Tasks that waited for the deploy leave "What to check". The project calls this from its deploy script, or the worker reports manually after a deploy. A task that now needs checking in production moves to `check` in `close_team`.

## What we do not do

- Do not merge without approve (or `fixed-after-narrow` after the narrow review) and without a green `ci_check` on the latest commit.
- Do not push to `main` directly.
- Do not deploy "just a small fix" without GO.
