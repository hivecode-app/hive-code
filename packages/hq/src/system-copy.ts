const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The owner's event lines describe the outcome. Routing keys stay in structured fields. `machines`: the servers' own
 *  names (this machine's hostname, its nodes, the probe witness), which read as "השרת". */
export function ownerSystemCopy(text: string, nameOf: (id: string) => string, machines: readonly string[] = []): string {
  const names = machines.filter((m) => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(m));
  return text
    .replace(/\b(?:[a-z][a-z0-9-]*-)?t\d+(?:-\d+)?\b/gi, (id) => { const name = nameOf(id); return name === id ? 'המשימה' : name; })
    .replace(names.length ? new RegExp(`\\b(?:${names.map(escape).join('|')})\\b`, 'g') : /(?!)/, 'השרת')
    .replace(/\bmsg_id\b/g, 'מזהה ההודעה')
    .replace(/(?<![\p{L}\p{N}_])(?:branch|ענף)(?![\p{L}\p{N}_])\s*[:=]?\s*`?[A-Za-z0-9][A-Za-z0-9/_.-]*`?/gu, 'ענף העבודה')
    .replace(/\b(?:m|task|inbox)-[a-z0-9][a-z0-9:-]*\b/gi, 'הפריט');
}
