// Explicit PR provenance: a successful create in the task's own shift, never a link in a note.
import type { Store } from './store.ts';
import { outputOf } from './merged.ts';
import { readCharter, repoOfWorktree } from './workspace.ts';

// The final command must create the PR. Argument substitutions do not change top-level boundaries.
// Decode quoting before looking at command boundaries; an example in an echo is never an invocation.
// Substitutions are arguments, not top-level shell operators. Never evaluate their content.
function expansionEnd(s: string, start: number): number | null {
  const tick = s[start] === '`';
  if (tick) {
    for (let i = start + 1; i < s.length; i++) {
      if (s[i] === '\\') i++; else if (s[i] === '`') return i;
    }
    return null;
  }
  if (s[start + 1] === '{') {
    let depth = 1;
    for (let i = start + 2; i < s.length; i++) {
      if (s[i] === '{') depth++; else if (s[i] === '}' && --depth === 0) return i;
    }
    return null;
  }
  let depth = 1, quote = '';
  const documents: { label: string; tabs: boolean }[] = [];
  for (let i = start + 2; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote === "'") { if (ch === quote) quote = ''; continue; }
    if (ch === '`' || (ch === '$' && ['(', '{'].includes(s[i + 1] ?? ''))) {
      const end = expansionEnd(s, i); if (end == null) return null; i = end; continue;
    }
    if (ch === quote) { quote = ''; continue; }
    if (quote === '"') continue;
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    const doc = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(s.slice(i));
    if (doc) { documents.push({ label: doc[3]!, tabs: !!doc[1] }); i += doc[0].length - 1; continue; }
    if (ch === '\n' && documents.length) {
      let cursor = i + 1;
      for (const doc of documents) {
        let found = false;
        while (cursor < s.length) {
          const end = s.indexOf('\n', cursor), next = end < 0 ? s.length : end;
          const line = s.slice(cursor, next);
          cursor = next + 1;
          if ((doc.tabs ? line.replace(/^\t+/, '') : line) === doc.label) { found = true; break; }
        }
        if (!found) return null;
      }
      documents.length = 0; i = cursor - 1; continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return null;
}

function words(command: string): string[] | null {
  const out: string[] = [];
  let word = '', started = false, quote = '';
  const flush = () => { if (started) out.push(word); word = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === quote) quote = ''; else word += ch;
    } else if (ch === '\\') {
      const next = command[++i];
      if (next == null) return null;
      if (next !== '\n') { word += next; started = true; }
    } else if (ch === quote) {
      quote = '';
    } else if (ch === '`' || (ch === '$' && ['(', '{'].includes(command[i + 1] ?? ''))) {
      const end = expansionEnd(command, i);
      if (end == null) return null;
      word += command.slice(i, end + 1); started = true; i = end;
    } else if (quote === '"') {
      word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; started = true;
    } else if (!started && /^(?:[12]?>&[12])(?=\s|$)/.test(command.slice(i))) {
      i += /^(?:[12]?>&[12])/.exec(command.slice(i))![0].length - 1;
    } else if (ch === '&' && command[i + 1] === '&') {
      flush(); out.push('&&'); i++;
    } else if (/[;|&<>()[\]{}\n]/.test(ch)) {
      return null;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      started = true; word += ch;
    }
  }
  if (quote) return null;
  flush(); return out;
}
export function createsPr(command: string): boolean {
  let tokens = words(command.trim());
  if (!tokens) return false;
  if (/^(?:\/(?:usr\/)?bin\/)?(?:bash|sh)$/.test(tokens[0] ?? '') && /^-(?:lc|c)$/.test(tokens[1] ?? '') && tokens.length === 3) {
    tokens = words(tokens[2]!);
    if (!tokens) return false;
  }
  tokens = tokens.slice(tokens.lastIndexOf('&&') + 1);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? '')) tokens.shift();
  return tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'create' && !tokens.includes('&&');
}
export function createdPrFrom(payload: unknown): string | null {
  const p = payload as { tool_name?: string; tool_input?: { command?: unknown }; tool_response?: unknown } | null;
  const command = p?.tool_input?.command;
  if (p?.tool_name !== 'Bash' || typeof command !== 'string' || !createsPr(command)) return null;
  const lines = outputOf(p.tool_response).split('\n').map((s) => s.trim());
  return lines.findLast((s) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(s)) ?? null;
}
export function recordedTaskPrs(store: Store, task: number): string[] {
  return JSON.parse(store.getMeta(`task-pr-links:${task}`) ?? '[]') as string[];
}
export function recordTaskPr(store: Store, task: number | null, identity: string, url: string, shift: string, companyDir: string): boolean {
  if (task == null) return false;
  return store.db.transaction(() => {
    const row = store.db.prepare('SELECT identity, state, shift_id, project, pr, worktree FROM tasks WHERE id = ?').get(task) as { identity: string | null; state: string; shift_id: string | null; project: string | null; pr: string | null; worktree: string | null } | undefined;
    if (row?.identity !== identity || !['running','resting'].includes(row.state) || row.shift_id !== shift) return false;
    const urls = recordedTaskPrs(store, task);
    if (urls.includes(url)) return false;
    store.setMeta(`task-pr-links:${task}`, JSON.stringify([...urls, url]));
    const repo = new URL(url).pathname.split('/').slice(1, 3).join('/');
    // The legacy numeric reference is also used by deploy clearing: a follow-up must never replace it.
    const expectedRepo = row.project ? repoOfWorktree(readCharter(companyDir, row.project), row.worktree) : null;
    if (!row.pr && expectedRepo?.toLowerCase() === repo.toLowerCase()) {
      store.db.prepare('UPDATE tasks SET pr = ?, updated_at = ? WHERE id = ?').run(url.split('/').pop()!, store.now(), task);
    }
    store.emit('task.pr', identity, { id: task, url });
    return true;
  })();
}
