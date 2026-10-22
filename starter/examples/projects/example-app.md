---
project: example-app
status: active
repo: example-user/example-app
machine: srv1                 # איפה העובדים רצים: אחת מ-machines ב-org.yaml
checkouts:                    # hq פותח worktree לכל משימה ב-<path>/<worktree_dir>/<task>
  - name: example-app
    path: ~/projects/example-app
    default_branch: main
worktree_dir: .worktrees      # ב-.git/info/exclude של ה-checkout
commands:                     # מה שה-repo עצמו אומר (CLAUDE.md, package.json), ואומת בהרצה בהקמה
  install: pnpm install --frozen-lockfile
  test: pnpm test
  lint: pnpm lint
  build: pnpm build
ceo: aviv                     # ראש הצוות
model: strongest
review: independent
ci: required
ci_check: ci-ok               # ה-job המסכם ב-.github/workflows/ci.yml, כפי שהופיע ב-PRs האחרונים
merge: worker-squash          # או owner-approve, עם merge_instructions
deploy: owner-go
night_weight: 1
deviations:                   # כל חריגה מאמנת ברירת המחדל, עם סיבה. חריגה שלא כתובה לא קיימת
  - what: הבדיקות לא כוללות typecheck
    reason: "אין tsconfig ב-repo (נכון להקמה). רעיון: צוות משימה שמוסיף"
monitoring:                   # probes: GET בלבד, בלי טוקנים. רצים כשהאוטומציה prod-probes דולקת
  - id: web-health
    http: https://app.example.com/healthz
    every: 1m
    expect: 200
    max_latency: 3s
    fail_after: 3             # שלוש בדיקות כושלות ברצף לפני שמעירים את הניטור
heavy:                        # מה כבד בפרויקט הזה: עובד עושה `reserve` לפני, ומריץ דרך `company-run`. מחלקה כאן גוברת על ברירת המחדל של החברה באותו שם
  - class: build
    mem: 4GB
    cpu: 2
    timeout: 20m
grants: []                    # הרשאות פרודקשן: team, action, quote, date. ריק עד שבעל החברה נותן
---

# אמנת האפליקציה

ראש הצוות: [אביב](../identities/aviv.md).

## מה הפרויקט

אפליקציית web להזמנת תורים. שורה או שתיים, במילים של בעל החברה.

## שיטת עבודה

לפי אמנת ברירת המחדל ב-`company/company.md`, עם החריגה שב-`deviations`.

## פריסה

- **איך:** workflow `deploy.yml` (הרצה ידנית, `workflow_dispatch`) פורס את `main` ל-Vercel. מריצים אותו רק אחרי GO: `gh workflow run deploy.yml`.
- **חזרה אחורה:** `vercel rollback` לפריסה הקודמת, כדקה.
- **כתובת:** `https://app.example.com`.

## פקודות

| מה | פקודה |
|---|---|
| התקנה | `pnpm install --frozen-lockfile` |
| בדיקות | `pnpm test` |
| lint | `pnpm lint` |
| build | `pnpm build` |
