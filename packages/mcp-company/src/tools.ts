// Tool catalogue of the `company` MCP server (B.4, B.3, B.6). Every tool but
// recall is a write: it goes to the local WAL and is answered {queued:true}.
import { DEFAULT_NAMES, g, isWrongLanguageTitle, languageReason, wrongLanguageLines, UI_TERMS, uiTermsLine } from '@company/shared';
import type { CompanyNames, OpName, OwnerLanguage } from '@company/shared';

type Schema = Record<string, unknown>;

export interface ToolDef {
  name: OpName | 'recall' | 'request_access' | 'resources' | 'reserve' | 'release';
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, Schema>; required: string[]; additionalProperties: boolean };
}

const s = (description: string): Schema => ({ type: 'string', description });
const strs = (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description });
const oneOf = (values: string[], description: string): Schema => ({ type: 'string', enum: values, description });

function tool(name: ToolDef['name'], description: string, properties: Record<string, Schema>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

/** The catalogue, its texts naming the owner, the manager and the composer from org.yaml (CompanyNames). */
export function buildTools(n: CompanyNames = DEFAULT_NAMES): ToolDef[] {
  const O = n.owner.name;
  // English pronouns by the owner's gender (names.owner.gender).
  const G = (male: string, female: string) => g(n.owner, male, female);
  const he = G('he', 'she'), He = G('He', 'She'), him = G('him', 'her'), his = G('his', 'her'), himself = G('himself', 'herself');
  // What the interface shows him has no internal term (owner, 08/11). One dictionary: packages/shared/src/ui-terms.json.
  const WORDS = ' no internal terms or acronyms, in ' + his + ' words: ' + uiTermsLine() + '. ';
  const NO_TERMS = ' no internal terms like ' + UI_TERMS.slice(0, 3).map((t) => t.term).join(', ') + '. ';
  // "What to check" (#108): what a finished task still waits for, shown to him until a deploy or his "checked" clears it.
  const awaitingArgs: Record<string, Schema> = {
    awaiting: oneOf(['deploy', 'check', 'verify', 'none'], 'What the task still waits on ' + him + ' for: deploy = merged, waits for GO or a deploy (clears by itself: hq reads what runs in production from `live:` in the project charter, and clears once every part the PR touches runs it; a deploy report that mentions it also clears it), '
      + 'check = already in production and ' + O + ' has to check something ' + himself + ' (clears when ' + he + ' marks "Done"), verify = to check before release, e.g. a TestFlight build, none = nothing, clears. Without it: waits on nothing. '
      + 'check and verify reach ' + him + ' at once as a message in ' + his + ' chat with you, with "Works" and "Doesn\'t work", and "Doesn\'t work" goes to whoever opened the task. deploy never reaches ' + him + ': deploys are combined into one GO request per project (request_go), and after 6 hours with no deploy and no GO request hq reminds you. '
      + 'Only what truly waits on ' + him + ' and blocks: without ' + his + ' check or without the deploy the work is not finished. A suggestion, an "if you like", or anything that can be done without ' + him + ' does not go in awaiting: put it in a tell.'),
    awaiting_note: s('With awaiting: one line in ' + his + ' words, what waits or what to check, opening with what is asked,' + NO_TERMS + 'e.g. "Check on the phone that a photo is sent and shows up in the chat"'),
    pr: s('The merged PR. A full url is best: in a project with several repos a number alone does not say which. Once it runs in production, deploy clears by itself'),
  };

  // Time estimates (estimates.ts): a promise of "X will be ready in Y" goes in these fields, not only in the text. hq keeps the register,
  // answers with the company's calibration in a message, and closes it with the real time.
  // eta_at's "Israel time" is hq's default etaTimeZone (hq.config.json, #301); a company that changes it changes this text too.
  const etaArgs: Record<string, Schema> = {
    eta_min: { type: 'number', description: 'Estimate: in how many minutes what is in eta_what will be ready. Or eta_at' },
    eta_at: s('Estimate: at what time it will be ready, HH:MM or a full date and time (ISO). A time with no zone is read as Israel time (Asia/Jerusalem), not the server\'s clock. Or eta_min'),
    eta_kind: oneOf(['small-fix', 'feature', 'investigation', 'report', 'build', 'deploy', 'release'],
      'The kind of work the estimate is for. release = store release or a release chain, deploy = server rollout, build = a build or CI'),
    eta_what: s('What will be ready, one line in the owner\'s language,' + NO_TERMS + 'e.g. "The change is ready for review"'),
    eta_done: { type: 'boolean', description: 'What was promised in eta_what is ready: closes the open estimate with the real time (without eta_what: the latest one)' },
  };

  return [
    tool('show', 'Show the user an HTML page, report or mockup: copies a file or directory and returns a link signed for 12 hours. External requests are blocked by default; navigation and links may reach the network. Kept 30 days from the last update. Use it instead of publishing under /qa/. With an existing id the same card is updated (a private, versioned artifact)', {
      path: s('Absolute path to a file, or to a directory with index.html, inside the task directory or /tmp'),
      html: s('Or inline HTML, instead of path'),
      title: s('The report or mockup title the user sees'),
      id: s('An existing artifact to update with a new version'),
      note: s('What changed in this version'),
      network: { type: 'boolean', description: 'Default false; true allows network access and marks it on the card' },
    }, ['title']),
    tool('tell', 'Send a message to a teammate by identity. When the message promises a time ("ready in an hour"), record it in the eta_min or eta_at, eta_kind and eta_what fields, not only in the text; '
      + 'hq answers with a suggestion based on how such estimates turn out in practice. When it is ready: eta_done.', {
      files: strs('Up to 20 file paths: the task directory, /tmp, or the files of the message you are answering. They are copied into the chat; if it came back queued, keep the sources until acknowledged'),
      to: s('Recipient identity, e.g. "dana"'),
      body: s('Message text'),
      urgency: oneOf(['now', 'next', 'later'], 'now wakes at once (does not cut a running turn), next is the default, later goes to the end of the queue'),
      fyi: { type: 'boolean', description: 'To ' + O + ': a badge only, no sound and no notification. Between workers: does not wake, delivered with the next turn. For an update that asks nothing of the recipient and nobody waits on ("waiting on X", "passed it to Dana"). It does not wake the recipient, '
        + 'and is delivered with its next turn. Not for a question, a request, a "merged" or anything someone waits on' },
      ref: s('Id of the message being answered, e.g. m-8812'),
      ...etaArgs,
    }, ['to', 'body']),
    tool('ask', 'Ask ' + O + ' or the manager a question. ' + He + ' sees it as a message in ' + his + ' chat with you: the headline first, buttons from options under it, '
      + 'and the details (question) folded. Whatever ' + he + ' types in that chat while the question is open is the answer.', {
      headline: s('A short first line in ' + his + ' words: what changes for ' + him + ' or what is needed from ' + him + ',' + WORDS
        + 'e.g. "App update: photos in the chat"'),
      question: s('The question with the details (folded under the headline)'),
      blocking: { type: 'boolean', description: 'Whether work stops until answered' },
      options: strs('Suggested answers'),
      ref: s('Context: a related message or task id'),
    }, ['headline', 'question']),
    tool('remember', 'Store knowledge in company memory.', {
      scope: oneOf(['company', 'project', 'personal'], 'Scope'),
      kind: oneOf(['directive', 'lesson', 'decision', 'fact', 'trap', 'command'], 'Kind'),
      text: s('The knowledge itself'),
      quote: s('Verbatim source quote'),
      source: s('Source reference, e.g. m-8812'),
      project: s('Project, when scope=project'),
      domain: s('Domain, when scope=personal'),
      file: s('Update a memory file: a relative path under memory/, e.g. memory/projects/lumo-bot/open-ron.md. Your project\'s registries '
        + '(open-*.md, *-actions.md, customers.md), and the open-*.md of a company team in your domain (memory/company/<team>/), land on main at once; other files go to one rolling PR for review. Do not edit files in the main checkout'),
      mode: oneOf(['append', 'replace'], 'With file: append adds text at the end of the file (default), replace makes text the whole file. '
        + 'Before replace, read the file with recall using the path as query: it comes back whole, including updates still pending, and with base_sha'),
      base_sha: s('With replace on a registry: the base_sha recall returned for the path. If the file changed since, the update does not land and hq sends you the new content'),
    }, ['scope', 'kind', 'text']),
    tool('recall', 'Search company memory. In ONE call pass both a Hebrew and an English phrasing of the same question in `queries` (memory is written in both languages) '
      + '(e.g. ["מספר החירום של ביטוח הבריאות", "health insurance emergency number"]); do not retry with another language. '
      + 'The first item comes with the full record, the rest as snippets.', {
      query: s('Search terms or a record id'),
      queries: strs('Reformulations: at least one Hebrew and one English'),
      scope: s('company | project:<p> | personal:<domain> | archive'),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max results (default 8)' },
    }, []),
    tool('handoff', 'Shift handoff for the next session: state, decisions and what comes next.', {
      state: s('Current state, one line'),
      done: strs('What was done'),
      decisions: strs('Decisions made'),
      next: strs('Next steps'),
      waiting_on: strs('Who or what it waits on'),
      open_questions: strs('Open questions'),
      warnings: strs('Warnings'),
      confidence: oneOf(['low', 'medium', 'high'], 'Confidence'),
      reason: s('Why handing off, e.g. context, end_of_day'),
      task: s('Task id'),
    }, ['state']),
    tool('status', 'Update your working status. With state "done" the task closes; always give summary: it is the line ' + O + ' sees under "Since you were here" and "What finished". '
      + 'Without summary ' + he + ' sees only the task title. '
      + 'If something still waits on ' + him + ' (a deploy after approval, or something ' + he + ' must check ' + himself + '), add awaiting and awaiting_note; check or verify reach ' + him + ' as a message in the chat with "Works" and "Doesn\'t work". '
      + 'The task closes when the turn ends, and only if you answered every message ' + O + ' sent you. Otherwise hq tells you "' + O + ' is waiting for an answer on…" and it stays open. '
      + 'A time estimate ("ready in 40 minutes") goes in the eta_min or eta_at, eta_kind and eta_what fields; after done or eta_done it closes with the real time.', {
      state: s('State, e.g. working | blocked | idle | done. On the second server: needs-local when something only the main server has is missing, and the task moves there'),
      note: s('Short note'),
      summary: s('With done: one line in ' + his + ' words on what changed for ' + him + ', no PR or task numbers.' + WORDS + 'e.g. "Photos in the chat upload from the phone too"'),
      ...awaitingArgs,
      ...etaArgs,
    }, ['state']),
    tool('open_team', 'Open a task team: it is queued, a fresh worker starts in a free slot and reports back to you when done. With assignee the task goes to the standing worker whose domain it is: '
      + 'its own worktree and a fresh session, and if that worker is in the middle of another task it waits in their queue. If hq rejects it (e.g. a dormant project or an invalid assignee), the rejection and the reason come back as an error. '
      + 'A task that is part of a larger effort: name starts with the effort\'s name, e.g. "Generic product, phase 4: one app per server". The effort is yours, and your chat is its home. '
      + 'Priority: priority 0-3 (0 most urgent, default 2). Without priority, a name starting with p0 or p1 (also "p0:", or after a space or bracket) gets that priority.', {
      for_owner: { type: 'boolean', description: 'true for a task the user asked for: when done, the summary is sent to the user automatically if you did not report yourself' },
      name: s('The task title, as it appears to ' + him + ' in the tasks tab:' + NO_TERMS + 'Priority goes in priority, not p0 in the title. Part of a larger effort: the effort\'s name first, e.g. "Generic product, phase 4: …"'),
      purpose: s('What exactly to do and how you know it is done'),
      about: s('One line in ' + his + ' words: what the task will change for ' + him + ',' + NO_TERMS + 'e.g. "A notification when a driver does not confirm a ride within 5 minutes". '
        + 'This is what ' + he + ' sees on the task page. The purpose is for the worker and is not shown to ' + him),
      proposal: { type: 'boolean', description: 'true for a proposal: the task does not start until ' + O + ' presses "Start" in the tasks tab. For an idea ' + he + ' did not ask for, not for a task ' + he + ' asked for' },
      priority: { type: 'integer', minimum: 0, maximum: 3, description: 'Priority 0-3, 0 most urgent, default 2. Overrides a p0/p1 title prefix' },
      project: s('The project, e.g. agent-company (default: yours)'),
      ref: s('Ticket, e.g. hivecode-app/hive-code#11'),
      repo: s('The checkout from the charter (name), if the project has more than one. Default: the first'),
      assignee: s('The standing worker of the project whose domain it is, e.g. ido. Without: a temporary worker'),
      members: strs('Identities of the team members'),
      local: { type: 'boolean', description: 'true when the task needs something only the main server has: ssh keys, `.env`, kubectl, secrets of the main server, a browser or a simulator. Without: runs on whichever server has room, the second one included' },
      engine: { type: 'string', enum: ['claude', 'codex'], description: 'Which engine the worker runs on. Default claude. codex only in a project whose charter turns it on (`codex: { tasks: on-request }`), with no assignee, '
        + 'and for code work with a clear check (tests, typecheck). Not for production, a browser or a conversation. When the Codex quota is used up, hq rejects with the reason and does not fall back to Claude' },
      model: s('With engine codex only: the Codex model, e.g. gpt-6-astra. Default: the charter\'s'),
    }, ['name', 'purpose']),
    tool('close_team', 'Close a task team: the task closes, its shift stops and the work is preserved. Only whoever opened it, their manager, the worker\'s manager or ' + n.manager.name + '. '
      + 'awaiting and awaiting_note override what the worker marked, and can be set on a task that is already closed.', {
      team: s('The task id (t22), the worker\'s identity (lumo-t22) or its name'),
      reason: s('Reason, sent to the worker before the stop'),
      summary: s('One line in ' + his + ' words on what changed for ' + him + ', no PR or task numbers,' + NO_TERMS + 'e.g. "Michal is on the Lumo Bot team". '
        + 'Overrides what the worker wrote. Give it when the worker gave none, or ' + he + ' sees only the task title'),
      force: { type: 'boolean', description: 'Close even when ' + O + ' is still waiting for an answer from the worker (without it hq warns and does not close)' },
      ...awaitingArgs,
    }, ['team']),
    tool('withdraw_ask', 'Close an ask of yours that was decided another way, so it does not stay in ' + O + '\'s "Needs you" list. The card is removed; no answer is sent.', {
      ask: s('The ask id (the ref ask returned)'),
      note: s('Why it closed, one line in the owner\'s language'),
    }, ['ask']),
    tool('withdraw_go', 'Close a GO request of yours that was already decided, so it does not stay in ' + O + '\'s "Needs you" list. '
      + 'approved_in_chat: ' + he + ' approved in the chat (e.g. "go ahead, let\'s fix it") and no tap is needed: message is required, the msg_id of ' + his + ' own message written after the card opened. '
      + 'hq checks the message is really from ' + him + ' and keeps its quote as the evidence for the GO; a message that reads as a refusal does not approve. '
      + 'withdrawn: the request is no longer relevant, the card goes away and no GO is recorded. Only whoever opened the request, their manager or ' + n.manager.name + '. An access request (request_access) is not closed this way.', {
      ref: s('The GO id (the ref request_go returned, or inbox-<n>)'),
      outcome: oneOf(['approved_in_chat', 'withdrawn'], 'approved_in_chat = approved in the chat, withdrawn = cancelled'),
      message: s('With approved_in_chat: the msg_id of ' + O + '\'s message (what is in brackets in the header of the message you got)'),
      note: s('Why, one line in the owner\'s language'),
    }, ['ref', 'outcome']),
    tool('request_go', 'Request a go-ahead before acting. ' + He + ' sees it as a message in ' + his + ' chat with you with an "Approve" button: the headline first, and the details (what) folded. '
      + 'A clear yes or no in the chat (or the button) closes the request; anything else ' + he + ' types reaches you as an ordinary message and the request stays open. If the decision was already made in the chat and ' + he + ' did not tap the card, close it with withdraw_go. Do not close the task while it is open.', {
      action: oneOf(['release', 'deploy', 'publish', 'run'], 'What you ask to do; sets the title when there is no headline'),
      headline: s('A short first line that says what is asked of ' + him + ': it starts with "Decide whether…" (in the owner\'s language). It is also the notification title.' + WORDS
        + 'e.g. "Decide whether to release the app update: photos in the chat"'),
      what: s('The details: what ships, risk and how to roll back (folded)'),
      pr: s('PR url or number. A full link becomes the "Code change" button on the decision'),
      report: s('Link to the full report (https), if any. The "Full report" button on the decision'),
      risk: oneOf(['low', 'medium', 'high'], 'Risk level'),
    }, ['what']),
    tool('compose_home', 'Compose the head of ' + O + '\'s conversations screen: which blocks, in what order and with what wording. Only ' + (n.composer ? `${n.composer.name} and ${n.manager.name}` : n.manager.name) + '. '
      + 'The app draws each block from a fixed component and fills it from live data, so data is referenced by id, and the text is in the owner\'s language,' + WORDS
      + 'The block vocabulary: '
      + 'headline {text} one sentence. What waits on ' + him + ' is shown in its own pinned row at the top of the conversations ("3 need you"), so do not write in it how much waits on ' + him + ' · alert {shift: shift id} a fault with no decision, e.g. a stuck shift · '
      + 'tasks {tasks: [task ids] or "open"} in progress and queued: open tasks with who opened them, who works on them and the state. "open" shows all of them, a list shows specific tasks (e.g. an urgent one) · '
      + 'lanes {projects: [ids]} the day\'s lanes · '
      + 'project {project, note?} two lines · quiet {projects: [ids]} one line at the end, "Also quiet: …", for projects that did not move · people {identities: [ids], caption?} · since {items: [up to 3: a sentence, or {text, task: task id}]}, with task the line leads to the chat with whoever did the task · '
      + 'note {text, icon} a note of yours, icon is a Material Symbol name. Any block can have emphasis: normal|quiet|strong (typography only). '
      + 'Decisions (GO requests, questions, checks, faults with an answer) are not on the home: they are in the "Needs you" row at the top of the conversations, and waiting, asked, awaiting and alert on inbox are not shown (if they come, they are skipped quietly). '
      + 'An unknown block, a missing field or a reference that does not exist is rejected with the reason. What closes disappears by itself. '
      + 'A recipe older than 30 minutes is replaced by hq\'s default. '
      + 'Example: [{"type":"headline","text":"A quiet morning, two tasks running"},'
      + '{"type":"lanes","projects":["agent-company","lumo"]},{"type":"project","project":"lumo","note":"Waiting for approval to release 2.6.10"},'
      + '{"type":"note","text":"Worth checking the 2.6.10 release","icon":"rocket_launch","emphasis":"quiet"}]', {
      blocks: { type: 'array', items: { type: 'object' }, description: 'The blocks, in order' },
      reason: s('Why this composition, one line'),
    }, ['blocks']),
    tool('request_access', 'Run a command on a company server, cluster or database in your name, without holding the keys. hq builds the command itself from closed lists, runs it and returns the output. '
      + 'resource: `kube:<name>` (kubectl in a forced namespace), `ssh:<name>` (a command from a list), `build:<name>` (docker build and push of a commit to the registry of the resource; argv = [repo, full sha, Dockerfile path, full tag, optional context]; returns a digest, and a push is not a deploy) or `hq:query` (SELECT on hq.db). argv: the words of the command, without the prefix (`["get","pods"]`, not `kubectl get pods`). '
      + 'Allowed: get, describe, logs --tail, rollout status|history|restart|undo, set image, scale, delete pod/<name>, exec <pod> -- <command>. Not supported: `-f`, port-forward, apply, an interactive shell. The flags --kubeconfig, --token, --as and `-n` of another namespace are always rejected. '
      + 'Outside production (dev, ci, hq:query) everything runs at once. In production a read runs at once, and every change or exec, every time, reaches ' + O + ' as a card with the exact command: the answer is status pending; carry on with what does not depend on it, and come back with request. '
      + 'Do not know which resource? Do not guess: a name that does not exist comes back unfit, and its hint lists the resources open to the task and the commands allowed on each. '
      + 'A long command comes back after up to 90 seconds with status running and request; keep calling with the same request (the output is kept). A command not on the list comes back unfit with a suggestion: do not try to work around it, and if there is no alternative, `status` with needs-local.', {
      resource: s('kube:<name> | ssh:<name> | build:<name> | hq:query'),
      argv: strs('The words of the command without the prefix, e.g. ["rollout","status","deploy/api","--timeout=5m"]; for hq:query one SQL string'),
      why: s('Why, one line in the owner\'s language: ' + he + ' sees it on the card'),
      request: s('acc-N: continue a request that came back pending or running'),
      cancel: s('acc-N: cancel a request that waits or runs'),
      wait: { type: 'number', description: 'Seconds to wait for the result or approval, up to 100 (default 90)' },
    }, []),
    tool('resources', 'The servers\' resource state, read-only: per machine memory, load and disk, who holds them by project (including unidentified ones with their cgroup or container name), and who waits for room. '
      + 'Call it before a full build, a full `flutter test`, docker or smoke, and after something got stuck on "the server is busy". A part that was not measured says so, and must not be read as healthy. Memory by project is the cgroup\'s anon memory (no page cache), so the sum is close to "used".', {}, []),
    tool('reserve', 'Reserve a place before a heavy command on the shared server: a full build, a full `flutter test`, `docker build`/`compose up` or smoke. hq returns one of three answers: '
      + 'granted (there is room: run it with `company-run --lease <lease> -- <command>`, and the reservation is released by itself when the command ends), '
      + 'queued (no room now: the answer comes back within up to 90 seconds with who holds it, the place in the queue and an estimate; carry on with what does not depend on it and come back with `lease` to keep the same place in the queue) '
      + 'or unavailable (there will be no room, or the class is not defined; with an alternative). An urgent task (p0) is not overtaken, and hq does not stop an existing reservation for it. '
      + 'A reservation is released by itself at the end of the command, after the class\'s ceiling (default 30 minutes) and when the shift closes.', {
      class: s('The class: build | test-full | docker | smoke, or a class the project charter defines in its heavy block'),
      machine: s('The machine (default: your shift\'s), local or a node name'),
      note: s('What you run, one line in the owner\'s language: shown to whoever waits'),
      lease: s('lease-N: continue a lease that came back queued, from the same place in the queue'),
      wait: { type: 'number', description: 'Seconds to wait for a place, up to 100 (default 90)' },
    }, []),
    tool('release', 'Release a reservation (`reserve`) when the place is no longer needed, or leave the queue. Not needed after `company-run`: it releases by itself when the command ends.', {
      lease: s('lease-N, the lease id'),
    }, ['lease']),
    tool('open_ticket', 'Open an issue in a repo.', {
      repo: s('owner/repo'),
      title: s('Title'),
      body: s('Body'),
      labels: strs('Labels'),
    }, ['repo', 'title', 'body']),
  ];
}

/** For validation and tests: the catalogue's shape does not depend on the names. */
export const TOOLS: readonly ToolDef[] = buildTools();

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name as string, t]));

