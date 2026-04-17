import { PicoError } from "./errors.js";
import type { Response } from "./types.js";

const te = new TextEncoder();
const td = new TextDecoder();

// ── Varint Encoding/Decoding (unsigned LEB128) ─────────────────────

export function encodeVarint(
  buf: Uint8Array<ArrayBufferLike>,
  pos: number,
  value: number,
): number {
  while (value >= 0x80) {
    buf[pos++] = (value & 0x7f) | 0x80;
    value >>>= 7;
  }
  buf[pos++] = value;
  return pos;
}

export function varintSize(value: number): number {
  let size = 1;
  while (value >= 0x80) {
    size++;
    value >>>= 7;
  }
  return size;
}

export function decodeVarint(
  buf: Uint8Array<ArrayBufferLike>,
  pos: number,
): { value: number; pos: number } {
  let value = 0;
  let shift = 0;
  while (true) {
    if (pos >= buf.length) throw new PicoError(0, "unexpected end of input");
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new PicoError(0, "varint too large");
  }
  return { value: value >>> 0, pos };
}

// ── Encoder ─────────────────────────────────────────────────────────

export class Encoder {
  private buf: Uint8Array;
  private pos = 0;

  constructor() {
    this.buf = new Uint8Array(256);
  }

  private ensure(n: number) {
    if (this.pos + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
      next.set(this.buf);
      this.buf = next;
    }
  }

  private writeU8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  private writeBytes(data: Uint8Array) {
    const lenSize = varintSize(data.length);
    this.ensure(lenSize + data.length);
    this.pos = encodeVarint(this.buf, this.pos, data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  private writeStr(s: string) {
    this.writeBytes(te.encode(s));
  }

  private writeVarint(value: number) {
    this.ensure(10);
    this.pos = encodeVarint(this.buf, this.pos, value);
  }

  private finish(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.pos) as Uint8Array<ArrayBuffer>;
  }

  createStore(name: string): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x01);
    this.writeStr(name);
    return this.finish();
  }

  set(name: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x02);
    this.writeStr(name);
    this.writeBytes(data);
    return this.finish();
  }

  get(name: string): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x03);
    this.writeStr(name);
    return this.finish();
  }

  subscribe(name: string): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x04);
    this.writeStr(name);
    return this.finish();
  }

  unsubscribe(name: string): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x05);
    this.writeStr(name);
    return this.finish();
  }

  deleteStore(name: string): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x06);
    this.writeStr(name);
    return this.finish();
  }

  splice(
    name: string,
    expectedVersion: number,
    offset: number,
    deleteCount: number,
    data: Uint8Array,
  ): Uint8Array<ArrayBuffer> {
    this.pos = 0;
    this.writeU8(0x07);
    this.writeStr(name);
    this.writeVarint(expectedVersion);
    this.writeVarint(offset);
    this.writeVarint(deleteCount);
    this.writeBytes(data);
    return this.finish();
  }
}

// ── Response Decoder ────────────────────────────────────────────────

function readBytes(
  buf: Uint8Array<ArrayBufferLike>,
  pos: number,
): { data: Uint8Array<ArrayBufferLike>; pos: number } {
  const len = decodeVarint(buf, pos);
  const end = len.pos + len.value;
  if (end > buf.length) throw new PicoError(0, "unexpected end of input");
  return { data: buf.subarray(len.pos, end), pos: end };
}

function readString(
  buf: Uint8Array<ArrayBufferLike>,
  pos: number,
): { value: string; pos: number } {
  const { data, pos: next } = readBytes(buf, pos);
  return { value: td.decode(data), pos: next };
}

export function decodeResponse(buf: Uint8Array<ArrayBufferLike>): Response {
  if (buf.length === 0) throw new PicoError(0, "empty response");
  const tag = buf[0];
  let pos = 1;

  switch (tag) {
    case 0x00:
      return { tag: 0x00 };

    case 0x01: {
      const code = buf[pos++];
      const msg = readString(buf, pos);
      return { tag: 0x01, code, message: msg.value };
    }

    case 0x02: {
      const ver = decodeVarint(buf, pos);
      const data = readBytes(buf, ver.pos);
      return { tag: 0x02, version: ver.value, data: data.data };
    }

    case 0x03: {
      const store = readString(buf, pos);
      const ver = decodeVarint(buf, store.pos);
      const data = readBytes(buf, ver.pos);
      return {
        tag: 0x03,
        store: store.value,
        version: ver.value,
        data: data.data,
      };
    }

    case 0x04: {
      const store = readString(buf, pos);
      return { tag: 0x04, store: store.value };
    }

    case 0x05: {
      const store = readString(buf, pos);
      const ver = decodeVarint(buf, store.pos);
      const off = decodeVarint(buf, ver.pos);
      const del = decodeVarint(buf, off.pos);
      const data = readBytes(buf, del.pos);
      return {
        tag: 0x05,
        store: store.value,
        version: ver.value,
        offset: off.value,
        deleteCount: del.value,
        data: data.data,
      };
    }

    case 0x06:
      return { tag: 0x06 };

    default:
      throw new PicoError(0, `unknown response tag: 0x${tag.toString(16)}`);
  }
}
