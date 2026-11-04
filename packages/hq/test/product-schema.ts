import type { Store } from '../src/store.ts';
/** Migration replay fixtures start before phase A. */
export function dropProductSchema(store: Store) {
  for (const [table, columns] of Object.entries({messages:['alert_hint'],tasks:['for_owner','owner_done_at'],conversations:['alert_level','last_sound_at','pending_alert','pending_due']})) {
    const have = new Set((store.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).map(c=>c.name));
    for (const column of columns) if (have.has(column)) store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}
