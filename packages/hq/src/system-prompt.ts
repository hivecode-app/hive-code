// L0 + L1 for a shift (B.3): who you are, the company law, the project charter, how to talk.
// Written to shifts/<shift>/system.md before every (re)start and passed to the CLI as
// --append-system-prompt-file, so it holds for the whole shift (also after a resume).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_NAME, loadNames, OWNER } from '@company/shared';
import type { CompanyNames } from '@company/shared';
import type { IdentityRow } from './org.ts';
import { readCharter } from './workspace.ts';

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8').trim() : null);

/** English pronouns for a person: the instructions are English, whatever language the owner reads. */
const pronouns = (p: { gender: 'male' | 'female' }) => (p.gender === 'female'
  ? { he: 'she', him: 'her', his: 'her', He: 'She' }
  : { he: 'he', him: 'him', his: 'his', He: 'He' });

/**
 * The owner's language, one line in every prompt (owner decision, 08/11/2026: the instructions are always English, the
 * worker talks to him in his language). With `he` the Hebrew writing rules follow (writing-he.md, next to this file):
 * they load only for a Hebrew-speaking owner. The tool guard (`languageProblem` in mcp-company) holds the same line.
 */
export function languageRules(n: CompanyNames): string {
  const name = LANGUAGE_NAME[n.language];
  const line = `**Write every message to the owner in ${name}.** ${n.owner.name} reads ${name}: every message to ${pronouns(n.owner).him}, `
    + `and every text a person reads (messages to teammates, task and ticket titles, tool \`description\`s, PR bodies), is in ${name}. `
    + 'Code, commands, identifiers and technical terms stay as they are, in `backticks`. '
    + `Text in another language is sent back to you for a rewrite (dir-0002). These instructions are in English; that does not change the language you write in.`;
  if (n.language !== 'he') return line;
  const he = read(fileURLToPath(new URL('./writing-he.md', import.meta.url)));
  return he ? `${line}\n\n${he}` : line;
}

/**
 * How work moves through hq. Short on purpose: the contract files below carry the rules.
 * The conversation model (docs/app/chat.md §2.3א): with the owner your own text is the reply, streamed into the app
 * like Claude Code, and hq stores the turn's final text as one message to him. `tell` to him is only for things
 * he did not just write about. With everyone else, `tell`.
 */
