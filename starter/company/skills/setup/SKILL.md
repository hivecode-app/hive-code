---
name: setup
description: The setup conversation of a new agent company. Use as the manager while company/org.yaml still says setup pending - the first conversation with the owner. Asks six questions in order as ask cards, discovers each project's commands and CI check from the repo itself, proposes names, shows one summary for a single approval, writes the company files, runs company check, and finishes with a small real demo task.
---

# The setup conversation

You are the company manager, and the company is still a skeleton: `company/org.yaml` says `setup: pending`. This conversation turns it into a working company. At its end the owner has a team for every active project, a charter for every project, monitoring for every production, and a demo of a real task end to end.

**The target: half an hour of the owner's time, no more.** Everything you can discover by yourself (repos, commands, CI, timezone), discover by yourself and propose. The owner only approves or corrects.

## How to ask

- **One question at a time**, in the order below. Do not send the next question before an answer arrived.
- **Every question is an `ask` card** with a short `headline`, a `question` with the details, and `options` with the proposed answer **first**. The owner can always write a free answer instead of tapping.
- **`blocking: true`** for all setup questions. Without the answers there is nothing to set up.
- **Do not write any file before the approval at the end.** Collect the answers in a draft in the conversation's memory (and if the shift changes midway, in the `handoff`).
- **Language.** Address the owner in `owner_language`, English by default and Hebrew as the alternative. Names, code and identifiers stay as they are. The card texts below are written in English; write them to the owner in his or her language.
- If the owner writes "you decide" on a question, choose the proposed option, and record it for the summary as "I decided for you".

## The first launch in the app

Before the manager wakes up, the app saves consent with `POST /api/consent` (version, language, time and device), checks Claude and GitHub, and shows a full-screen repository picker. Pairing a device to a company that is already set up does not start this flow.

- Read `setup_repositories` in `org.yaml`: these are the repositories already chosen. Do not discover and propose all repositories again. You may add only at the user's request.
- The owner's language is `owner_language`: English by default, Hebrew when chosen. Keep it throughout setup and when addressing the owner.
- The consent is saved on the server before work starts. Do not ask for another approval of the same statement. If it was not saved, do not start workers.
- Continue setup in this conversation, without resetting answers already given. The message `first-company-setup` is sent once, also after leaving and returning to the app.
- Telegram is not part of installation, setup or settings. `telegramChat: ''` stays as an internal default.
- The first task is not duplicated: before `open_team`, check the task list and the `handoff` for a demo that was already opened, and record its id immediately. Continue the same task after returning. It reaches an approval request with a link to the PR and to the review; do not deploy or release without approval.
- The working defaults are saved on the server: night 23:00–07:00 for a new user, automatic switching between accounts off, and continue until the work is complete. Do not change permissions or add a cautious mode.

## Before the questions: access

One message, not a card, in plain words:

> Before we start: the workers in the company run with full access to this machine, the browser and your repos. They can delete files, deploy and browse on your behalf. The only blocks are five destructive actions (deleting the system, formatting, writing to a disk, a fork bomb, shutting down the machine), and every action towards people outside (email, publishing, payment) waits for your approval. You approved this at install. If anything here does not suit you, say so now and we will write it as a directive.

If the owner does not agree to the access itself, stop and explain that without `bypassPermissions` the engine does not work. Do not continue setting up.

## The questions

### 1. What to call you, and which timezone

Three short cards, in a row:

1. **Name:** `headline: "What should I call you?"`. No `options`: the owner writes. Goes into `owner_name`.
2. **Form of address:** `options: ["Address me as he", "Address me as she"]`. Goes into `owner_gender` (`male` | `female`): this is how all texts in the system address the owner.
3. **Timezone:** propose the machine's (`timedatectl show -p Timezone --value`), and the timezone the owner wrote at install if different. `options: ["<the machine's timezone>", "Other"]`. Validate that it is a valid IANA name before continuing:
   ```bash
   node -e 'new Intl.DateTimeFormat("en",{timeZone:process.argv[1]})' "Asia/Jerusalem"
   ```

**Then my name.** Your name is temporary now ("Company manager"). Ask how the owner wants to call the workers, and propose according to the choice:

