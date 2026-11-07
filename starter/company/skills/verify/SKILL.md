---
name: verify
description: Verify that a change really works before claiming it is done, in the agent company. Use before saying "done", before requesting review, before merging, and before asking for GO. Runs the project's checks and a real end-to-end proof, and reports evidence, not impressions.
---

# Verification before "done"

"It works" is a claim with evidence. Without evidence, write "not verified" and why.

## Steps

1. **What must be true?** Write in one or two lines what the task promised, in terms that can be checked.
2. **The project's checks**, per the charter (`company/projects/<p>.md`, the "Commands" table): tests, typecheck, lint, build. When the contract (`company/`, `memory/`) changed, also `company check`.
3. **A real end-to-end proof**, not just a unit: run the CLI, call the endpoint, open the screen, reproduce the bug and see that it is gone.
4. **Check the files you changed** for signs of unfinished work: placeholder, stub, `test.skip`, `.only`, an unimplemented branch, forgotten debug code.
5. **A failure unrelated to you:** if a check also failed before your change, show it (a run on `main`), record it as a lesson in the project's memory, and do not hide it.

## The output

```
### Verification
- <command> → <result: passed / failed, with the relevant line>
- Proof: <what I ran and what I saw>
- Not verified: <what, and why>
```

## Rules

- No fake silence. A check that did not run did not "pass".
- If verification failed, keep fixing. Do not report "done".
- An item that cannot be verified here (for example, it needs the owner's phone) is written explicitly under "Not verified".
