import type { Serializer } from "./types.js";

const te = new TextEncoder();
const td = new TextDecoder();

export const Json: Serializer<any> = {
  encode(value: any): Uint8Array {
    return te.encode(JSON.stringify(value));
  },
  decode(data: Uint8Array<ArrayBufferLike>): any {
    if (data.length === 0) return undefined;
    return JSON.parse(td.decode(data));
  },
};

export const Raw: Serializer<Uint8Array<ArrayBufferLike>> = {
  encode(value: Uint8Array<ArrayBufferLike>): Uint8Array {
    return new Uint8Array(value);
  },
  decode(data: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
    return data;
  },
};

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const CsvStringArray: Serializer<string[]> = {
  encode(value: string[]): Uint8Array {
    return te.encode(value.join(","));
  },
  decode(data: Uint8Array<ArrayBufferLike>): string[] {
    const str = td.decode(data);
    if (str.length === 0) return [];
    return str.split(",");
  },
};