/** Minimal JSON Schema check for our flat schemas. Returns an error or null. */
export function validateArgs(def: ToolDef, args: unknown): string | null {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'arguments must be an object';
  const a = args as Record<string, unknown>;
  for (const r of def.inputSchema.required) {
    if (a[r] === undefined || a[r] === null || a[r] === '') return `missing required argument: ${r}`;
  }
  for (const [k, v] of Object.entries(a)) {
    const p = def.inputSchema.properties[k];
    if (!p) return `unknown argument: ${k}`;
    if (v === undefined || v === null) continue;
    switch (p.type) {
      case 'string':
        if (typeof v !== 'string') return `${k} must be a string`;
        if (Array.isArray(p.enum) && !p.enum.includes(v)) return `${k} must be one of ${p.enum.join('|')}`;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return `${k} must be a boolean`;
        break;
      case 'integer':
        if (!Number.isInteger(v)) return `${k} must be an integer`;
        if (typeof p.minimum === 'number' && (v as number) < p.minimum) return `${k} must be >= ${p.minimum}`;
        if (typeof p.maximum === 'number' && (v as number) > p.maximum) return `${k} must be <= ${p.maximum}`;
        break;
      case 'array':
        if ((p.items as Schema | undefined)?.type === 'object') {
          if (!Array.isArray(v) || v.some((x) => typeof x !== 'object' || x === null || Array.isArray(x))) return `${k} must be an array of objects`;
        } else if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return `${k} must be an array of strings`;
        break;
    }
  }
  return null;
}