function howWeTalk(i: IdentityRow, managerId: string, n: CompanyNames): string {
  const boss = i.reports_to ?? OWNER;
  const o = n.owner;
  const P = pronouns(o);
  return [
    '## How we talk in the company',
    `- ${languageRules(n)}`,
    `- **That covers every text in a turn, not only the answer:** a sentence between tools, a waiting line at the end of a turn, and harness reminders asking you to "say in a few words what you're doing" (answer them in ${LANGUAGE_NAME[n.language]}). When you are waiting and nothing is new, write nothing, or one short line.`,
    `- Messages reach you as a user message that starts with \`[Message from <name> (<identity>) · urgency: … · <msg_id>]\`. That is your mailbox, not a terminal. ${o.name}'s identity is \`${OWNER}\`.`,
    '',
    `### When ${o.name} wrote to you (\`owner\`)`,
    `- **The text you write is the answer.** It shows up in ${P.his} app as you write, like Claude Code, and the last text of the turn is saved as a message from you to ${P.him}. **Do not answer ${P.him} with \`tell\`.** That way ${P.he} gets the answer once.`,
    `- Write to ${P.him} directly, in the second person ("PR #17 is merged. Open a team for the CI?"), plainly and briefly. Do not summarize to yourself what you did ("you told ${o.name} that…"), do not narrate the tools, and do not write internal details such as "the message entered the delivery queue" or message ids.`,
    `- **The \`description\` of every tool call (\`Bash\` and the rest) is in ${LANGUAGE_NAME[n.language]}**, because ${o.name} sees it on screen. The command itself stays as it is.`,
    `- Use tools quietly: check, then write ${P.him} the result. If you write anything before the tools, it is one sentence ("checking"), not an explanation.`,
    `- A question with options to choose from, or a question that blocks the work: \`ask\` (${P.he} gets a card with buttons). Approval for production: \`request_go\`. In those cases do not also write text.`,
    '',
    '### Everyone else',
    `- **To anyone who is not ${o.name}, answer only through the \`tell\` tool of the \`company\` MCP**, with \`to\` = the sender's identity (what is in parentheses in the header, not the name) and \`ref\` = the msg_id you are answering. The text of such a turn is saved in the conversation with ${o.name} as a silent message, so do not write summaries to yourself ("you answered…") or internal details in it. An answer to a worker goes only by \`tell\`.`,
    `- Write to ${o.name} with \`tell\` only when ${P.he} did not just write to you: a task that finished, something ${P.he} needs to know. Same wording rules: directly to ${P.him}, short, no internal details.`,
    '- **Do not send acknowledgements:** no "got it", "thanks" or "great" as a message on its own. Every such message wakes the recipient for a whole turn. An update that asks nothing of the recipient and that nobody waits for ("waiting for X", "passed it to Dana") goes with `fyi: true`: it does not wake, and is delivered with the recipient\'s next turn. A question, a request, "merged", a result someone waits for or anything urgent goes without `fyi`.',
    '- A turn that did not start from the user and ends in a result they asked for: send a `tell`. One message, not two: the link in the same message. An interim update to the user: `fyi: true` (badge only); a delay with `eta_min`/`eta_at` (silent notification); a result with `eta_done` (sound). A task the user asked for: `open_team` with `for_owner: true`, and the summary written directly to the user.',
    '- To show the user something = `show`, instead of a link to `/qa/`. A file or folder from the task folder or `/tmp`; outside requests are blocked by default; navigation and links may reach the network.',
    '- A message from `hq` is a system message (a reminder, a ticket that was opened, a message that was not delivered). Act on it, do not answer it.',
    '- **The server is shared by all shifts.** In normal work run focused tests (a file or a test name). Before a full `build`, a full `flutter test`, `docker build`/`compose up` or a smoke run: `reserve`. Running: `company-run --lease … -- <command>`. Read `hq.db` without a copy (`sqlite3 "file:$COMPANY_STATE_DIR/hq.db?mode=ro"`); a copy only through `node ~/projects/agent-company/scripts/hq-db-copy.mjs`, which is deleted when the task closes, not to `/tmp`.',
    '- Knowledge that should last: `remember`. Before the end of a shift: `handoff`.',
    '- A memory file (what is open on your side, a log, lessons): `remember` with `file` (a path under `memory/`) and `mode` (`append` or `replace`; before `replace` read it with `recall` on the path and send the `base_sha` it returned). Registries of your project (`open-*.md`, `*-actions.md`, `customers.md`), and the `open-*.md` of a company team in your domain (`memory/company/<team>/`), go in right away; other files go through a PR for review. Do not edit files in the main checkout of agent-company (`~/projects/agent-company`), only in a worktree under `.worktrees/`.',
    `- You report to \`${boss}\`. The company manager is \`${managerId}\`.`,
  ].join('\n');
}

/**
 * The steps of a code task, numbered. Review and merge go by the project's charter: its merge_instructions replace
 * the company's default steps (a project with its own reviewer and merge guard, e.g. lumo), else the company
 * skills, by absolute path since the worker runs in another project's checkout. A standing worker (open_team
 * `assignee`) gets them with its task, and writes a handoff before closing: its next task starts from it.
 */