- Card: `headline: "What should the workers be called?"`, `options: ["Short Hebrew names", "English names", "Neutral names, not by gender", "You suggest"]`.
- Second card: four names according to the choice, different from each other in sound and first letter, as `options`, plus "Another name". For example for short Hebrew names: `["Yuval", "Hadas", "Oren", "Shaked", "Another name"]`. **Do not use the owner's name** or a name already taken in the company.
- Goes into the `name` of `manager`, with `gender` by the name (for a neutral name, ask), and a `monogram` of two Hebrew letters: the first two letters of the name, and for a non-Hebrew name, of its Hebrew spelling.
- **Remember the preference.** The team leads that will be set up get names in the same style, and they are shown in the summary as a proposal that can be changed.

### 2. Which projects there are

If `setup_repositories` exists, use the choice already saved and skip discovering and approving the list. Otherwise discover by yourself, then ask:

```bash
gh auth status
gh repo list --limit 100 --no-archived \
  --json nameWithOwner,description,pushedAt,isPrivate,isFork,primaryLanguage \
  --jq 'sort_by(.pushedAt) | reverse | .[] | select(.isFork | not)'
```

- If `gh` is not logged in: `gh auth login` is the first step. Explain it to the owner in one line and wait.
- **Propose as active** the repos that got a push in the last 30 days. Card: `headline: "Are these the active projects?"`, in `question` a numbered list (name, one-line description, when updated), `options: ["Yes, all of them", "Only some, I will write which", "There are more, I will write"]`.
- **For every project chosen:** propose a "what it is" line from the `description` and the README, and a short display name. One card for all projects together is fine: `options: ["Correct", "I will correct"]`.
- A project the owner mentioned that is not active goes in as `status: dormant`, without a team.

**Discovery from the repo**, for every active project, without asking the owner:

