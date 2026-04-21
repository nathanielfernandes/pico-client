import type {
  Serializer,
  PicoOptions,
  ReconnectOptions,
  StoreOptions,
  CollectionStoreOptions,
  MapStoreOptions,
  ReadonlyStore,
  Response,
  ResponseError,
  ResponseData,
  ResponseUpdate,
  ResponseStoreDeleted,
  ResponseSpliceUpdate,
  StoreHandler,
} from "./types.js";
import { PicoError } from "./errors.js";
import { Json, CsvStringArray } from "./serializers.js";
import { Encoder, decodeResponse } from "./protocol.js";
import { Store } from "./store.js";
import { ListStore } from "./list-store.js";
import { MapStore } from "./map-store.js";
import { MultiStore } from "./multistore.js";

const PING_INTERVAL = 30_000;
const PING_FRAME = new Uint8Array([0x08]);

const NAMESPACE_LIST_STORE = "@stores";

type Resolver = {
  resolve: (resp: Response) => void;
  reject: (err: Error) => void;
};
type Backlogged = Resolver & { data: Uint8Array<ArrayBuffer> };
type ConnectWaiter = { resolve: () => void; reject: (e: Error) => void };

type ConnState =
  | { kind: "idle" }
  | { kind: "connecting"; ws: WebSocket; waiters: ConnectWaiter[] }
  | { kind: "open"; ws: WebSocket }
  | { kind: "reconnecting"; timer: ReturnType<typeof setTimeout> }
  | { kind: "closed" };

const CONN_LOST = () => new PicoError(0, "connection lost");
const CONN_CLOSED = () => new PicoError(0, "connection closed");
const CONN_FAILED = () => new PicoError(0, "connection failed");

export class Pico {
  // ── identity ──────────────────────────────────────────────────────
  private _url: string;
  private _namespace: string;
  private _token?: string;
  private _persist?: boolean;
  private _defaultSerializer: any;
  private _WS: typeof WebSocket;

  // ── connection state ──────────────────────────────────────────────
  private _state: ConnState = { kind: "idle" };
  private _connectSubs = new Set<(connected: boolean) => void>();

  // ── request pipeline ──────────────────────────────────────────────
  // Resolvers for requests already on the wire, in send order. WebSocket
  // frames are FIFO and the server processes commands sequentially per
  // connection, so head-of-queue correlation is correct.
  private _inflight: Resolver[] = [];
  // Requests queued before the socket was open. Drained on the `open`
  // transition. Survives disconnect/reconnect.
  private _backlog: Backlogged[] = [];

  // ── reconnect ─────────────────────────────────────────────────────
  private _reconnectDefault: boolean;
  private _reconnect: boolean;
  private _strategy: "exponential" | "fixed";
  private _initialDelay: number;
  private _maxDelay: number;
  private _resetAfterMax: boolean;
  private _nextDelay: number;

  // ── stores ────────────────────────────────────────────────────────
  private _stores = new Map<string, StoreHandler>();

  // ── keepalive ──────────────────────────────────────────────────────
  private _pingTimer: ReturnType<typeof setInterval> | null = null;

  /** @internal */
  _encoder = new Encoder();

  constructor(namespace: string, options?: PicoOptions) {
    this._namespace = namespace;
    this._url = options?.url ?? "ws://127.0.0.1:6001";
    this._token = options?.token;
    this._persist = options?.persist;
    this._defaultSerializer = options?.serializer ?? Json;
    this._WS = options?.WebSocket ?? globalThis.WebSocket;

    const rc = options?.reconnect;
    let rcOpts: ReconnectOptions = {};
    if (rc === false) this._reconnectDefault = this._reconnect = false;
    else if (rc === true || rc === undefined)
      this._reconnectDefault = this._reconnect = true;
    else {
      this._reconnectDefault = this._reconnect = true;
      rcOpts = rc;
    }
    this._strategy = rcOpts.strategy ?? "exponential";
    this._initialDelay = rcOpts.initialDelay ?? 100;
    this._maxDelay = rcOpts.maxDelay ?? options?.maxReconnectDelay ?? 30_000;
    this._resetAfterMax = rcOpts.resetAfterMax ?? false;
    this._nextDelay = this._initialDelay;
  }

  // ── public surface ────────────────────────────────────────────────

  get connected(): boolean {
    return this._state.kind === "open";
  }

