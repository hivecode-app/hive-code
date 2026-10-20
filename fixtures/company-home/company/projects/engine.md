---
project: engine
status: active
repo: example-co/engine
machine: srv1
checkouts:
  - name: engine
    path: ~/projects/engine
    default_branch: main
  - name: company
    path: ~/company
    default_branch: main
    repo: example-co/company
worktree_dir: .worktrees
commands:
  install: npm ci
  test: npm test
ceo: ron
model: strongest
review: independent
ci: required
ci_check: engine-ci
merge: worker-squash
deploy: owner-go
night_weight: 3
deviations: []
monitoring: []
grants: []
---

# אמנת המנוע

ראש הצוות: [רון](../identities/ron.md). הזיכרון: [memory/projects/engine](../../memory/projects/engine/INDEX.md).