/** Everything a person reads goes out in the owner's language (dir-0002, #51): message text by line, titles whole. */
const PERSON_TEXT: Partial<Record<ToolDef['name'], string[]>> = {
  show: ['note'], tell: ['body'], ask: ['question'], withdraw_ask: ['note'], withdraw_go: ['note'], request_go: ['what'], open_team: ['purpose'], open_ticket: ['body'], request_access: ['why'], reserve: ['note'],
};
const PERSON_TITLE: Partial<Record<ToolDef['name'], string[]>> = {
  show: ['title'], open_team: ['name'], open_ticket: ['title'], ask: ['headline'], request_go: ['headline'],
  tell: ['eta_what'], status: ['awaiting_note', 'eta_what'], close_team: ['awaiting_note'],
};
/** compose_home: every text a block shows him (headline, note, caption, since items) is in his language too. */
const BLOCK_TEXT = ['text', 'note', 'caption'];

/** The fixed Hebrew answers hq parses (mailbox.ts MANAGER_DECISION, the caught-fault answers): written as is in any
 *  company, so they are taken out before the language check. */
const FIXED_MARKERS = /החלטתי במקומך\s*[:,\-–]?\s*(?:לטפל|לא עכשיו)?/g;

/** The rewrite request when a field that a person reads is not in the owner's language, else null. */
export function languageProblem(def: ToolDef, args: Record<string, unknown>, language: OwnerLanguage): string | null {
  for (const k of PERSON_TITLE[def.name] ?? []) {
    const v = args[k];
    if (typeof v === 'string' && isWrongLanguageTitle(v, language)) return languageReason(`${def.name}.${k} (title)`, [v], language);
  }
  for (const k of PERSON_TEXT[def.name] ?? []) {
    const v = args[k];
    const bad = typeof v === 'string' ? wrongLanguageLines(v.replace(FIXED_MARKERS, ' '), language) : [];
    if (bad.length) return languageReason(`${def.name}.${k}`, bad, language);
  }
  if (def.name === 'compose_home' && Array.isArray(args.blocks)) {
    for (const [i, b] of (args.blocks as Record<string, unknown>[]).entries()) {
      const items = Array.isArray(b?.items) ? (b.items as unknown[]).map((x) => (x && typeof x === 'object' ? (x as { text?: unknown }).text : x)) : [];
      const texts = [...BLOCK_TEXT.map((k) => b?.[k]), ...items].filter((v): v is string => typeof v === 'string');
      for (const v of texts) if (isWrongLanguageTitle(v, language)) return languageReason(`compose_home.blocks[${i}]`, [v], language);
    }
  }
  return null;
}