  onConnection(cb: (connected: boolean) => void): () => void {
    this._connectSubs.add(cb);
    cb(this.connected);
    return () => {
      this._connectSubs.delete(cb);
    };
  }

  connect(): Promise<void> {
    const s = this._state;
    if (s.kind === "open") return Promise.resolve();
    if (s.kind === "connecting") {
      return new Promise((resolve, reject) =>
        s.waiters.push({ resolve, reject }),
      );
    }
    // closed → reset to idle so the instance is reusable (matches old
    // behavior; required for React strict mode mount/cleanup/remount).
    if (s.kind === "closed") {
      this._reconnect = this._reconnectDefault;
      this._state = { kind: "idle" };
    }
    // idle | reconnecting → start a fresh attempt
    return new Promise((resolve, reject) => {
      this._attemptOpen([{ resolve, reject }]);
    });
  }

  close(): void {
    this._transition({ kind: "closed" });
  }

  store<T>(name: string, options?: StoreOptions<T>): Store<T> {
    let s = this._stores.get(name);
    if (!s) {
      const serializer = options?.serializer ?? this._defaultSerializer;
      const localKey = options?.local
        ? `__pico_local_${this._namespace}_${name}`
        : undefined;
      s = new Store<T>(this, name, serializer, options?.default, localKey);
      this._stores.set(name, s);
    }
    return s as Store<T>;
  }

  list<T>(name: string, options?: CollectionStoreOptions<T>): ListStore<T> {
    let s = this._stores.get(name);
    if (!s) {
      const serializer = options?.serializer ?? this._defaultSerializer;
      const localKey = options?.local
        ? `__pico_local_${this._namespace}_${name}`
        : undefined;
      s = new ListStore<T>(this, name, serializer, options?.default, localKey);
      this._stores.set(name, s);
    }
    return s as ListStore<T>;
  }

  map<V>(name: string, options?: MapStoreOptions<V>): MapStore<V> {
    let s = this._stores.get(name);
    if (!s) {
      const serializer = options?.serializer ?? this._defaultSerializer;
      const localKey = options?.local
        ? `__pico_local_${this._namespace}_${name}`
        : undefined;
      s = new MapStore<V>(this, name, serializer, options?.default, localKey);
      this._stores.set(name, s);
    }
    return s as MapStore<V>;
  }

  stores(): ReadonlyStore<string[]> {
    return this.store<string[]>(NAMESPACE_LIST_STORE, {
      serializer: CsvStringArray,
      default: [],
    }).readonly;
  }

  multistore<V>(
    name: string,
    options?: { serializer?: Serializer<V>; local?: boolean },
  ): MultiStore<V, "store"> {
    const localKey = options?.local
      ? `__pico_local_${this._namespace}_${name}`
      : undefined;
    return new MultiStore<V, "store">(
      this,
      name,
      "store",
      options?.serializer as any,
      localKey,
    );
  }

  multilist<V>(
    name: string,
    options?: { serializer?: Serializer<V[]>; local?: boolean },
  ): MultiStore<V, "list"> {
    const localKey = options?.local
      ? `__pico_local_${this._namespace}_${name}`
      : undefined;
    return new MultiStore<V, "list">(
      this,
      name,
      "list",
      options?.serializer as any,
      localKey,
    );
  }

  multimap<V>(
    name: string,
    options?: { serializer?: Serializer<V>; local?: boolean },
  ): MultiStore<V, "map"> {
    const localKey = options?.local
      ? `__pico_local_${this._namespace}_${name}`
      : undefined;
    return new MultiStore<V, "map">(
      this,
      name,
      "map",
      options?.serializer as any,
      localKey,
    );
  }

  async deleteStore(name: string): Promise<void> {
    const resp = await this._exec(this._encoder.deleteStore(name));
    if (resp.tag === 0x01) {
      const e = resp as ResponseError;
      throw new PicoError(e.code, e.message);
    }
  }

  // ── @internal request entry points ────────────────────────────────