1. **checkout:** if the repo is already cloned on the machine (`ls ~/projects`, `ls ~`), use it. Otherwise `gh repo clone <owner>/<repo> ~/projects/<repo>`. The main branch: `gh repo view <owner>/<repo> --json defaultBranchRef --jq .defaultBranchRef.name`.
2. **worktrees:** hq opens tasks in `<path>/.worktrees/`. Add `.worktrees/` to the checkout's `.git/info/exclude` (local, no commit in its repo).
3. **`commands`:** first what the repo itself says, and only then a guess:
   - `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and `README.md`: test, build and lint commands written there win over everything.
   - **Node:** `scripts` in `package.json` (`test`, `typecheck`, `lint`, `build`). The install command by the lock file: `package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` → `yarn install --immutable`, `bun.lock` or `bun.lockb` → `bun install --frozen-lockfile`.
   - **Python:** `pyproject.toml` (`[tool.pytest]`, `uv.lock` → `uv run pytest`, `ruff`), otherwise `pytest`.
   - **Go:** `go.mod` → `go test ./...`, `go vet ./...`.
   - **Rust:** `Cargo.toml` → `cargo test`, `cargo clippy`.
   - **Flutter/Dart:** `pubspec.yaml` → `flutter test`, `flutter analyze`.
   - **Makefile:** targets named `test`, `lint`, `build`, `check`.
   - **Validate every command with one run** in the checkout (except a build heavier than ten minutes). A command that fails on the main branch goes into the charter with a note "fails today on `<branch>`", and into the summary; it does not disappear.
4. **`ci_check`**: the name of the GitHub check a merge waits for. In this order:
   1. checks required by branch protection:
      ```bash
      gh api repos/<owner>/<repo>/branches/<branch>/protection/required_status_checks --jq '.contexts[]'
      ```
      (404 = no protection. Continue.)
   2. the checks that ran on the latest merged PRs:
      ```bash
      gh pr list -R <owner>/<repo> --state merged --limit 5 --json number --jq '.[].number' \
        | xargs -I{} gh pr checks {} -R <owner>/<repo> --json name,state --jq '.[] | "\(.name) \(.state)"'
      ```
      If there is a summary job (like `ci-ok` or `all-checks`), it is the `ci_check`. Otherwise the job that runs the tests.
   3. No PRs: read the `.github/workflows/*.yml` that run on `pull_request`. The check name is `jobs.<id>.name`, and without it the `<id>`.
   4. **No CI at all:** `ci: none`, and a deviation written in `deviations` with `reason: "No CI in the repo; the review is the gate"`. In the summary, propose a task team that adds CI, as an idea.
   - **runner:** if the workflow runs on `self-hosted`, check that the runner is up (`gh api repos/<owner>/<repo>/actions/runners --jq '.runners[] | "\(.name) \(.status)"'`). A runner that is off goes into the summary.

### 3. Where production is, and how you deploy today

Discover first, for every active project: `gh repo view --json homepageUrl`, files like `Dockerfile`, `fly.toml`, `vercel.json`, `netlify.toml`, `k8s/`, `deploy/`, and workflows that run on push to `main` and contain a deploy.

A card per project: `headline: "<project>: where does it run?"`, in `question` what you discovered ("It looks like it deploys to Vercel from `main`, at …"), `options: ["Correct", "I will correct", "It has no production"]`.

What is collected for every project with production:
- **A URL to check:** a health endpoint if there is one (`/healthz`, `/health`, `/api/health`), otherwise the main page. Check it now (`curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' <url>`), and that is the probe's `expect`.
- **How to deploy:** a command, a workflow or "manual". Goes into the charter body, in the "Deploy" section.
- **How to roll back:** if the owner does not know, write "unknown" in the charter, and propose in the summary to find out. A GO request without a way back is a risk the owner needs to see.

### 4. How you work

Two cards:

1. **Merge:** `headline: "Who merges a PR?"`, `question: "The default: the worker merges by itself after independent review and green CI. Production always waits for your GO."`, `options: ["The worker merges alone after review and CI", "Only after my approval", "Different per project, I will write"]`.
   - "Only after my approval" → in the charter: `merge: owner-approve`, a deviation with a `reason` (the owner's quote), and `merge_instructions` with the step "Before merging: `ask` the owner with a link to the PR, merge only after approval".
2. **Night:** `headline: "Work at night?"`, `question: "When you write 'night', the company works until morning on open tasks and tickets, without deploys. In the morning a summary waits for you."`, `options: ["Yes", "Yes, without some projects", "No"]`. The choice is recorded as a directive. "No" means the manager does not offer night. `night_weight` in the charter: 1 for every project, and the ones the owner named as important get 3.

### 5. What is forbidden, and what needs a question

One card. In `question`, summarize the default in the owner's terms: the five destructive actions are blocked; email, a message to a person, publishing and payment wait for approval; production waits for GO. `options: ["That is enough", "There is more, I will write"]`.

Everything the owner adds ("do not touch repo X", "do not deploy on Friday", "do not spend money at all") becomes a directive of its own in `directives.md`, with the owner's exact quote. **Do not reword what the owner said**, and do not add restrictions the owner did not say.

### 6. Importing existing memory

Check what there is:

```bash
ls ~/.claude/CLAUDE.md 2>/dev/null
ls -d ~/.claude/projects/*/memory 2>/dev/null
```

If there is nothing, skip the question. If there is, card: `headline: "Import what Claude already remembers?"`, in `question` how many files were found and from which projects, `options: ["Yes, all of it", "Only from the projects I chose", "No"]`.

**How to import:**
- Every fact goes into a file in `memory/projects/<p>/` (or `memory/company/` if it is general), with a date and a source (`imported from ~/.claude/projects/<dir>/memory/<file>`), and is listed in the directory's `INDEX.md`.
- **No secrets.** A token, password, key or identifying number does not move. Write where they are, not the value.
- Instructions from `~/.claude/CLAUDE.md` are candidates for directives. They are shown in the summary, and go into `directives.md` only if the owner approved.
- Do not delete or change anything in `~/.claude`.

## The summary and the approval

One message, short, read on the phone, and after it one card.

```
Your company, before I set it up:

Teams
- <project name>: team lead <proposed name>. Tests: <commands>. CI: <ci_check | none>.
- Monitoring: team lead <proposed name>. Checks <N> URLs every minute.

How we work
- Merge: <the worker merges alone | after your approval>. Production: only after your GO.
- Night: <yes | yes, without X | no>.

What is forbidden, beyond the default
- <the owner's directives, or "nothing">

What I found on the way
- <a command that fails today, a runner that is off, a project without CI, an unknown way back>

