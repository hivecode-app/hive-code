# The starter kit

What the installer copies to `COMPANY_HOME` (default `~/company`) for a new company, as a local git repo. The plan: [docs/generic/PLAN.md](../docs/generic/PLAN.md), sections 3 and 4.

| What | Why |
|---|---|
| `company/company.md` | The contract: principles, the default charter, what needs a question |
| `company/directives.md` | The engine's Authority block (the five kinds the hook blocks), and a place for directives |
| `company/org.yaml` | Skeleton: one manager with a temporary name, `setup: pending`, no teams and no projects |
| `company/identities/manager.md` | The manager's dossier |
| `company/skills/` | `setup` (the setup conversation), `reviewer`, `verify`, `ship` |
| `company/modes/night.md` | Night mode |
| `memory/` | `README.md`, a basic design book, conventions, and a `machines.md` template |
| `examples/` | A project charter, identity dossiers, a probe, and what to add to `org.yaml` |

**What checks it:** `npm run check:starter` (inside CI's `npm run check:contract`). As long as `setup: pending` is there, the check accepts an empty owner name and timezone. At the end of the setup conversation the manager deletes that line, and from then on they are required.

**The Authority block** in the kit ends with `<!-- /AUTHORITY -->`. In a company set up from it, `company check` compares it to the copy here. If the hook changes, change the block here in the same PR.

The kit is in English. Workers write to the owner in the owner's language (`owner_language` in `org.yaml`). The names in the examples are made up, and the manager proposes new names based on what the owner chooses.