  /** @internal */
  _exec(data: Uint8Array<ArrayBuffer>): Promise<Response> {
    return new Promise((resolve, reject) => {
      const s = this._state;
      if (s.kind === "closed") {
        reject(CONN_CLOSED());
        return;
      }
      if (s.kind === "open") {
        this._inflight.push({ resolve, reject });
        s.ws.send(data);
        return;
      }
      // idle | connecting | reconnecting → queue and ensure an attempt is
      // in flight (only `idle` and `reconnecting` need a kick).
      this._backlog.push({ data, resolve, reject });
      if (s.kind === "idle" || (s.kind === "reconnecting" && this._reconnect)) {
        if (s.kind === "reconnecting") clearTimeout(s.timer);
        this._attemptOpen([]);
      }
    });
  }

  /** @internal */
  async _execData(
    data: Uint8Array<ArrayBuffer>,
  ): Promise<{ version: number; data: Uint8Array<ArrayBufferLike> }> {
    const resp = await this._exec(data);
    if (resp.tag === 0x01) {
      const e = resp as ResponseError;
      throw new PicoError(e.code, e.message);
    }
    if (resp.tag === 0x02) {
      const d = resp as ResponseData;
      return { version: d.version, data: d.data };
    }
    throw new PicoError(0, "unexpected response");
  }

  /** @internal */
  async _execOk(data: Uint8Array<ArrayBuffer>): Promise<void> {
    const resp = await this._exec(data);
    if (resp.tag === 0x01) {
      const e = resp as ResponseError;
      throw new PicoError(e.code, e.message);
    }
    if (resp.tag !== 0x00) throw new PicoError(0, "unexpected response");
  }

  // ── connection lifecycle ──────────────────────────────────────────

  private _buildUrl(): string {
    let url = `${this._url}/ws/${this._namespace}`;
    const params: string[] = [];
    if (this._token) params.push(`token=${encodeURIComponent(this._token)}`);
    if (this._persist != null) params.push(`persist=${this._persist}`);
    if (params.length) url += `?${params.join("&")}`;
    return url;
  }

  private _attemptOpen(initialWaiters: ConnectWaiter[]) {
    let ws: WebSocket;
    try {
      ws = new this._WS(this._buildUrl());
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const w of initialWaiters) w.reject(e);
      if (this._reconnect) this._scheduleReconnect();
      else this._transition({ kind: "closed" });
      return;
    }
    ws.binaryType = "arraybuffer";

    this._transition({ kind: "connecting", ws, waiters: initialWaiters });

