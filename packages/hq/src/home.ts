// The head of his conversations screen, composed by an agent (server-driven UI). hq keeps a recipe of blocks
// from a fixed vocabulary; the app draws each block from its own designed component and fills it from the live
// board, so an agent picks what to show, in what order and in what words, but never how it looks.
//   GET /api/home  → the recipe in force: the composer's, or the deterministic default (none, older than 30
//                    minutes, or no longer valid). Live data wins: a block whose inbox item closed is gone.
//   PUT /api/home  → a new recipe; strict validation, 400 with the reason.
// The automation `home-headline` in org.yaml (on עדי, who may also compose by hand) has hq write the recipe itself,
// from facts and without a model (`sentence`): no worker is woken for it. A recipe composed by hand (`compose_home`)
// wins while it is fresh. Switched off: the plain default, and the app writes its own sentence.
import { OWNER, pre, type HqEvent } from '@company/shared';
import type { Hq } from './hq.ts';
import { CANCELLED_SQL } from './scheduler.ts';
import { askedList, type AskedItem } from './asked.ts';
import { usage, sufficientUntil, type Usage } from './usage.ts';

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
  /**
   * `agent`: composed by hand (`compose_home`). `hq`: hq's own with its sentence (`home-headline` on). `default`: hq's
   * own while it is off, the app writes the sentence. With hq or default, `fallback` says why not the hand-composed one.
   */
  source: 'agent' | 'hq' | 'default';
  fallback?: 'none' | 'stale' | 'invalid';
  blocks: Block[];
  /** When what waits for him last changed (inbox.lastChange): a headline composed before it may no longer be true. */
  waiting_changed_at?: number | null;
  /** The Claude accounts' quota, live (accounts.ts quota()): the app's "המכסה" card under the projects. */
  quota?: QuotaLine[];
  /** How fast the quota goes and on what (usage.ts): the app's "השימוש" card next to "המכסה". */
  usage?: Usage;
}

export interface QuotaLine {
  name: string; label: string; usable: boolean; full: boolean; reopens_at: number | null;
  five_hour_pct: number | null; seven_day_pct: number | null; five_hour_resets_at: number | null; seven_day_resets_at: number | null;
  snapshot_at: number | null;
  /** A line of its own under the windows (Codex: new tasks are not sent to it until the reset). */
  note?: string;
}

export const STALE_MS = 30 * 60_000;
export const MAX_BLOCKS = 12;
export const AUTOMATION = 'home-headline';
/** Before it hq woke the composer to write the recipe (switched off 24/10: 42% of עדי's use). Still names who may compose. */
const LEGACY_AUTOMATION = 'compose-home';
/** Opens of the app closer than this are one visit: "מאז שהיית פה" counts from the end of the one before. */
export const VISIT_GAP_MS = 20 * 60_000;
const DAY_MS = 24 * 3_600_000;

