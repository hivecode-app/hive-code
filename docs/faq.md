# FAQ

### Does it use the Claude API, or my subscription?

Your subscription. Every worker is the real Claude Code CLI, signed in to your Claude Pro or Max account on the server. Hive Code sends no model requests through the Claude API and needs no API key.

### How fast does it use up my plan?

Faster than working alone, because several workers run at once and every task also gets a review. In the app's work settings you choose how many workers run in parallel, and see an estimate of how long your plan lasts at the current rate. When the plan limit is reached, work pauses and continues by itself when capacity is back.

### Is this an official Anthropic product?

No. Hive Code is an independent open source project built on top of Claude Code.

### Why does it need full permissions on my server?

Because that is what lets the workers finish a task without stopping to ask you about every command: install dependencies, run tests, build, push a branch. Install it on a server where you would give a developer the same access. A dedicated server or VM is a good choice.

### Can a worker deploy to production without me?

Not under the default rules. Merged work waits for your GO before it is deployed, and the request tells you what changes, the risk and how to roll back. You can change these rules per project, in its charter.

### Does any of my code or data leave my server?

Only where you send it: the workers talk to Claude (through Claude Code) and to GitHub (through `gh` and git), the same as when you use them yourself. Hive Code has no backend of its own and no telemetry.

### Do I need a domain?

No. The default is Tailscale Funnel, which gives you a free HTTPS address. A Cloudflare Tunnel or your own domain also work. See [install](install.md#requirements).

### Does it work on macOS or Windows?

The server part needs Linux with systemd. The app runs on Android and in any modern browser, including on a Mac, a Windows PC or an iPhone.

### Is there an iPhone app?

Not yet. On iPhone the app runs in the browser.

### Which languages does it support?

The app is in English and Hebrew. The installer's output, the workers' built-in instructions and the starter company are in Hebrew today. English versions are planned.

### Can I edit the rules myself?

Yes. Your company is a git repository in `~/company`: roles, rules, project charters and memory are Markdown and YAML files. Edit them directly, or ask the manager to change them. `company check` validates them.

### How do I update?

Run `company update` on the server. It installs the newest release, checks it, restarts the services safely, and rolls back if the check fails.

### Something is stuck. What do I do?

Run `company doctor` and read the file it writes. It covers versions, service status, the address and recent logs. If you open an issue, attach the parts that matter after checking them for secrets.
