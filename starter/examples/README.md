# Examples to copy

What the manager copies and adapts in the setup conversation ([skills/setup](../company/skills/setup/SKILL.md)), and what any worker copies when adding a project or an identity later. The examples show form, not content: the names, URLs and commands here are made up.

| File | What is in it |
|---|---|
| [org-additions.yaml](org-additions.yaml) | What goes into `company/org.yaml` for every active project: an entry in `projects`, a team, a team lead. And in addition a monitoring team |
| [projects/example-app.md](projects/example-app.md) | A project charter: `checkouts`, `commands`, `ci_check`, a deviation with a reason, and a basic probe |
| [projects/old-site.md](projects/old-site.md) | A charter of a dormant project: no team and no checkouts |
| [identities/aviv.md](identities/aviv.md) | A dossier of a project team lead, with the five sections the check requires |
| [identities/hadar.md](identities/hadar.md) | A dossier of the monitoring team lead |

**The probe** sits in the project's charter, in the `monitoring` list. hq's probe-runner runs it when the `prod-probes` automation of the monitoring team lead is on. Today it supports only `http` (GET, no tokens). Any other kind is recorded as "not supported" and is not swallowed silently.

`company check` runs on these examples in the engine's tests (`scripts/check-contract.test.mjs`): they are inserted into the skeleton, and the resulting contract must pass.
