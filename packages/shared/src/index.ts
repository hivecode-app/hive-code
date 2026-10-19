// Shared types between hq, shift-host, adapter, mcp-company and hooks.
// Owner of this file: the hq build lane. Other lanes may ADD types; do not rename existing ones.
export type IdentityId = string;   // e.g. "yoav", "rotem", "eli"
export type ShiftId = string;      // `${IdentityId}-${n}`
export type MessageState = 'queued' | 'delivered' | 'read' | 'handled' | 'failed';
export * from './shift-protocol.ts';
