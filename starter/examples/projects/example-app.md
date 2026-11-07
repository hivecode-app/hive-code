---
project: example-app
status: active
repo: example-user/example-app
machine: srv1                 # where the workers run: one of machines in org.yaml
checkouts:                    # hq opens a worktree for every task at <path>/<worktree_dir>/<task>
  - name: example-app
    path: ~/projects/example-app
    default_branch: main
worktree_dir: .worktrees      # in the checkout's .git/info/exclude
commands:                     # what the repo itself says (CLAUDE.md, package.json), validated by a run in setup
  install: pnpm install --frozen-lockfile
  test: pnpm test
  lint: pnpm lint
  build: pnpm build
ceo: aviv                     # the team lead
model: strongest
review: independent
ci: required
ci_check: ci-ok               # the summary job in .github/workflows/ci.yml, as it appeared in the latest PRs
merge: worker-squash          # or owner-approve, with merge_instructions
deploy: owner-go
night_weight: 1
deviations:                   # every deviation from the default charter, with a reason. A deviation that is not written does not exist
  - what: The tests do not include a typecheck
    reason: "No tsconfig in the repo (as of setup). Idea: a task team that adds one"
monitoring:                   # probes: GET only, no tokens. They run when the prod-probes automation is on
  - id: web-health
    http: https://app.example.com/healthz
    every: 1m
    expect: 200
    max_latency: 3s
    fail_after: 3             # three failed checks in a row before monitoring is woken
heavy:                        # what is heavy in this project: a worker does `reserve` first, and runs through `company-run`. A class here wins over the company default of the same name
  - class: build
    mem: 4GB
    cpu: 2
    timeout: 20m
grants: []                    # production permissions: team, action, quote, date. Empty until the owner gives them
---

# The app charter

The team lead: [Aviv](../identities/aviv.md).

## What the project is

A web app for booking appointments. A line or two, in the owner's words.

## Way of working

Per the default charter in `company/company.md`, with the deviation in `deviations`.

## Deploy

- **How:** the workflow `deploy.yml` (a manual run, `workflow_dispatch`) deploys `main` to Vercel. Run it only after GO: `gh workflow run deploy.yml`.
- **Rollback:** `vercel rollback` to the previous deploy, about a minute.
- **URL:** `https://app.example.com`.

## Commands

| What | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Tests | `pnpm test` |
| lint | `pnpm lint` |
| build | `pnpm build` |
