# Getting started

This guide picks up after the [install](install.md), when the app is open on your phone or in your browser. It takes about ten minutes, and you end with your first pull request reviewed and waiting for you.

## 1. Set up the company (4 steps in the app)

1. **Full access and responsibility.** The app shows what the workers can do on your server (run commands, read, change and delete files) and that they use your Claude subscription. Confirm to continue.
2. **Almost ready.** The app checks that the server is signed in to Claude and to GitHub. If one of them says *Connection needed*, run the command it shows on the server (`claude auth login` or `gh auth login`) and try again.
3. **Choose projects.** Pick the GitHub repositories the company may work in, then choose *Set up company*. You can add more projects later.
4. **Your first task.** Choose *Open conversation* to continue in the conversation with the manager.

How many workers run in parallel is in *Settings*, under *Work settings*. Each active worker uses about 5 GB of memory, so a 16 GB server is comfortable with two.

## 2. Meet the manager

The manager is waiting in that conversation. It asks a few questions, one at a time: what to call you, what each project is, and how you want to work (what needs your approval, what workers may do on their own). At the end it shows a summary of what it will set up (teams, rules, what is allowed) and creates it only after you approve.

Everything it sets up is written as files in your company repository (`~/company`): `company/org.yaml` for the teams, one charter per project under `company/projects/`, and the rules in `company/company.md`. You can read and change them like any repository.

## 3. Ask for something

Write to the manager the way you would write to a lead developer:

> In the storefront repo, the checkout button disappears on small screens. Fix it.

The manager opens a task and a worker picks it up. You can follow along in the worker's conversation, or ignore it until something needs you. Behind the scenes:

1. The worker gets its own branch and working copy (a git worktree).
2. It writes the fix and runs the tests the project charter names.
3. It opens a pull request.
4. A separate reviewer, with no edit tools and a clean context, reviews it. The worker fixes what the review found, and one narrower review checks the fixes.
5. When the review approves and CI is green, the worker merges.

## 4. What needs you

The app stops you only for things that block the work:

- **A question** the worker cannot answer alone. It arrives as a card with buttons.
- **GO for production.** Merged changes are not deployed until you approve. The request says what changes, the risk and how to roll back.
- **A login.** When a worker needs you to sign in to a site, it asks once.

These appear under *Needs you* in the chat list and on the *Tasks* tab. Everything else is a normal message you can read whenever you like.

## 5. Every day after that

- Workers keep a memory: when a session ends, the worker writes a handoff and continues from it in the next one. Decisions you make once are saved and apply to every worker, including new ones.
- The *Team* tab shows who is working, who is resting and who is stuck.
- Run `company update` on the server to install a new release, and `company doctor` when something looks wrong.

Questions that come up often are in the [FAQ](faq.md).
