# Changelog

All notable changes to Hive Code are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Until 1.0, a minor version can include breaking changes; they are called out below.

## [Unreleased]

## [0.3.0] - 2026-11-08

### Added
- Three tabs in the app: Chats, Tasks and Team. Settings moved behind the account button.
- A task page with its stages, an activity timeline, details and a side panel on desktop.
- A third column on wide screens that shows the tasks of the open conversation.
- Full-screen search across conversations, tasks and projects.
- Real projects in filters, in the sidebar and on the projects screen.
- First-run setup in the app: access confirmation, Claude and GitHub connections, project selection and work settings.
- Notification settings, and notifications grouped by intent: questions and approvals alert, updates stay quiet.
- Groundwork for Android push notifications through Firebase Cloud Messaging, without a permanent "connected" notification. Not available yet for your own installation.
- Files and media: uploads in parts that resume, previews, and attachments the workers can read.
- Long dictation that is not lost, sent in parts with progress and retry.
- Private reports a worker can show you, with versions and an isolated link.
- English alongside Hebrew in the app.
- A daily local backup and a cleanup timer for incomplete backups.

### Changed
- *Needs you* shows only what blocks the work on you: questions, approvals and logins. Releases waiting for you are grouped and folded.
- The app's visual language: a neutral background, one icon set (Material Symbols Rounded), Heebo, and two-letter monograms in the project's color.
- A review is one full round and one narrow round on the fixes.
- A task's worktree is created from the latest remote branch, not from a local copy that may be behind.
- *Waiting for deploy* clears by itself once production runs the merged change.

### Removed
- Night mode no longer turns on by the clock.

### Fixed
- A chat no longer breaks when a tool result arrives after the text, or when a task card arrives twice.
- An urgent task no longer waits silently in a busy worker's queue.

## [0.2.0] - 2026-10-28

### Added
- Additional machines can join as worker hosts.
- Releases include the web app and the signed Android app, checked against `SHA256SUMS`.
- A merge gate: a pull request cannot merge without an approving review on its last commit.
- Time estimates on tasks, with a reminder before they run out.
- Decisions in one tap: approval and question cards in the chat.

### Changed
- The installer installs from a tagged release, and installs the Claude Code version the release is tested with.
- A message from you reaches a worker right away, and interrupts it only when it is safe.

### Fixed
- A message that did not reach the server is sent again automatically, without duplicates.
- A worker no longer starts when the server is out of memory; the task waits instead.

## [0.1.0] - 2026-10-20

First release.

### Added
- `hq`: one process with the state in SQLite, mailboxes, a scheduler, a watchdog, probes and the API.
- One host process per worker session, which outlives restarts of `hq`.
- The `company` MCP server for every worker: messages, questions, memory, status and approvals.
- Hooks that keep workers out of `hq`'s own checkouts and record every tool call.
- The company as a git repository (`COMPANY_HOME`) with a starter kit and a contract check.
- A one-command installer, `company update` and `company doctor`.
- The app for Android and the web: conversations, approvals and questions in the chat, images, unread counts and muting, and one app that connects to any server.
- Mixed Hebrew and English text displayed correctly everywhere.

[Unreleased]: https://github.com/hivecode-app/hive-code/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/hivecode-app/hive-code/releases/tag/v0.3.0
