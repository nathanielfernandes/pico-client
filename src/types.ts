export interface Serializer<T> {
  encode(value: T): Uint8Array;
  decode(data: Uint8Array<ArrayBufferLike>): T;
}

export interface ReconnectOptions {
  /**
   * - `exponential`: double the delay on each failed attempt, capped at `maxDelay`.
   * - `fixed`: always wait `initialDelay` between attempts.
   */
  strategy?: "exponential" | "fixed";
  /** Initial/base delay in ms. Default 100. */
  initialDelay?: number;
  /** Upper bound for exponential backoff in ms. Default 30000. */
  maxDelay?: number;
  /**
   * For `exponential`: once the delay hits `maxDelay`, reset it back to
   * `initialDelay` on the next attempt (so it "wraps" instead of sitting
   * at the cap). Default false.
   */
  resetAfterMax?: boolean;
}

export interface PicoOptions {
  url?: string;
  token?: string;
  persist?: boolean;
  reconnect?: boolean | ReconnectOptions;
  /** @deprecated use `reconnect: { maxDelay }` */
  maxReconnectDelay?: number;
  serializer?: Serializer<any>;
  WebSocket?: typeof WebSocket;
}

export interface StoreOptions<T> {
  serializer?: Serializer<T>;
  default?: T;
  local?: boolean;
}

export interface CollectionStoreOptions<T> {
  serializer?: Serializer<T>;
  default?: T[];
  local?: boolean;
}

export interface MapStoreOptions<V> {
  serializer?: Serializer<V>;
  default?: Record<string, V>;
  local?: boolean;
}

export type ResponseOk = { tag: 0x00 };
export type ResponseError = { tag: 0x01; code: number; message: string };
export type ResponseData = {
  tag: 0x02;
  version: number;
  data: Uint8Array<ArrayBufferLike>;
};
export type ResponseUpdate = {
  tag: 0x03;
  store: string;
  version: number;
  data: Uint8Array<ArrayBufferLike>;
};
export type ResponseStoreDeleted = { tag: 0x04; store: string };
export type ResponseSpliceUpdate = {
  tag: 0x05;
  store: string;
  version: number;
  offset: number;
  deleteCount: number;
  data: Uint8Array<ArrayBufferLike>;
};
export type ResponsePong = { tag: 0x06 };
export type Response =
  | ResponseOk
  | ResponseError
  | ResponseData
  | ResponseUpdate
  | ResponseStoreDeleted
  | ResponseSpliceUpdate
  | ResponsePong;

// ── Readonly views ─────────────────────────────────────────────────
// Structural interfaces exposing only read operations. Use via the
// `.readonly` getter on any store, or cast directly.

export interface ReadonlyStore<T> {
  readonly value: T | undefined;
  readonly version: number;
  readonly ready: Promise<void>;
  subscribe(cb: (value: T | undefined) => void): () => void;
  onDelete(cb: () => void): () => void;
  refresh(): Promise<void>;
}

export interface ReadonlyListStore<T> {
  readonly items: T[];
  readonly length: number;
  readonly version: number;
  readonly ready: Promise<void>;
  at(index: number): T | undefined;
  subscribe(cb: (items: T[]) => void): () => void;
  onDelete(cb: () => void): () => void;
  refresh(): Promise<void>;
}

export interface ReadonlyMapStore<V> {
  readonly entries: Map<string, V>;
  readonly size: number;
  readonly version: number;
  readonly ready: Promise<void>;
  get(key: string): V | undefined;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  values(): IterableIterator<V>;
  subscribe(cb: (entries: Map<string, V>) => void): () => void;
  onDelete(cb: () => void): () => void;
  refresh(): Promise<void>;
}

/** @internal */
export interface StoreHandler {
  _onUpdate(data: Uint8Array<ArrayBufferLike>, version: number): void;
  _onSpliceUpdate(
    offset: number,
    deleteCount: number,
    data: Uint8Array<ArrayBufferLike>,
    version: number,
  ): void;
  _onDeleted(): void;
  _resubscribe(): void;
}
