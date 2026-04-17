import type { Serializer } from "./types.js";
import { encodeVarint, varintSize, decodeVarint } from "./protocol.js";

const te = new TextEncoder();
const td = new TextDecoder();

// ── Entry Span Types ────────────────────────────────────────────────

export interface EntrySpan {
  start: number;
  end: number;
}

export interface MapEntrySpan {
  key: string;
  start: number;
  end: number;
}

// ── Buffer Splice ───────────────────────────────────────────────────

export function applySpliceToBuffer(
  raw: Uint8Array<ArrayBufferLike>,
  offset: number,
  deleteCount: number,
  data: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  const newLen = raw.length - deleteCount + data.length;
  const buf = new Uint8Array(newLen);
  buf.set(raw.subarray(0, offset));
  buf.set(data, offset);
  buf.set(raw.subarray(offset + deleteCount), offset + data.length);
  return buf;
}

// ── List Entry Encoding/Decoding ────────────────────────────────────

export function encodeEntry(value: Uint8Array): Uint8Array {
  const lenSize = varintSize(value.length);
  const buf = new Uint8Array(lenSize + value.length);
  encodeVarint(buf, 0, value.length);
  buf.set(value, lenSize);
  return buf;
}

export function encodeEntries<T>(
  items: T[],
  serializer: Serializer<T>,
): Uint8Array {
  if (items.length === 0) return new Uint8Array(0);

  // Pre-encode all items to calculate total size
  const encoded: Uint8Array[] = new Array(items.length);
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    const data = serializer.encode(items[i]);
    encoded[i] = data;
    total += varintSize(data.length) + data.length;
  }

  // Write directly into a single buffer
  const buf = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < encoded.length; i++) {
    const data = encoded[i];
    pos = encodeVarint(buf, pos, data.length);
    buf.set(data, pos);
    pos += data.length;
  }
  return buf;
}

export function parseListEntries<T>(
  buf: Uint8Array<ArrayBufferLike>,
  serializer: Serializer<T>,
): { items: T[]; spans: EntrySpan[]; corrupt: boolean } {
  const items: T[] = [];
  const spans: EntrySpan[] = [];
  let pos = 0;
  try {
    while (pos < buf.length) {
      const start = pos;
      const len = decodeVarint(buf, pos);
      const end = len.pos + len.value;
      if (end > buf.length) return { items, spans, corrupt: true };
      const data = buf.subarray(len.pos, end);
      items.push(serializer.decode(data));
      spans.push({ start, end });
      pos = end;
    }
  } catch {
    return { items, spans, corrupt: true };
  }
  return { items, spans, corrupt: false };
}

// ── Map Entry Encoding/Decoding ─────────────────────────────────────

export function encodeMapEntry<V>(
  key: string,
  value: V,
  serializer: Serializer<V>,
): Uint8Array {
  const keyBytes = te.encode(key);
  const valBytes = serializer.encode(value);
  const keyLenSize = varintSize(keyBytes.length);
  const valLenSize = varintSize(valBytes.length);
  const buf = new Uint8Array(
    keyLenSize + keyBytes.length + valLenSize + valBytes.length,
  );
  let pos = encodeVarint(buf, 0, keyBytes.length);
  buf.set(keyBytes, pos);
  pos += keyBytes.length;
  pos = encodeVarint(buf, pos, valBytes.length);
  buf.set(valBytes, pos);
  return buf;
}

export function parseMapEntries<V>(
  buf: Uint8Array<ArrayBufferLike>,
  serializer: Serializer<V>,
): { entries: Map<string, V>; spans: MapEntrySpan[]; corrupt: boolean } {
  const entries = new Map<string, V>();
  const spans: MapEntrySpan[] = [];
  let pos = 0;
  try {
    while (pos < buf.length) {
      const start = pos;
      const keyLen = decodeVarint(buf, pos);
      const keyEnd = keyLen.pos + keyLen.value;
      if (keyEnd > buf.length) return { entries, spans, corrupt: true };
      const key = td.decode(buf.subarray(keyLen.pos, keyEnd));
      pos = keyEnd;
      const valLen = decodeVarint(buf, pos);
      const valEnd = valLen.pos + valLen.value;
      if (valEnd > buf.length) return { entries, spans, corrupt: true };
      const valData = buf.subarray(valLen.pos, valEnd);
      entries.set(key, serializer.decode(valData));
      spans.push({ key, start, end: valEnd });
      pos = valEnd;
    }
  } catch {
    return { entries, spans, corrupt: true };
  }
  return { entries, spans, corrupt: false };
}

/** Walks varint-length-prefixed structure without deserializing values. */
export function validateBuffer(buf: Uint8Array<ArrayBufferLike>): boolean {
  let pos = 0;
  try {
    while (pos < buf.length) {
      const len = decodeVarint(buf, pos);
      const end = len.pos + len.value;
      if (end > buf.length) return false;
      pos = end;
    }
  } catch {
    return false;
  }
  return true;
}
