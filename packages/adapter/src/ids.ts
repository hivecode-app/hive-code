import { createHash, randomUUID } from 'node:crypto';

/** Namespace for shift session ids (fixed forever; changing it orphans every shift). */
export const SHIFT_NAMESPACE = 'b7c0a3e4-5d1f-5e2a-9c6b-1f0d2e3a4c5b';

function uuidBytes(u: string): Buffer {
  const hex = u.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a uuid: ${u}`);
  return Buffer.from(hex, 'hex');
}

function fmt(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** RFC 4122 v5 (SHA-1, name-based). */
export function uuidv5(name: string, namespace: string = SHIFT_NAMESPACE): string {
  const h = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf8').digest().subarray(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  return fmt(Buffer.from(h));
}

/**
 * B.2: session id = uuidv5(ns, identity + ":" + shift_no). `shiftNo` MUST come
 * from the store (monotonic, never recomputed from local state): bet 1 hit
 * "Session ID already in use" when a number was reused and the shift silently
 * did nothing. After a store reset, bump `epoch` so old transcripts never collide.
 */
export function shiftSessionId(identity: string, shiftNo: number, epoch = 0): string {
  if (!Number.isInteger(shiftNo) || shiftNo < 1) throw new Error(`bad shift number ${shiftNo}`);
  return uuidv5(epoch ? `${identity}:e${epoch}:${shiftNo}` : `${identity}:${shiftNo}`);
}

export const newUuid = (): string => randomUUID();
