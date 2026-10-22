// The head of his conversations screen, composed by an agent (server-driven UI). hq keeps a recipe of blocks
// from a fixed vocabulary; the app draws each block from its own designed component and fills it from the live
// board, so an agent picks what to show, in what order and in what words, but never how it looks.
//   GET /api/home  → the recipe in force: the composer's, or the deterministic default (none, older than 30
//                    minutes, or no longer valid). Live data wins: a block whose inbox item closed is gone.
//   PUT /api/home  → a new recipe; strict validation, 400 with the reason.
// The composer (the identity that owns the `compose-home` automation in org.yaml, today עדי) is woken to
// compose again on what matters, at most once per 3 minutes; during night mode only for an incident or a new
// "waiting for you", the rest is kept for one composition in the morning (07:00, or when he opens the app).
import { g, OWNER, pre, type HqEvent } from '@company/shared';
import type { Hq } from './hq.ts';
import { hhmm, nextLocal } from './timezone.ts';
import { askedList, type AskedItem } from './asked.ts';

export const BLOCK_TYPES = ['headline', 'alert', 'waiting', 'asked', 'awaiting', 'tasks', 'lanes', 'project', 'quiet', 'people', 'since', 'note'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const EMPHASES = ['normal', 'quiet', 'strong'] as const;
export type Emphasis = (typeof EMPHASES)[number];

export type Block = { type: BlockType; emphasis?: Emphasis } & (
  | { type: 'headline'; text: string }
  | { type: 'alert'; inbox?: number; shift?: string }
  | { type: 'waiting'; inbox: number[] }
  | { type: 'asked'; messages: string[] }
  | { type: 'awaiting'; tasks: number[] }
  | { type: 'tasks'; tasks: number[] | 'open' }
  | { type: 'lanes'; projects: string[] }
  | { type: 'project'; project: string; note?: string }
  | { type: 'quiet'; projects: string[] }
  | { type: 'people'; identities: string[]; caption?: string }
  | { type: 'since'; items: SinceItem[] }
  | { type: 'note'; text: string; icon: string }
);

/** A "since" sentence, with the task it tells of when known: the app opens the conversation with who did it. */
export interface SinceItem { text: string; task?: number }

export interface HomeRecipe {
  /** Grows with every composition; the default recipe carries the version of the one it replaced (0 = none yet). */
  version: number;
  composed_by: string;
  composed_at: number;
  reason: string | null;
  /** `agent`: the composer's recipe. `default`: hq's own, and why (none | stale | invalid | off). */
  source: 'agent' | 'default';
  fallback?: 'none' | 'stale' | 'invalid' | 'off';
  blocks: Block[];
  /** When what waits for him last changed (inbox.lastChange): a headline composed before it may no longer be true. */
  waiting_changed_at?: number | null;
}

export const STALE_MS = 30 * 60_000;
export const WAKE_EVERY_MS = 3 * 60_000;
export const MAX_BLOCKS = 12;
export const AUTOMATION = 'compose-home';
const DAY_MS = 24 * 3_600_000;

const firstLine = (s: string, max: number): string => (s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, max);

/**
 * The default's one sentence, from the live numbers: an alert, what is running, what finished. What waits for him is
 * not here: the app puts "N החלטות מחכות לך." in front of it from the live data (task 306).
 */
export function headline(running: number, done: number, alert = false): string {
  const parts: string[] = [];
  if (alert) parts.push('יש תקלה');
  if (running) parts.push(running === 1 ? 'משימה אחת בעבודה' : `${running} משימות בעבודה`);
  // After "בעבודה" the word "משימות" is understood, and the sentence stays within two lines on a phone.
  if (done) parts.push(running ? (done === 1 ? 'אחת הסתיימה ביממה האחרונה' : `${done} הסתיימו ביממה האחרונה`)
    : done === 1 ? 'משימה אחת הסתיימה ביממה האחרונה' : `${done} משימות הסתיימו ביממה האחרונה`);
  if (!parts.length) return 'שקט: אין משימות בעבודה.';
  const last = parts.pop()!;
  return `${parts.length ? `${parts.join(', ')} ו${last.match(/^\d/) ? '-' : ''}${last}` : last}.`;
}
const MORNING = { h: 7, m: 0 };

export class HomeError extends Error {
  status = 400;
}

/** What validation checks references against (the live board). */
export interface HomeRefs {
  projects: Set<string>; identities: Set<string>; inbox: Set<number>; awaiting: Set<number>; shifts?: Set<string>;
  /** "ביקשת" (asked.ts): his requests on the list now, by message id. */
  asked?: Set<string>;
  /** Whether a task id exists (a since item's `task`); unchecked when absent. */
  task?: (id: number) => boolean;
  /** "בעבודה ובתור" (open-tasks.ts): every task not done, by id. */
  open?: Set<number>;
}

const FIELDS: Record<BlockType, { required: string[]; optional: string[] }> = {
  headline: { required: ['text'], optional: [] },
  alert: { required: [], optional: ['inbox', 'shift'] },
  waiting: { required: ['inbox'], optional: [] },
  asked: { required: ['messages'], optional: [] },
  awaiting: { required: ['tasks'], optional: [] },
  tasks: { required: ['tasks'], optional: [] },
  lanes: { required: ['projects'], optional: [] },
  project: { required: ['project'], optional: ['note'] },
  quiet: { required: ['projects'], optional: [] },
  people: { required: ['identities'], optional: ['caption'] },
  since: { required: ['items'], optional: [] },
  note: { required: ['text', 'icon'], optional: [] },
};

/** Material Symbols names are lower_snake_case; anything else (an emoji, a color) is not an icon. */
const ICON = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Strict: unknown block, unknown or missing field, wrong type, dangling reference → HomeError with the reason
 * (in Hebrew, it goes back to the composer as is). Inbox references are checked against open items only when
 * `refs.inbox` is given; one that closed after composition is pruned at read time, not rejected.
 */
export function validateBlocks(raw: unknown, refs: HomeRefs): Block[] {
  if (!Array.isArray(raw)) throw new HomeError('blocks חייב להיות רשימה');
  if (!raw.length) throw new HomeError('blocks ריק: צריך לפחות בלוק אחד');
  if (raw.length > MAX_BLOCKS) throw new HomeError(`יותר מדי בלוקים (${raw.length}), המקסימום ${MAX_BLOCKS}`);
  const out: Block[] = [];
  raw.forEach((b: unknown, i) => {
    const at = `בלוק ${i + 1}`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HomeError(`${at}: חייב להיות אובייקט`);
    const o = b as Record<string, unknown>;
    const type = o.type;
    if (typeof type !== 'string' || !(BLOCK_TYPES as readonly string[]).includes(type)) {
      throw new HomeError(`${at}: סוג לא מוכר "${String(type)}". הסוגים: ${BLOCK_TYPES.join(', ')}`);
    }
    const t = type as BlockType;
    const f = FIELDS[t];
    for (const k of Object.keys(o)) {
      if (k !== 'type' && k !== 'emphasis' && !f.required.includes(k) && !f.optional.includes(k)) throw new HomeError(`${at} (${t}): שדה לא מוכר "${k}"`);
    }
    for (const k of f.required) if (o[k] === undefined || o[k] === null || o[k] === '') throw new HomeError(`${at} (${t}): חסר השדה "${k}"`);
    if (o.emphasis !== undefined && !(EMPHASES as readonly string[]).includes(o.emphasis as string)) {
      throw new HomeError(`${at} (${t}): emphasis חייב להיות ${EMPHASES.join('|')}`);
    }
    const text = (k: string, max: number, oneLine = true): string => {
      const v = o[k];
      if (typeof v !== 'string' || !v.trim()) throw new HomeError(`${at} (${t}): ${k} חייב להיות טקסט`);
      if (v.length > max) throw new HomeError(`${at} (${t}): ${k} ארוך מדי (${v.length} תווים, עד ${max})`);
      if (oneLine && /\n/.test(v)) throw new HomeError(`${at} (${t}): ${k} הוא שורה אחת`);
      return v.trim();
    };
    const optText = (k: string, max: number) => (o[k] === undefined ? undefined : text(k, max));
    const ids = (k: string, known: Set<string>, what: string, min = 1): string[] => {
      const v = o[k];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new HomeError(`${at} (${t}): ${k} חייב להיות רשימת מזהים`);
      if (v.length < min) throw new HomeError(`${at} (${t}): ${k} ריק`);
      for (const x of v as string[]) if (!known.has(x)) throw new HomeError(`${at} (${t}): אין ${what} "${x}"`);
      return [...new Set(v as string[])];
    };
    const inboxId = (v: unknown, where: string): number => {
      if (!Number.isInteger(v) || (v as number) <= 0) throw new HomeError(`${at} (${t}): ${where} חייב להיות מזהה inbox (מספר)`);
      if (!refs.inbox.has(v as number)) throw new HomeError(`${at} (${t}): פריט ה-inbox ${String(v)} לא פתוח`);
      return v as number;
    };
    const emphasis = o.emphasis as Emphasis | undefined;
    const base = emphasis && emphasis !== 'normal' ? { emphasis } : {};
    switch (t) {
      case 'headline': out.push({ type: t, text: text('text', 120), ...base }); break;
      case 'alert': {
        const hasInbox = o.inbox !== undefined, hasShift = o.shift !== undefined;
        if (hasInbox === hasShift) throw new HomeError(`${at} (alert): צריך בדיוק אחד מ-inbox או shift`);
        // An alert on an inbox item is a decision: it waits in the tab. An alert stays only for a fault with none.
        if (hasInbox) break;
        else {
          if (typeof o.shift !== 'string' || !o.shift) throw new HomeError(`${at} (alert): shift חייב להיות מזהה משמרת`);
          if (refs.shifts && !refs.shifts.has(o.shift)) throw new HomeError(`${at} (alert): אין משמרת "${o.shift}"`);
          out.push({ type: t, shift: o.shift, ...base });
        }
        break;
      }
      // Decisions are the app's "החלטות" tab, not the home (task 306): these blocks from an older composer are skipped.
      case 'waiting': case 'asked': case 'awaiting': break;
      case 'tasks': {
        if (o.tasks === 'open') { out.push({ type: t, tasks: 'open', ...base }); break; }
        if (!Array.isArray(o.tasks) || !o.tasks.length || o.tasks.some((x) => !Number.isInteger(x))) {
          throw new HomeError(`${at} (tasks): tasks הוא "open" או רשימת מזהי משימות (מספרים) לא ריקה`);
        }
        for (const x of o.tasks as number[]) if (!refs.open?.has(x)) throw new HomeError(`${at} (tasks): משימה ${x} לא פתוחה`);
        out.push({ type: t, tasks: [...new Set(o.tasks as number[])], ...base });
        break;
      }
      case 'lanes': out.push({ type: t, projects: ids('projects', refs.projects, 'פרויקט'), ...base }); break;
      case 'quiet': out.push({ type: t, projects: ids('projects', refs.projects, 'פרויקט'), ...base }); break;
      case 'project': {
        const p = text('project', 64);
        if (!refs.projects.has(p)) throw new HomeError(`${at} (project): אין פרויקט "${p}"`);
        const note = optText('note', 140);
        out.push({ type: t, project: p, ...(note ? { note } : {}), ...base });
        break;
      }
      case 'people': {
        const caption = optText('caption', 80);
        out.push({ type: t, identities: ids('identities', refs.identities, 'עובד'), ...(caption ? { caption } : {}), ...base });
        break;
      }
      case 'since': {
        // A sentence, or {text, task}: with the task, the line leads to the worker who did it.
        const v = o.items;
        const bad = `${at} (since): items חייב להיות רשימת משפטים, או {text, task}`;
        if (!Array.isArray(v) || !v.length) throw new HomeError(bad);
        if (v.length > 3) throw new HomeError(`${at} (since): עד 3 משפטים (יש ${v.length})`);
        const items = (v as unknown[]).map((x): SinceItem => {
          const r = typeof x === 'string' ? { text: x } : x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
          if (!r || typeof r.text !== 'string' || !r.text.trim()) throw new HomeError(bad);
          for (const k of Object.keys(r)) if (k !== 'text' && k !== 'task') throw new HomeError(`${at} (since): שדה לא מוכר "${k}" (יש text ו-task)`);
          if (r.text.length > 140 || /\n/.test(r.text)) throw new HomeError(`${at} (since): כל משפט שורה אחת, עד 140 תווים`);
          if (r.task === undefined) return { text: r.text.trim() };
          if (!Number.isInteger(r.task) || (r.task as number) <= 0) throw new HomeError(`${at} (since): task הוא מזהה משימה (מספר)`);
          if (refs.task && !refs.task(r.task as number)) throw new HomeError(`${at} (since): אין משימה ${String(r.task)}`);
          return { text: r.text.trim(), task: r.task as number };
        });
        out.push({ type: t, items, ...base });
        break;
      }
      case 'note': {
        const icon = text('icon', 41);
        if (!ICON.test(icon)) throw new HomeError(`${at} (note): icon הוא שם של Material Symbol (למשל rocket_launch), לא "${icon}"`);
        out.push({ type: t, text: text('text', 160), icon, ...base });
        break;
      }
    }
  });
  return out;
}

interface RecipeRow { version: number; composed_by: string; composed_at: number; reason: string | null; blocks: string }

interface PendingEvent { at: number; kind: 'task_started' | 'task_done' | 'inbox' | 'incident' | 'deploy'; text: string; urgent: boolean }

/** Night mode keeps these back for the morning; the rest wake the composer at once. */
const URGENT_KINDS = new Set<PendingEvent['kind']>(['incident', 'inbox']);

export class Home {
  private hq: Hq;
  /** He opened the app while events were held for the morning: the next sweep composes without waiting for 07:00. */
  private openedApp = false;
  constructor(hq: Hq) {
    this.hq = hq;
    hq.store.onEvent((e) => { try { this.observe(e); } catch { /* a listener never breaks writers */ } });
  }

  private get db() { return this.hq.store.db; }

  /** Who composes: the identity whose org.yaml automations hold `compose-home`. The manager may always. */
  composer(): string | null {
    const r = this.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  mayCompose(identity: string): boolean {
    return identity === this.hq.cfg.managerId || identity === this.composer() || identity === 'owner';
  }

  private get toggleKey(): string | null { const c = this.composer(); return c ? `${c}/${AUTOMATION}` : null; }
  enabled(): boolean { const k = this.toggleKey; return !!k && this.hq.store.toggle(k); }

  refs(): HomeRefs {
    return {
      projects: new Set(this.hq.projects().map((p) => p.id)),
      identities: new Set((this.db.prepare('SELECT id FROM identities WHERE active = 1').all() as { id: string }[]).map((r) => r.id)),
      inbox: new Set(this.hq.inbox.open().map((i) => i.id)),
      awaiting: new Set(this.awaitingIds()),
      asked: new Set(this.asked().map((a) => a.id)),
      open: new Set(this.openIds()),
      shifts: new Set((this.db.prepare('SELECT id FROM shifts').all() as { id: string }[]).map((r) => r.id)),
      task: (id) => !!this.db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(id),
    };
  }

  /** "ביקשת" (asked.ts, #118): his open requests to workers, and answers he hasn't read. */
  asked(): AskedItem[] { return askedList(this.hq.store); }

  /**
   * From the scheduler loop: a request turns into one after two minutes without any event, so the app hears of a
   * change in the list (`asked.changed`) from here. Returns whether it changed.
   */
  watchAsked(): boolean {
    const list = this.asked();
    const sig = list.map((a) => `${a.id}:${a.state}:${a.count}`).join(',');
    if (sig === (this.hq.store.getMeta('home.asked') ?? '')) return false;
    this.hq.store.setMeta('home.asked', sig);
    this.hq.store.emit('asked.changed', null, { ids: list.map((a) => a.id) });
    return true;
  }

  private askedTimer: NodeJS.Timeout | null = null;
  /**
   * Out of the emit that triggered it, and once for a burst: emitting from inside another event's listeners would
   * reach the WS first and move its cursor past that event, which then never reaches the app.
   */
  private askedSoon(): void {
    if (this.askedTimer) return;
    this.askedTimer = setTimeout(() => {
      this.askedTimer = null;
      try { this.watchAsked(); }
      catch (e) { try { this.hq.store.emit('loop.error', null, { loop: 'home.asked', error: (e as Error).message }); } catch { /* store closed (hq stopping) */ } }
    }, 200);
    this.askedTimer.unref?.();
  }

  /** "בעבודה ובתור" (open-tasks.ts, #128): every task not done. */
  private openIds(): number[] { return this.hq.openTasks().map((t) => t.id); }

  /** "מה לבדוק" (awaiting.ts, #108): finished tasks that wait for a deploy or for him to check. */
  private awaitingIds(): number[] { return this.hq.awaiting.list().map((t) => t.id); }

  /** PUT: validated, stored as the next version, the board told (the app redraws). */
  compose(blocks: unknown, by: string, reason?: string | null): HomeRecipe {
    const valid = validateBlocks(blocks, this.refs());
    const now = this.hq.store.now();
    const r = this.db.prepare('INSERT INTO home_recipes (composed_by, composed_at, reason, blocks) VALUES (?, ?, ?, ?)')
      .run(by, now, reason?.trim() || null, JSON.stringify(valid));
    const version = Number(r.lastInsertRowid);
    this.db.prepare('DELETE FROM home_recipes WHERE version <= ?').run(version - 200);
    // What was waiting for this composition is now in it.
    this.setPending([]);
    this.hq.store.setMeta('home.composed_at', String(now));
    this.hq.store.emit('home.composed', by, { version, reason: reason ?? null, blocks: valid.length });
    return { version, composed_by: by, composed_at: now, reason: reason?.trim() || null, source: 'agent', blocks: valid };
  }

  latest(): RecipeRow | undefined {
    return this.db.prepare('SELECT * FROM home_recipes ORDER BY version DESC LIMIT 1').get() as RecipeRow | undefined;
  }

  /** The recipe in force right now, with live data applied (closed references gone, new blocking items in). */
  current(): HomeRecipe {
    const now = this.hq.store.now();
    const row = this.latest();
    const refs = this.refs();
    let recipe: HomeRecipe | null = null;
    let fallback: HomeRecipe['fallback'] = 'none';
    if (row && !this.enabled() && row.composed_by === this.composer()) fallback = 'off';
    else if (row && now - row.composed_at > STALE_MS) fallback = 'stale';
    else if (row) {
      try {
        // Inbox references are not re-checked here: a closed one is pruned below, not a reason to drop the recipe.
        const raw = JSON.parse(row.blocks) as unknown;
        const blocks = validateBlocks(raw, { ...refs, inbox: new Set(this.ever(raw, 'inbox')), awaiting: new Set(this.ever(raw, 'tasks')),
          open: new Set(this.ever(raw, 'tasks')), asked: new Set(this.everMessages(raw)) });
        recipe = { version: row.version, composed_by: row.composed_by, composed_at: row.composed_at, reason: row.reason, source: 'agent', blocks };
      } catch { fallback = 'invalid'; }
    }
    recipe ??= { ...this.defaultRecipe(), version: row?.version ?? 0, fallback };
    return { ...recipe, blocks: this.live(recipe.blocks, refs), waiting_changed_at: this.hq.inbox.lastChange() };
  }

  /** Every inbox (or task) id a stored recipe mentions, so re-validation accepts ones that closed since. */
  private ever(raw: unknown, k: 'inbox' | 'tasks'): number[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((b: Record<string, unknown>) => (Array.isArray(b?.[k]) ? b[k] as unknown[] : b?.[k] !== undefined ? [b[k]] : []))
      .filter((x): x is number => Number.isInteger(x));
  }

  /** Every message id a stored recipe's `asked` blocks mention. */
  private everMessages(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((b: Record<string, unknown>) => (b?.type === 'asked' && Array.isArray(b.messages) ? b.messages : []))
      .filter((x): x is string => typeof x === 'string');
  }

  /** Live data wins: what closed disappears, and a blocking item nobody placed yet is shown anyway. */
  live(blocks: Block[], refs: HomeRefs): Block[] {
    const open = this.hq.inbox.open();
    const shiftOk = (id: string) => {
      const s = this.db.prepare('SELECT identity, state, stuck_since FROM shifts WHERE id = ?').get(id) as { identity: string; state: string; stuck_since: number | null } | undefined;
      if (!s) return false;
      if (s.stuck_since) return true;
      // A dead shift stays an alert until a newer one of the same identity is up.
      return s.state === 'dead' && !this.db.prepare(`SELECT 1 FROM shifts WHERE identity = ? AND id != ? AND state IN ('starting','live') LIMIT 1`).get(s.identity, id);
    };
    const out: Block[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case 'alert':
          if (b.inbox === undefined && shiftOk(b.shift!)) out.push(b);
          break;
        case 'waiting': case 'asked': case 'awaiting': break;
        case 'tasks': {
          // "open" follows the list as it is; named tasks leave as they finish.
          if (b.tasks === 'open') { if (refs.open?.size) out.push(b); break; }
          const tasks = b.tasks.filter((i) => refs.open?.has(i));
          if (tasks.length) out.push({ ...b, tasks });
          break;
        }
        case 'lanes': case 'quiet': {
          const projects = b.projects.filter((p) => refs.projects.has(p));
          if (projects.length) out.push({ ...b, projects });
          break;
        }
        case 'project': if (refs.projects.has(b.project)) out.push(b); break;
        case 'people': {
          const identities = b.identities.filter((i) => refs.identities.has(i));
          if (identities.length) out.push({ ...b, identities });
          break;
        }
        default: out.push(b);
      }
    }
    return out;
  }

  /**
   * hq's own recipe, from facts only, kept short (he said the full one was «בלאגן»): one sentence, the alert and
   * what waits for him, a line per project something happened in over the last day, two things that finished,
   * and the other active projects folded into one line at the end.
   * The task lists, the lanes and "מה לבדוק" are on the status screen, not here.
   */
  defaultRecipe(): HomeRecipe {
    const now = this.hq.store.now();
    const dayAgo = now - DAY_MS;
    const blocks: Block[] = [];
    let alert: Block | null = null;
    {
      const stuck = this.db.prepare(`SELECT id FROM shifts WHERE state IN ('starting','live') AND stuck_since IS NOT NULL ORDER BY stuck_since LIMIT 1`).get() as { id: string } | undefined;
      if (stuck) alert = { type: 'alert', shift: stuck.id };
    }
    const running = this.hq.openTasks().filter((t) => t.state === 'running');
    const done = this.db.prepare(`SELECT id, project, summary FROM tasks WHERE state = 'done' AND summary IS NOT NULL AND summary != '' AND updated_at > ?
      ORDER BY updated_at DESC, id DESC`).all(dayAgo) as { id: number; project: string | null; summary: string }[];
    blocks.push({ type: 'headline', text: headline(running.length, done.length, !!alert) });
    if (alert) blocks.push(alert);
    const known = new Set(this.hq.projects().map((p) => p.id));
    const moved = (this.db.prepare(`SELECT project FROM tasks WHERE project IS NOT NULL AND updated_at > ? GROUP BY project ORDER BY MAX(updated_at) DESC`)
      .all(dayAgo) as { project: string }[]).map((r) => r.project).filter((p) => known.has(p));
    for (const p of moved) {
      // What finished last there, else what is running there now.
      const last = done.find((d) => d.project === p)?.summary ?? running.find((t) => t.project === p)?.title;
      const note = last ? firstLine(last, 80) : '';
      blocks.push({ type: 'project', project: p, ...(note ? { note } : {}) });
    }
    const since = done.map((d) => ({ text: firstLine(d.summary, 140), task: d.id })).filter((i) => i.text).slice(0, 2);
    if (since.length) blocks.push({ type: 'since', items: since });
    // The rest are not gone: one line at the end, "שקט גם ב: …", each name leads to its project.
    const quiet = this.hq.projects().filter((p) => p.status === 'active' && !moved.includes(p.id)).map((p) => p.id);
    // Over the cap, the quiet line stays and what is cut is before it.
    const capped = blocks.slice(0, quiet.length ? MAX_BLOCKS - 1 : MAX_BLOCKS);
    if (quiet.length) capped.push({ type: 'quiet', projects: quiet });
    return { version: 0, composed_by: 'hq', composed_at: now, reason: null, source: 'default', blocks: capped };
  }

  // ── waking the composer ────────────────────────────────────────────────────

  private pending(): PendingEvent[] {
    try { return JSON.parse(this.hq.store.getMeta('home.pending') ?? '[]') as PendingEvent[]; } catch { return []; }
  }
  private setPending(p: PendingEvent[]): void { this.hq.store.setMeta('home.pending', JSON.stringify(p.slice(-40))); }

  private add(e: Omit<PendingEvent, 'at' | 'urgent'>): void {
    if (!this.enabled()) return;
    this.setPending([...this.pending(), { ...e, at: this.hq.store.now(), urgent: URGENT_KINDS.has(e.kind) }]);
  }

  private taskLine(id: number): { title: string; summary: string | null; who: string | null } | undefined {
    const t = this.db.prepare('SELECT title, summary, identity FROM tasks WHERE id = ?').get(id) as { title: string; summary: string | null; identity: string | null } | undefined;
    return t ? { title: t.title, summary: t.summary, who: t.identity ? this.hq.mailbox.label(t.identity) : null } : undefined;
  }

  /** The events that matter, turned into lines for the composer. Night: a task that started is not one. */
  observe(e: HqEvent): void {
    const d = (e.data ?? {}) as Record<string, unknown>;
    switch (e.type) {
      // An answer came, or he read it: the list changes now, not at the next sweep.
      case 'message.new': case 'message.state': if (d.from === OWNER || d.to === OWNER || d.from_identity === OWNER || d.to_identity === OWNER) this.askedSoon(); return;
      case 'conv.read': this.askedSoon(); return;
      case 'task.state': {
        const t = typeof d.id === 'number' ? this.taskLine(d.id) : undefined;
        if (!t) return;
        if (d.state === 'running' && d.shift) {
          if (this.quiet()) return;
          this.add({ kind: 'task_started', text: `משימה התחילה: ${t.title}${t.who ? ` (${t.who})` : ''}` });
        } else if (d.state === 'done') {
          this.add({ kind: 'task_done', text: `משימה הסתיימה: ${t.summary ?? t.title}${t.who ? ` (${t.who})` : ''}` });
        }
        return;
      }
      case 'inbox.new': {
        const kind = d.kind === 'incident' ? 'incident' : 'inbox';
        this.add({ kind, text: `${kind === 'incident' ? 'תקלה' : `מחכה ${pre('ל', this.hq.mailbox.names.owner.name)}`}: ${String(d.headline ?? d.title ?? '')} (inbox ${String(d.id)})` });
        return;
      }
      case 'probe.anomaly': this.add({ kind: 'incident', text: `תקלה בניטור: ${String(d.probe ?? '')}` }); return;
      case 'watchdog.dead': this.add({ kind: 'incident', text: `משמרת נפלה: ${e.identity ? this.hq.mailbox.label(e.identity) : ''} (${String(d.shift ?? '')})` }); return;
      case 'deploy.recorded': this.add({ kind: 'deploy', text: `פריסה: ${String(d.project ?? '')}${d.target ? ` (${String(d.target)})` : ''}` }); return;
      case 'hq.started': this.add({ kind: 'deploy', text: 'hq עלה מחדש (פריסה או אתחול)' }); return;
      case 'inbox.completed': {
        const item = typeof d.id === 'number' ? this.hq.inbox.get(d.id) : undefined;
        if (item?.kind === 'go' && !d.declined) {
          const o = this.hq.mailbox.names.owner;
          this.add({ kind: 'deploy', text: `${o.name} ${g(o, 'אישר', 'אישרה')} GO: ${item.headline ?? item.title}` });
        }
        return;
      }
    }
  }

  private tz(): string { return this.hq.timeZone(); }

  /** Night mode, before 07:00 of the morning after it started, and he hasn't opened the app since. */
  quiet(): boolean {
    const night = this.hq.night.current();
    if (!night) return false;
    return this.hq.store.now() < nextLocal(night.started_at, MORNING.h, MORNING.m, this.tz());
  }

  /** He opened the app (GET /api/home from a device): a batch held for the morning goes now. */
  opened(): void {
    if (this.pending().length) { this.openedApp = true; this.hq.store.bg(Promise.resolve().then(() => this.sweep()), 'home.sweep'); }
  }

  /** From the scheduler loop (every minute) and on app open. Returns whether the composer was woken. */
  sweep(): boolean {
    const composer = this.composer();
    if (!composer || !this.enabled()) { if (this.pending().length) this.setPending([]); return false; }
    const pending = this.pending();
    if (!pending.length) return false;
    const now = this.hq.store.now();
    const last = Number(this.hq.store.getMeta('home.woken_at') ?? 0);
    if (now - last < WAKE_EVERY_MS) return false;
    if (this.quiet() && !this.openedApp && !pending.some((p) => p.urgent)) return false;
    this.openedApp = false;
    this.hq.store.setMeta('home.woken_at', String(now));
    this.setPending([]);
    this.hq.mailbox.tell({ msg_id: `home-wake-${now}`, from: 'hq', to: composer, kind: 'system', priority: 'next', body: this.wakeBody(pending) });
    this.hq.store.emit('home.woken', composer, { events: pending.length });
    return true;
  }

  private hhmm(ts: number): string { return hhmm(ts, this.tz()); }

  /** Everything the composer needs in one message: what happened, what the screen shows now, what it may point at. */
  wakeBody(pending: PendingEvent[]): string {
    const row = this.latest();
    const cur = this.current();
    const board = this.hq.board();
    const working = board.filter((b) => b.status === 'working').map((b) => `${b.id} (${b.name})`);
    const projects = this.hq.projects().map((p) => `${p.id}${p.name ? ` (${p.name})` : ''}${p.status !== 'active' ? ` · ${p.status}` : ''}`);
    const asked = this.asked().map((a) => `${a.id}: ${this.hq.mailbox.label(a.identity)} · ${a.state === 'answered' ? 'ענו' : 'מחכה'} · ${a.body.replace(/\s+/g, ' ').slice(0, 60)}`);
    const inbox = this.hq.inbox.open().map((i) => `${i.id}: ${i.kind}${i.blocking ? ' · חוסם' : ''}${i.snoozed_at ? ' · נדחה' : ''} · ${i.headline ?? i.title}`);
    const open = this.hq.openTasks(board).map((t) => `${t.id}: ${t.title} · ${t.state}${t.position ? ` ${t.position} בתור` : ''}`
      + `${t.worker ? ` · ${this.hq.mailbox.label(t.worker)}` : ''}${t.opened_by ? ` · פתח ${this.hq.mailbox.label(t.opened_by)}` : ''}`);
    return [
      `להרכיב מחדש את ראש מסך השיחות של ${this.hq.mailbox.names.owner.name} (\`compose_home\`). מאז ההרכבה הקודמת${row ? ` (${this.hhmm(row.composed_at)})` : ''}:`,
      ...pending.map((p) => `- ${this.hhmm(p.at)} ${p.text}`),
      '',
      `מה מוצג עכשיו (${cur.source === 'agent' ? `מתכון ${cur.version}` : `ברירת המחדל${cur.fallback && cur.fallback !== 'none' ? `, ${cur.fallback}` : ''}`}):`,
      '```json', JSON.stringify(cur.blocks), '```',
      `inbox פתוח: ${inbox.length ? '' : 'אין'}`, ...inbox.map((l) => `- ${l}`),
      `ביקשת (asked): ${asked.length ? '' : 'אין'}`, ...asked.map((l) => `- ${l}`),
      `בעבודה ובתור (tasks): ${open.length ? '' : 'אין'}`, ...open.map((l) => `- ${l}`),
      `פרויקטים: ${projects.join(', ') || 'אין'}`,
      `עובדים עכשיו: ${working.join(', ') || 'אף אחד'}`,
      'אם אין מה לשנות, לא צריך לקרוא לכלי. מתכון ישן מ-30 דקות מתחלף בברירת המחדל.',
    ].join('\n');
  }
}
