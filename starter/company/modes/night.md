---
mode: night
trigger: "לילה"            # the word hq parses ("night"). From any channel: the app, a conversation with the manager, any worker
scope_filters: true        # "only <project>", "no deploys" are kept as a filter on the query
end: owner-first-message   # default: until the owner writes something in the morning, or at the hour he or she set
sweep_every: 1m
quota_conditions: none     # no condition at all on quota percentages
---

# Night mode

The owner writes "לילה" ("night"). That is enough. Everything else is defined here once.

Night starts only when the owner writes the word. What the owner said about it in the setup conversation (for example "no deploys at night", or not wanting night at all) is recorded as a directive in [directives.md](../directives.md), and the manager does not offer night to an owner who said no.

## Scope

- **With no addition:** all active projects.
- **With an addition** ("only <project>", "no deploys"): the addition is kept as a filter on the queue query, until the end of the night.

## The queue

**The queue is built in code, with a fixed query, not by an LLM's judgment.** hq builds it the moment the word "לילה" arrives, in this order:

1. **Open and interrupted:** tasks in the store in state `open` or `interrupted`, with an existing worktree.
2. **Leftovers:** tasks that were in the previous night's queue and did not finish.
3. **Ready for night:** GitHub Issues in active projects with the label `company:night`. By priority label (`p0` to `p3`), then by age.
4. **Default:** open Issues in active projects **without** the label `needs-decision`. By priority, then by `night_weight` from the project's charter, then by age.

**Who maintains it:** team leads and the manager mark and order labels during the day. That is their whole influence on the queue. Even if nobody ordered anything, the queue is built and filled by rule 4.

## The scheduler

- Every time a slot frees up, and in addition a sweep every minute, the next item in the queue is taken and a task team is opened for it under the project's CEO.
- **No condition at all on quota percentages.** A blocked account leads to switching accounts. If all accounts are blocked, the queue parks until the reset, and continues on its own.
- When the slots on one computer are full, a new shift moves to another computer. That is capacity, not caution.

## Night rules

1. **A blocking question** goes to the manager immediately, without waiting 10 minutes.
2. **The manager cannot decide:** the task gets `needs-decision`, parks, and the slot moves to the next item. Do not wait.
3. **Production:** deploy only in a project whose charter allows deploying without GO (a written deviation). Everything else goes into "GO waiting" for the morning.
4. **Notifications:** only an urgent production fault. Everything else goes to the summary.
5. **We do not stop on our own.** Not because of quota, not because of load, not out of "caution".

## Measurement: empty slot

- hq records every minute in which a slot was empty while the queue was not empty, with the reason (for example: all accounts blocked, an item parked on a decision, a computer unavailable).
- **The target:** less than 5% of the night.
- The number and the reasons go into the morning summary.

## End and morning summary

- The night ends at the hour the owner set. The default: when the owner writes something in the morning, that is, the owner's first message after the first 05:00 (by `timezone` in `org.yaml`) since the night started, and at least an hour after it. "בוקר" ("morning") or "סוף לילה" ("end of night") end it at any hour. A message in the middle of the night does not end it.
- The manager writes one summary from the store, not from its own memory:
  - What was done (merges by project).
  - What is waiting for the owner (GO, questions), with answer buttons.
  - What was skipped and why.
  - How many minutes a slot was empty while there was work in the queue, and why.