const firstLine = (s: string, max: number): string => (s.split('\n').map((l) => l.trim()).find(Boolean) ?? '').slice(0, max);
/** Cut at a word, with "…": a name in the sentence on top stays within its two lines. A quote it would leave open is cut before. */
const clip = (s: string, max: number): string => {
  if (s.length <= max) return s;
  let c = s.slice(0, max + 1).replace(/\s+\S*$/, '');
  if ((c.match(/"/g) ?? []).length % 2) c = c.slice(0, c.lastIndexOf('"'));
  return `${c.replace(/[\s,;:–-]+$/, '')}…`;
};


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

export class Home {
  private hq: Hq;
  constructor(hq: Hq) {
    this.hq = hq;
    hq.store.onEvent((e) => { try { this.observe(e); } catch { /* a listener never breaks writers */ } });
  }

  private get db() { return this.hq.store.db; }

  /** Who may compose by hand: the identity whose org.yaml automations hold `home-headline` (or, before it, `compose-home`). The manager may always. */
  composer(): string | null {
    for (const a of [AUTOMATION, LEGACY_AUTOMATION]) {
      const r = this.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${a}`) as { key: string } | undefined;
      if (r) return r.key.slice(0, -(a.length + 1));
    }
    return null;
  }

  mayCompose(identity: string): boolean {
    return identity === this.hq.cfg.managerId || identity === this.composer() || identity === 'owner';
  }

  /** `home-headline` is on: hq writes the sentence. */
  enabled(): boolean {
    const r = this.db.prepare(`SELECT enabled FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { enabled: number } | undefined;
    return r?.enabled === 1;
  }

  refs(): HomeRefs {
    return {
      projects: new Set(this.hq.projects().map((p) => p.id)),
      identities: new Set((this.db.prepare('SELECT id FROM identities WHERE active = 1').all() as { id: string }[]).map((r) => r.id)),
      inbox: new Set(this.hq.inbox.mine().map((i) => i.id)),
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
    if (row && now - row.composed_at > STALE_MS) fallback = 'stale';
    else if (row) {
      try {
        // Inbox references are not re-checked here: a closed one is pruned below, not a reason to drop the recipe.
        const raw = JSON.parse(row.blocks) as unknown;
        const blocks = validateBlocks(raw, { ...refs, inbox: new Set(this.ever(raw, 'inbox')), awaiting: new Set(this.ever(raw, 'tasks')),
          open: new Set(this.ever(raw, 'tasks')), asked: new Set(this.everMessages(raw)) });
        recipe = { version: row.version, composed_by: row.composed_by, composed_at: row.composed_at, reason: row.reason, source: 'agent', blocks };
      } catch { fallback = 'invalid'; }
    }
    recipe ??= { ...this.defaultRecipe(), version: row?.version ?? 0, fallback, ...(this.enabled() ? { source: 'hq' as const } : {}) };
    return { ...recipe, blocks: this.live(recipe.blocks, refs), waiting_changed_at: this.hq.inbox.lastChange(), quota: this.quota(),
      usage: this.usage() };
  }

  /** The Claude accounts, then Codex's week (codex-quota.ts) once it has been read: the app's "המכסה" card. */
  private quota(): QuotaLine[] {
    const codex = this.hq.codexQuota.line();
    return [...this.hq.accounts.quota(), ...(codex ? [codex] : [])];
  }

  /** usage.ts reads a day of events: once a minute is enough for a card that moves with the 10-minute quota read. */
  private usageMemo: Usage | null = null;
  private usage(): Usage {
    const now = this.hq.store.now();
    if (this.usageMemo && now - this.usageMemo.measured_at < 60_000) return this.usageMemo;
    const accounts = this.hq.accounts.quota().filter((q) => q.usable).map((q) => q.name);
    this.usageMemo = usage(this.hq.store, accounts, (id) => this.hq.mailbox.label(id));
    const snapshots = this.hq.accounts.capacity();
    const known = snapshots.filter(a => a.seven_day_pct != null && a.seven_day_resets_at != null);
    const remaining = known.length ? known.reduce((n, a) => n + 100 - a.seven_day_pct!, 0) / known.length : null;
    const reset = known.length ? Math.min(...known.map(a => a.seven_day_resets_at!)) : null;
    this.usageMemo.sufficient_until = sufficientUntil(now, this.usageMemo.day_pct, remaining, reset);
    return this.usageMemo;
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
    const open = this.hq.inbox.mine();
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
    const done = this.db.prepare(`SELECT id, project, summary FROM tasks WHERE state = 'done' AND NOT ${CANCELLED_SQL} AND summary IS NOT NULL AND summary != '' AND updated_at > ?
      ORDER BY updated_at DESC, id DESC`).all(dayAgo) as { id: number; project: string | null; summary: string }[];
    blocks.push({ type: 'headline', text: sentence(this.facts()) });
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

  /** An answer came, or he read it: the "ביקשת" list changes now, not at the next sweep. */
  observe(e: HqEvent): void {
    const d = (e.data ?? {}) as Record<string, unknown>;
    if ((e.type === 'message.new' || e.type === 'message.state') && (d.from === OWNER || d.to === OWNER || d.from_identity === OWNER || d.to_identity === OWNER)) this.askedSoon();
    else if (e.type === 'conv.read') this.askedSoon();
  }

  /** When he opened the app last, and where the visit before it ended: "מאז שהיית פה" counts from there. */
  visitedFrom(): number | null {
    const v = Number(this.hq.store.getMeta('home.visit_prev') ?? 0);
    return v > 0 ? v : null;
  }

  /**
   * GET /api/home from a device that says he looks at it. `opened`: he opened the app or brought it to the front;
   * more than VISIT_GAP_MS after he was last seen, that is a new visit, and the one before ended then. Else it is
   * the minute's reload while he looks (`?looking=1`): it only keeps the visit going, so a long sitting ends where he
   * left, not where he came in. A reload on an event (the app may be open behind) does not call this.
   */
  seen(opened: boolean): void {
    const now = this.hq.store.now();
    const last = Number(this.hq.store.getMeta('home.visit_at') ?? 0);
    if (opened) {
      if (last && now - last > VISIT_GAP_MS) this.hq.store.setMeta('home.visit_prev', String(last));
      this.hq.store.setMeta('home.visit_at', String(now));
    } else if (last && now - last <= VISIT_GAP_MS) this.hq.store.setMeta('home.visit_at', String(now));
  }

  /** The facts the sentence on top is written from: what waits for him, what runs and where, what finished since he was here. */
  facts(): HomeFacts {
    const now = this.hq.store.now();
    const from = this.visitedFrom();
    const names = new Map(this.hq.projects().map((p) => [p.id, p.name ?? p.id]));
    // As the app counts them (backend.dart waitingCount): not put off, and a GO with a newer one open from the same
    // worker is replaced by it (#258), so the sentence never contradicts the count in front of it.
    const open = this.hq.inbox.mine();
    const superseded = (i: (typeof open)[number]) => i.kind === 'go'
      && open.some((x) => x.id !== i.id && x.kind === 'go' && x.from_identity === i.from_identity && (x.created_at > i.created_at || (x.created_at === i.created_at && x.id > i.id)));
    const waiting = open.filter((i) => !i.snoozed_at && !superseded(i));
    const running = this.hq.openTasks().filter((t) => t.state === 'running');
    const since = from ?? now - DAY_MS;
    const done = (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE state = 'done' AND NOT ${CANCELLED_SQL} AND updated_at > ?`).get(since) as { n: number }).n;
    const stuck = (this.db.prepare(`SELECT COUNT(DISTINCT identity) AS n FROM shifts WHERE state IN ('starting','live') AND stuck_since IS NOT NULL`).get() as { n: number }).n;
    const gos = waiting.filter((i) => i.kind === 'go');
    // The one to name: the only thing waiting, else the only GO among them, and whether it is first in line.
    const one = waiting.length === 1 ? waiting[0]! : gos.length === 1 ? gos[0]! : null;
    return {
      waiting: waiting.length,
      gos: gos.length,
      ...(one ? { decision: { kind: one.kind, text: clip(firstLine(one.headline ?? one.title, 200), 60), first: waiting[0] === one } } : {}),
      running: running.length,
      where: [...new Set(running.map((t) => t.project).filter((p): p is string => !!p))].map((p) => names.get(p) ?? p),
      done,
      visited: !!from,
      stuck,
    };
  }
}

/** What the sentence on top is written from (Home.facts). */
export interface HomeFacts {
  /** Open items in "מחכה לך" that were not put off; the app leads with their count. */
  waiting: number;
  /** How many of them are a GO. */
  gos?: number;
  /** The one that waits, when there is exactly one; else the only GO among them, and whether it is first in line. */
  decision?: { kind: string; text: string; first?: boolean };
  running: number;
  /** The display names of the projects tasks run in. */
  where: string[];
  /** Tasks that finished since he was here (or in the last day). */
  done: number;
  /** Whether hq knows when he was here last; without it, "ביממה האחרונה". */
  visited: boolean;
  /** Workers who are stuck (the app puts its own sentence on top then; this is for any other reader). */
  stuck: number;
}

const count = (n: number, one: string, two: string, many: string): string => (n === 1 ? one : n === 2 ? two : `${n} ${many}`);
/** "ב" before a name: בלומו, ב-tiki-bot-go, and בחברה, not בהחברה (the ה is swallowed). */
const inName = (prefix: string, name: string): string => (/^ה[֐-׿]/.test(name) ? `${prefix}${name.slice(1)}` : pre(prefix, name));
const KIND_WORD: Record<string, string> = { go: 'GO', ask: 'שאלה', login: 'כניסה', incident: 'תקלה' };

/**
 * The sentence on top of his conversations screen, from facts, without a model. The app puts "החלטה אחת מחכה לך."
 * in front of it from its own live count, so with something waiting this names it (when it is one) and goes on to
 * the rest; with nothing waiting it says so. A person's sentence, not a log line: "שתי משימות רצות בלומו ובחברה, ושום
 * דבר לא מחכה לך."
 */
export function sentence(f: HomeFacts, max = 100): string {
  const build = (names: boolean, decision: boolean, finished: boolean): string => {
    const parts: string[] = [];
    if (f.stuck) parts.push(`${count(f.stuck, 'עובד אחד תקוע', 'שני עובדים תקועים', 'עובדים תקועים')}.`);
    const gos = f.gos ?? 0;
    // The one that waits, by name: "GO: …" when it is the only one, "בראש התור: …" when it is the only GO of many
    // (two colons in a row read like code; the card itself says GO). "GO: GO: …" reads like a log: the word once.
    const named = (lead: string | null): string => {
      if (!f.decision) return '';
      const w = KIND_WORD[f.decision.kind];
      const raw = f.decision.text.replace(/[.\s]+$/, '');
      const t = w ? raw.replace(new RegExp(`^${w}:\\s*`, 'i'), '') : raw;
      return `${lead ?? (w ? `${w}:` : '')}${lead ?? w ? ' ' : ''}${t}${/[?!…]$/.test(t) ? '' : '.'}`;
    };
    if (f.waiting === 1) { if (decision) parts.push(named(null)); }
    else if (f.waiting > 1 && gos) {
      // What the many are: "בראש התור: …" when the one GO is first, else "אחת מהן היא בקשת GO: …"; "3 מהן GO.", "כולן GO."
      parts.push(gos === 1 ? (decision && f.decision ? named(f.decision.first ? 'בראש התור:' : 'אחת מהן היא בקשת GO:') : 'אחת מהן היא בקשת GO.')
        : gos === f.waiting ? (gos === 2 ? 'שתיהן GO.' : 'כולן GO.') : `${gos} מהן GO.`);
    }
    const said = !!f.done && finished;
    if (said) parts.push(`${f.visited ? 'מאז שהיית פה' : 'ביממה האחרונה'} ${f.done === 1 ? 'הסתיימה משימה אחת' : `הסתיימו ${count(f.done, '', 'שתי משימות', 'משימות')}`}.`);
    const where = !names || !f.where.length ? '' : f.where.length === 1 ? ` ${inName('ב', f.where[0]!)}`
      : f.where.length === 2 ? ` ${inName('ב', f.where[0]!)} ${inName('וב', f.where[1]!)}` : ` ב-${f.where.length} פרויקטים`;
    // After a sentence on what finished, "משימות" is said: "בינתיים 11 רצות", never "250 משימות. 11 משימות".
    const run = !f.running ? '' : `${said ? count(f.running, 'אחת רצה', 'שתיים רצות', 'רצות') : count(f.running, 'משימה אחת רצה', 'שתי משימות רצות', 'משימות רצות')}${where}`;
    if (f.waiting) { if (run) parts.push(`בינתיים ${run}.`); }
    else if (run) parts.push(`${said ? 'בינתיים ' : ''}${run}, ושום דבר לא מחכה לך.`);
    else parts.push(said || f.stuck ? 'שום דבר לא מחכה לך.' : 'הכול שקט, ושום דבר לא מחכה לך.');
    return parts.join(' ');
  };
  // Too long for two lines on a phone: the project names go first, then what finished (it is listed below), then
  // the name of what waits.
  for (const [names, decision, finished] of [[true, true, true], [false, true, true], [false, true, false], [false, false, false]] as const) {
    const s = build(names, decision, finished);
    if (s.length <= max) return s;
  }
  return build(false, false, false).slice(0, max);
}
