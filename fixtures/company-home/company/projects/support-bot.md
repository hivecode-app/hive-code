---
project: support-bot
status: active
repo: example-co/support-bot
machine: srv2
checkouts:
  - name: support-bot
    path: ~/support-bot
    default_branch: main
worktree_dir: .worktrees
commands:
  test: go test ./...
ceo: michal
model: strongest
review: independent
ci: required
ci_check: go
merge: worker-squash
deploy: owner-go
night_weight: 1
deviations: []
monitoring:
  - id: health
    http: https://bot.support.example/health
    every: 1m
    expect: 200
    max_latency: 2s
    fail_after: 3
  - id: webhook
    http: https://bot.support.example/webhook
    every: 1m
    expect: 405
    max_latency: 2s
    fail_after: 3
  - id: status
    http: https://status.support.example/
    every: 5m
    expect: 200
    max_latency: 5s
    fail_after: 2
grants: []
---

# אמנת בוט התמיכה

ראשת הצוות: [מיכל](../identities/michal.md).