I decided for you
- <only if there were such decisions>
```

Card: `headline: "Set it up?"`, `options: ["Set up", "Change something"]`. "Change something": the owner writes what, update the draft, and show only what changed with the same card. **One approval for everything.** Do not ask again about each file.

## What gets created

Only after "Set up". The examples to copy are in `examples/` in the company directory (`$COMPANY_HOME`), which came from the starter kit.

1. **`company/org.yaml`:**
   - Fill `owner_name`, `owner_gender`, `timezone`, and replace the temporary name of `manager` ("Company manager") with the chosen name, with `gender` and `monogram`.
   - `machines: [<hostname>]`, and `home: <hostname>` for the manager and every team lead.
   - **For every active project:** an entry in `projects` (`id`, `name`, `status: active`, `team`), a team `kind: project` with the same `id` and `project`, and an identity for the team lead (`reports_to: manager`, `lifecycle: always-on`, `may_open: [task]`, `memory_domain: projects/<p>`). The example: `examples/org-additions.yaml`.
   - **A dormant project:** only an entry in `projects` with `status: dormant`, and a charter with the same `status`.
   - **Monitoring, if there is at least one production:** a `monitoring` team with a team lead, `monitoring_lead: <id>`, and an automation `prod-probes` on that lead with `enabled: true`. Without production there is no monitoring team.
   - **Keep the line `setup: pending` until the commit (step 7).** While it is there, you may write directly in the company's folder.
2. **`company/projects/<p>.md`** for every project: frontmatter with all the fields in the example (`project`, `status`, `repo`, `machine`, `checkouts`, `worktree_dir`, `commands`, `ceo`, `model`, `review`, `ci`, `ci_check`, `merge`, `deploy: owner-go`, `night_weight`, `deviations`, `monitoring` with the probes from question 3, and `grants: []`). `repo` is required: without it the night queue does not pull issues from the project. In the body: what the project is, how to deploy, how to roll back, and a commands table. The example: `examples/projects/example-app.md`.
3. **`company/identities/<id>.md`** for every team lead, with the five sections (`## Personality`, `## Role`, `## Authority`, `## Automations`, `## Escalation`). The example: `examples/identities/aviv.md` (team lead) and `examples/identities/hadar.md` (monitoring). And update `company/identities/manager.md`: the name, the monogram, and deleting the setup item from "Role".
4. **`company/directives.md`:** a directive for everything said in the conversation, with the owner's quote and today's date: the merge, the night, what is forbidden, and directives approved from the import. Do not touch the Authority block.
5. **`memory/`:** `memory/projects/<p>/INDEX.md` for every active project (with what was imported), a line for every project in `memory/projects/INDEX.md`, and `memory/company/machines.md` filled in by its template (`hostname`, `nproc`, `free -g`, `df -h ~`, and the operating system).
6. **Check:**
   ```bash
   company check        # ~/.local/bin/company, from the engine (scripts/company)
   ```
   **Do not continue until it passes.** Fix an error in the files, not in the check. Fix warnings (a file not listed in the index) too.
7. **Commit:** in `$COMPANY_HOME`, in one command, because once the line is gone the folder is closed to writes. If the check fails without the line, the command puts it back, so you can fix and run it again:
   ```bash
   cd "$COMPANY_HOME" && cp company/org.yaml /tmp/org.yaml.setup && sed -i '/^setup: pending$/d' company/org.yaml \
     && { company check || { cp /tmp/org.yaml.setup company/org.yaml; false; }; } && git add -A && git commit -m "Set up the company"
   ```
   From now on the check requires `owner_name` and `timezone`. This is the only commit made without a PR. From now on every change to the contract goes through a PR with review, like code.
8. **A private repo on GitHub:** card `headline: "Back up the company on GitHub?"`, `question: "A private repo in your account. Without it there is no PR for contract changes and no backup."`, `options: ["Yes, private", "Not now"]`. "Yes": `gh repo create <user>/company --private --source "$COMPANY_HOME" --push` (if the name is taken, propose `<user>-company`).
9. **Start:** hq reads `org.yaml` only at startup. `systemctl --user restart agent-company-hq`. Shifts survive a restart. Make sure the new teams appear on the board in the app.
10. **Introductions:** `tell` every team lead, a line or two: who they are, which project, and what the owner said about it. The message wakes them.

## The demo

Right after setup, without asking again: a small, real task that shows the whole cycle (team, branch, PR, review, CI, merge) on the first day.

- **Choice:** before opening, check that no earlier demo was created in the conversation or in the handoff. Open it only once. In the active project updated most recently. A small open issue with a label like `good first issue` or `documentation`, if there is one. Otherwise: improve the README by what you learned about the project in setup (how to run, how to test, how to deploy).
- **It does not touch production**, does not add a dependency, and does not change code behaviour.
- `open_team` with `project: <p>`, a short name, and a `purpose` that includes "done when the PR is merged after independent review and green CI" (or "after your approval", per question 4).
- A message to the owner: "I opened a first task so you can see how it works: <what>. You will get a link to the PR from me when it is ready."
- When the task closes: a message with the link, and what happened on the way (how many findings in the review, how long it took).

## What we do not do

- Do not copy names, directives or charters from another company, not even from the examples. The examples show form, not content.
- Do not ask a question that can be answered from the repo or the machine.
- Do not give `grants` in setup. A production permission is given later, explicitly, with a quote.
- Do not deploy, do not send email and do not open an issue in anyone's repo in this conversation.