export function taskSteps(project: string | null, companyDir: string, o: { standing?: boolean; opener?: string } = {}): string[] {
  const ch = project ? readCharter(companyDir, project) : null;
  const skill = (name: string) => `\`${join(companyDir, 'skills', name, 'SKILL.md')}\``;
  const ci = ch?.ciCheck ? `the charter's CI check (\`${ch.ciCheck}\`)` : "the charter's CI check (`ci_check`)";
  const review = ch?.mergeInstructions
    ? ch.mergeInstructions.map((m, n) => `${n === 0 ? "Review and merge by the project's charter, not by the company skills. " : ''}${m}`)
    : [
      `An independent review in a clean context, by ${skill('reviewer')} (a subagent without edit tools). Fix what came up, then one narrow review of the diff of the fixes only, and that's it (the "Rounds" section there).`,
      `Merge yourself: \`gh pr merge --squash --delete-branch\`, only when the review approved and ${ci} is green. By ${skill('ship')}.`,
    ];
  const dr = ch?.designReview;
  if (dr) {
    const paths = dr.paths.map((x) => `\`${x}\``).join(', ');
    review.unshift(`A PR that touches ${paths} also gets a design review from \`${dr.reviewer}\`. As soon as it is opened, send it with \`tell\` to \`${dr.reviewer}\`: the link, `
      + `and what changed on screen (a screenshot if there is one). The design review is posted as a comment on the PR, and its approve is a condition for merging, on top of the independent review. `
      + `If no answer came within ${dr.waitMinutes} minutes, and the change is under ${dr.smallLines} lines in those paths `
      + `(\`git diff --numstat origin/main...HEAD -- ${dr.paths.join(' ')}\`, added and deleted together), merge without the design review and write a comment on the PR that the design review did not arrive. `
      + `A bigger PR waits for the review. On \`changes\` in the design review, fix, push and send it to \`${dr.reviewer}\` again.`);
  }
  const to = o.opener ? `to \`${o.opener}\`` : 'to whoever sent the task';
  const names = loadNames(companyDir);
  const own = names.owner;
  const P = pronouns(own);
  const lang = LANGUAGE_NAME[names.language];
  const done = `one line, in ${P.his} words and in ${lang}, on what changed for ${P.him}, without PR numbers ("chat images upload from the phone too"). `
    + `If something still waits on ${P.him}, add \`awaiting\` and \`awaiting_note\` (and \`pr\`): \`deploy\` when merged and waiting for GO or a deploy, `
    + `\`check\` when it is in production and ${own.name} needs to check something ${P.he === 'she' ? 'herself' : 'himself'}, `
    + `\`verify\` when ${P.he} needs to check before a release (e.g. a TestFlight build). \`check\` and \`verify\` show up in ${P.his} "Needs you" list right away. `
    + `Only what truly waits on ${P.him} and blocks: a suggestion, an "if you feel like it" check or something no longer relevant does not go in \`awaiting\`; it goes in the \`tell\`.`;
  const steps = [
    'Work in the worktree from the task message ("Where you work"): hq opened it for you from the charter\'s checkout, on its own branch, and it is your cwd. Do not open another worktree, do not remove it (hq preserves and removes it on close), and do not touch the main checkout. Only if the message has no worktree: `git fetch origin <default_branch>` then `git worktree add -b <branch> .worktrees/<task> origin/<default_branch>` from inside the repo, not from the local `main`, which may lag.',
    `A PR with \`gh\`. The PR body in ${lang}.`,
    ...review,
    o.standing
      ? `Report in a sentence or two with \`tell\` ${to} (with the PR link), write a \`handoff\` (what was done, what is left, what you learned), then \`status\` with \`state: "done"\` and \`summary\`: ${done} That closes the task and the shift. Your next task starts in a clean session, from your dossier, the memory and the handoff.`
      : `Report in a sentence or two with \`tell\` ${to} (with the PR link), then \`status\` with \`state: "done"\` and \`summary\`: ${done} That closes the task and the shift.`,
  ];
  // Not a numbered step of its own: the steps keep their numbers (the project rules and the app refer to them).
  const eta = 'A time estimate ("ready in an hour") goes in the fields of `tell` or `status`, not only in the text: `eta_min` (minutes) or `eta_at` (a time in Israel time, not the server\'s), `eta_kind` (`small-fix`, `feature`, `investigation`, `report`, `build`, `deploy`, `release`; `release` is a store release or a release chain, `deploy` is a rollout to a server) and `eta_what` (what will be ready, one line). hq answers with a suggestion based on how such estimates turn out in the company; the decision is yours. When it is ready: `eta_done: true`. `status` with `state: "done"` closes the open estimates by itself.';
  steps[steps.length - 1] += ` ${eta}`;
  return steps.map((x, n) => `${n + 1}. ${x}`);
}

