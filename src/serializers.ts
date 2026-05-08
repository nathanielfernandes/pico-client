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

// ── AES-256-GCM Encrypted serializer ────────────────────────────────
// Wire format: [12-byte random IV | ciphertext || 16-byte auth tag]
// SubtleCrypto's AES-GCM output already includes the auth tag.

const IV_BYTES = 12;
const SUBTLE = (): SubtleCrypto => {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) {
    throw new Error(
      "[pico] Web Crypto (crypto.subtle) is required for Encrypted serializer",
    );
  }
  return c.subtle;
};

export type EncryptionKey = CryptoKey | Promise<CryptoKey>;

/**
 * Derive an AES-256-GCM `CryptoKey` from a passphrase via PBKDF2-SHA256.
 * The same `passphrase` + `salt` always yields the same key.
 *
 * `salt` should be a stable, non-secret value (e.g. namespace name or app ID).
 * Defaults to 100k iterations.
 */
export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: string,
  iterations = 100_000,
): Promise<CryptoKey> {
  const subtle = SUBTLE();
  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode(salt),
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Wraps any `Serializer<T>` with AES-256-GCM encryption. The inner serializer
 * runs first, and its output is encrypted with a fresh random IV per write.
 *
 * `key` accepts a `CryptoKey` or a `Promise<CryptoKey>` — pass the latter so
 * the constructor can be called synchronously (e.g. with
 * `deriveKeyFromPassphrase(...)`).
 */
export function Encrypted<T>(
  inner: Serializer<T>,
  key: EncryptionKey,
): Serializer<T> {
  let resolvedKey: CryptoKey | null = null;
  const getKey = async (): Promise<CryptoKey> => {
    if (resolvedKey) return resolvedKey;
    resolvedKey = await key;
    return resolvedKey;
  };
  return {
    async encode(value: T): Promise<Uint8Array> {
      const subtle = SUBTLE();
      const k = await getKey();
      const plaintext = await inner.encode(value);
      const iv = new Uint8Array(IV_BYTES);
      (globalThis as any).crypto.getRandomValues(iv);
      const ct = new Uint8Array(
        await subtle.encrypt(
          { name: "AES-GCM", iv: iv as BufferSource },
          k,
          plaintext as BufferSource,
        ),
      );
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv, 0);
      out.set(ct, iv.length);
      return out;
    },
    async decode(data: Uint8Array<ArrayBufferLike>): Promise<T> {
      if (data.length === 0) return inner.decode(data) as T | Promise<T>;
      if (data.length < IV_BYTES + 16) {
        throw new Error("[pico] Encrypted payload too short");
      }
      const subtle = SUBTLE();
      const k = await getKey();
      const iv = data.subarray(0, IV_BYTES);
      const ct = data.subarray(IV_BYTES);
      const plaintext = new Uint8Array(
        await subtle.decrypt(
          { name: "AES-GCM", iv: iv as BufferSource },
          k,
          ct as BufferSource,
        ),
      );
      return inner.decode(plaintext);
    },
  };
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
