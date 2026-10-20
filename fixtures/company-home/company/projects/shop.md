---
project: shop
status: active
repo: example-co/shop
machine: srv1
checkouts:
  - name: shop-app
    path: ~/shop-app
    default_branch: main
worktree_dir: .worktrees
commands:
  install: pnpm install --frozen-lockfile
  test: pnpm test
ceo: aviv
model: strongest
review: independent
ci: required
ci_check: app
design_review:            # שינוי בממשק עובר גם אצל המעצבת
  reviewer: lior
  paths: [app/lib/ui/]
merge: worker-squash
deploy: owner-go
night_weight: 2
deviations:
  - what: העלאה לחנות האפליקציות רק אחרי שאלה נפרדת לבעלת החברה
    reason: «קודם תשאלו אותי» (01/10/2026)
monitoring:   # GET בלבד, בלי טוקנים
  - id: api
    http: https://api.shop.example/v1/products
    every: 1m
    expect: 403
    max_latency: 2s
    fail_after: 3
  - id: web
    http: https://shop.example/
    every: 1m
    expect: 200
    max_latency: 3s
    fail_after: 3
  - id: admin
    http: https://admin.shop.example/healthz
    every: 2m
    expect: 200
    max_latency: 2s
    fail_after: 2
grants: []
---

# אמנת החנות

ראש הצוות: [אביב](../identities/aviv.md).