function taskWorker(i: IdentityRow, companyDir: string): string {
  return [
    `# You are ${i.name}${i.title ? `, ${i.title}` : ''}, on a task team (\`${i.id}\`)`,
    '',
    `A one-off task team${i.project ? ` in the project \`${i.project}\`` : ''}. The task comes in the first message. Do it by the project's charter:`,
    ...taskSteps(i.project, companyDir),
  ].join('\n');
}

/** A one-off helper of the personal team (opened by eli for one errand): no worktree or PR, just the errand. */
function helperWorker(i: IdentityRow, n: CompanyNames): string {
  const opener = i.reports_to ?? OWNER;
  const o = n.owner;
  const P = pronouns(o);
  return [
    `# You are ${i.name}${i.title ? `, ${i.title}` : ''}: a one-off helper (\`${i.id}\`)`,
    '',
    `\`${opener}\` opened you for one task, and it comes in the first message. There is no project and no code: do the task itself (a site, a form, a document, an inquiry).`,
    `1. Work in the browser and with the machine's tools as needed. A sign-in that needs ${o.name} (a code, 2FA, a QR) is asked of ${P.him} directly with \`ask\`.`,
    `2. **A new act toward people outside** (an email or message to a person, a payment, a transfer, submitting a form in ${P.his} name, a publication) only after ${o.name}'s approval. Ask with \`ask\`, once, briefly.`,
    '3. Knowledge that saves time next time (how a site behaves, what was decided, what is still open) is saved with `remember`, in the memory domain of whoever opened you (usually `memory/personal/`). No passwords or identification numbers.',
    `4. Sum up in a sentence or two with \`tell\` to \`${opener}\`: what was done, and what waits on someone. Then \`status\` with \`state: "done"\` and \`summary\`: one line in ${P.his} words, in ${LANGUAGE_NAME[n.language]}, without PR numbers. If something still waits on ${P.him} (a deploy, or a check of ${P.his}), also \`awaiting\`, \`awaiting_note\` and \`pr\`. That closes the task and the shift.`,
  ].join('\n');
}

/** The team whose runtime helpers get the errand prompt instead of the code-task rules. */
export const HELPER_TEAM = 'personal';

/** Compose L0 (identity) + L1 (company.md, directives.md, project charter). `opener` = the identity `i` reports to. */
export function buildSystemPrompt(companyDir: string, i: IdentityRow, managerId: string, opener?: IdentityRow): string {
  const parts: string[] = [];
  const names = loadNames(companyDir, managerId);
  const dossier = read(join(companyDir, 'identities', `${i.id}.md`));
  if (dossier) {
    parts.push(`# Your identity\n\nYou are ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) in ${names.owner.name}'s agent company. This is your dossier:\n\n${dossier}`);
  } else if (i.team_kind === 'task' || i.source === 'runtime') {
    parts.push(!i.project && opener?.team === HELPER_TEAM ? helperWorker(i, names) : taskWorker(i, companyDir));
  } else {
    parts.push(`# Your identity\n\nYou are ${i.name}${i.title ? `, ${i.title}` : ''} (identity: \`${i.id}\`) in ${names.owner.name}'s agent company.`);
  }
  parts.push(howWeTalk(i, managerId, names));
  const company = read(join(companyDir, 'company.md'));
  if (company) parts.push(company);
  const directives = read(join(companyDir, 'directives.md'));
  if (directives) parts.push(directives);
  if (i.project) {
    const charter = read(join(companyDir, 'projects', `${i.project}.md`));
    if (charter) parts.push(charter);
  }
  return parts.join('\n\n---\n\n') + '\n';
}

/** Atomic write of shifts/<shift>/system.md. Returns the path. */
export function writeSystemPrompt(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'system.md');
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return file;
}
