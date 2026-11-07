# The company's memory

One memory, shared by the whole company. There are no partitions. What is loaded into each worker is decided by relevance, and everything else is available to every worker through `recall`. Every domain has an **owner** who is responsible for the knowledge in it being correct and up to date. Ownership does not block reading.

**The source of truth is our data, not the transcript.** The transcript is a read-only archive.

## The layers

| Layer | What is in it | Where it is kept |
|---|---|---|
| **L0: identity** | Name, title, personality, role, authority | `company/identities/<id>.md`, `company/org.yaml` |
| **L1: company law** | The Authority block, the directives, the default charter and the project charter | `company/directives.md`, `company/company.md`, `company/projects/<p>.md` |
| **L2: shift** | The last handoff: what I did, what was decided, what the next step is | store |
| **L3: company** | Permanent facts: machines, conventions, the design book | [company/](company/INDEX.md) |
| **L3: project** | Technical lessons, decisions, traps, commands | [projects/](projects/INDEX.md) |
| **L4: archive** | All the transcripts, handoffs and messages | `~/.claude/projects` (read-only), store |

## Rules

- **Every directory has an `INDEX.md`**: a line per file, with a one-line summary. `company check` fails if a link points to a file that does not exist. A file not listed in the index gets a warning.
- **Facts only.** Every fact has a date ("as of …"). A fact that went stale is marked, not deleted silently.
- **No secrets.** No passwords, tokens, keys, ID numbers or bank accounts. Write where they are, not the value.
- **Write only through `remember`** or a PR.
- **A directive** of the owner is not memory. It goes into `company/directives.md`.
- **A conflict** between two facts becomes a question to the owner, not a silent decision.