    ws.onopen = () => this._onOpen(ws);
    ws.onmessage = (ev) => this._onMessage(ev);
    ws.onclose = () => this._onClose(ws);
    ws.onerror = () => {};
  }

  private _onOpen(ws: WebSocket) {
    if (this._state.kind !== "connecting" || this._state.ws !== ws) return;
    const waiters = this._state.waiters;
    this._transition({ kind: "open", ws });
    this._nextDelay = this._initialDelay;
    this._startPing();

    for (const w of waiters) w.resolve();

    // Re-establish subscriptions before draining the backlog so that any
    // pending writes go out after the resubscribe commands.
    for (const store of this._stores.values()) store._resubscribe();

    // Reject stale backlog — stores will resync via _resubscribe.
    // Replaying splice commands with stale byte offsets/versions
    // causes data corruption.
    this._rejectBacklog(CONN_LOST());
  }

  private _onClose(ws: WebSocket) {
    const s = this._state;
    // Ignore stale events from sockets we already abandoned.
    if (
      (s.kind !== "open" && s.kind !== "connecting") ||
      (s as any).ws !== ws
    ) {
      return;
    }
    const wasConnecting = s.kind === "connecting";
    const connectWaiters = wasConnecting ? s.waiters : [];

    // In-flight responses are unrecoverable. Backlog is preserved for
    // retry after reconnect.
    this._rejectInflight(CONN_LOST());

    if (!this._reconnect) {
      // Terminal: drop the backlog too.
      this._rejectBacklog(CONN_CLOSED());
      this._transition({ kind: "closed" });
      for (const w of connectWaiters) w.reject(CONN_FAILED());
      return;
    }

    if (!wasConnecting) {
      console.warn("Pico connection lost, attempting to reconnect...");
    }
    this._scheduleReconnect();
    // Connect waiters from a failed initial attempt are migrated into the
    // reconnect cycle: their next opportunity is the next successful open.
    if (connectWaiters.length) {
      // Replay them as a connect() call so they latch onto the next
      // connecting state.
      for (const w of connectWaiters) {
        this.connect().then(w.resolve, w.reject);
      }
    }
  }

  private _scheduleReconnect() {
    const delay = this._nextDelay;
    if (this._strategy === "fixed") {
      this._nextDelay = this._initialDelay;
    } else {
      const next = delay * 2;
      this._nextDelay =
        next > this._maxDelay
          ? this._resetAfterMax
            ? this._initialDelay
            : this._maxDelay
          : next;
    }
    const timer = setTimeout(() => {
      if (this._state.kind === "reconnecting" && this._state.timer === timer) {
        this._attemptOpen([]);
      }
    }, delay);
    this._transition({ kind: "reconnecting", timer });
  }

  private _transition(next: ConnState) {
    const prev = this._state;
    if (prev === next) return;

    this._stopPing();
    // Cleanup of previous state.
    if (prev.kind === "reconnecting") clearTimeout(prev.timer);
    if (prev.kind === "connecting" || prev.kind === "open") {
      // Detach handlers only when we're abandoning this socket, not when
      // the same socket is transitioning (e.g. connecting → open).
      const nextWs =
        next.kind === "connecting" || next.kind === "open" ? next.ws : null;
      if (prev.ws !== nextWs) {
        try {
          prev.ws.onopen = null;
          prev.ws.onmessage = null;
          prev.ws.onclose = null;
          prev.ws.onerror = null;
        } catch (_) {}
      }
    }

    const wasOpen = prev.kind === "open";
    this._state = next;

    // Special handling for terminal "closed".
    if (next.kind === "closed") {
      if (prev.kind === "connecting") {
        for (const w of prev.waiters) w.reject(CONN_CLOSED());
      }
      if (prev.kind === "connecting" || prev.kind === "open") {
        try {
          prev.ws.close();
        } catch (_) {}
      }
      this._reconnect = false;
      this._rejectInflight(CONN_CLOSED());
      this._rejectBacklog(CONN_CLOSED());
    }

    const isOpen = next.kind === "open";
    if (wasOpen !== isOpen) this._emitConnection(isOpen);
  }

  private _emitConnection(connected: boolean) {
    for (const cb of this._connectSubs) {
      try {
        cb(connected);
      } catch (_) {}
    }
  }

  private _rejectInflight(err: Error) {
    if (this._inflight.length === 0) return;
    const drain = this._inflight;
    this._inflight = [];
    for (const r of drain) r.reject(err);
  }

  private _rejectBacklog(err: Error) {
    if (this._backlog.length === 0) return;
    const drain = this._backlog;
    this._backlog = [];
    for (const r of drain) r.reject(err);
  }

  // ── message dispatch ──────────────────────────────────────────────

  private _onMessage(ev: MessageEvent) {
    const buf = new Uint8Array(ev.data as ArrayBuffer);
    let resp: Response;
    try {
      resp = decodeResponse(buf);
    } catch {
      return;
    }
    switch (resp.tag) {
      case 0x03:
        this._dispatchUpdate(resp as ResponseUpdate);
        return;
      case 0x04:
        this._dispatchDeleted(resp as ResponseStoreDeleted);
        return;
      case 0x05:
        this._dispatchSpliceUpdate(resp as ResponseSpliceUpdate);
        return;
      case 0x06:
        return;
      default:
        this._dispatchReply(resp);
        return;
    }
  }

  private _dispatchUpdate(u: ResponseUpdate) {
    const store = this._stores.get(u.store);
    if (store) store._onUpdate(u.data, u.version);
  }

  private _dispatchSpliceUpdate(u: ResponseSpliceUpdate) {
    const store = this._stores.get(u.store);
    if (store)
      store._onSpliceUpdate(u.offset, u.deleteCount, u.data, u.version);
  }

  private _dispatchDeleted(u: ResponseStoreDeleted) {
    const store = this._stores.get(u.store);
    if (store) store._onDeleted();
  }

  private _dispatchReply(resp: Response) {
    const r = this._inflight.shift();
    if (!r) return;
    if (resp.tag === 0x01) {
      const e = resp as ResponseError;
      r.reject(new PicoError(e.code, e.message));
    } else {
      r.resolve(resp);
    }
  }

  private _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      const s = this._state;
      if (s.kind === "open") {
        s.ws.send(PING_FRAME);
      }
    }, PING_INTERVAL);
  }

  private _stopPing() {
    if (this._pingTimer !== null) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }
}
