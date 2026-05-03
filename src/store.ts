import type {
  Serializer,
  StoreHandler,
  ReadonlyStore,
  WriteOptions,
} from "./types.js";
import type { Pico } from "./client.js";
import { uint8ToBase64, base64ToUint8 } from "./serializers.js";

export class Store<T> implements StoreHandler {
  private _value: T | undefined;
  private _version = 0;
  private _subs = new Set<(value: T | undefined) => void>();
  private _deleteSubs = new Set<() => void>();
  private _pico: Pico;
  private _name: string;
  private _serializer: Serializer<T>;
  private _serverSubscribed = false;
  private _localKey: string | null;
  private _localTimer: ReturnType<typeof setTimeout> | null = null;
  private _readyResolve!: () => void;
  readonly ready: Promise<void>;

  // ── debounced flush ──────────────────────────────────────────────
  private _defaultDebounce: number;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];

  /** @internal */
  constructor(
    pico: Pico,
    name: string,
    serializer: Serializer<T>,
    defaultValue?: T,
    localKey?: string,
    defaultDebounce?: number,
  ) {
    this._pico = pico;
    this._name = name;
    this._serializer = serializer;
    this._localKey = localKey ?? null;
    this._value = defaultValue;
    this._defaultDebounce = defaultDebounce ?? 0;

    if (this._localKey) {
      this._loadLocal();
    }

    this.ready = new Promise((r) => {
      this._readyResolve = r;
    });
    this._serverSubscribe();
  }

  get value(): T | undefined {
    return this._value;
  }

  get version(): number {
    return this._version;
  }

  /** A type-narrowed view of this store that exposes only read operations. */
  get readonly(): ReadonlyStore<T> {
    return this;
  }

  async set(value: T, opts?: WriteOptions): Promise<void> {
    const debounce = opts?.debounce ?? this._defaultDebounce;
    if (debounce > 0) {
      this._value = value;
      this._notify();
      this._saveLocalDebounced();
      return this._scheduleFlush(debounce);
    }
    const data = this._serializer.encode(value);
    await this._pico._exec(this._pico._encoder.set(this._name, data));
  }

  /**
   * Svelte-style update: receives the current value, returns the next.
   * Honors the same debounce options as `set`.
   */
  async update(
    fn: (current: T | undefined) => T,
    opts?: WriteOptions,
  ): Promise<void> {
    await this.set(fn(this._value), opts);
  }

  subscribe(cb: (value: T | undefined) => void): () => void {
    this._subs.add(cb);

    cb(this._value);

    return () => {
      this._subs.delete(cb);
    };
  }

  onDelete(cb: () => void): () => void {
    this._deleteSubs.add(cb);
    return () => {
      this._deleteSubs.delete(cb);
    };
  }

  async refresh(): Promise<void> {
    const resp = await this._pico._execData(
      this._pico._encoder.get(this._name),
    );
    if (resp.version > this._version) {
      let value: T;
      try {
        value = this._serializer.decode(resp.data);
      } catch (_) {
        // Server data is corrupt — try to heal with local state
        this._selfHeal();
        return;
      }
      this._version = resp.version;
      this._value = value;
      this._notify();
      this._saveLocalDebounced();
    }
  }

  async delete(): Promise<void> {
    this._cancelFlush();
    await this._pico.deleteStore(this._name);
    this._value = undefined;
    this._version = 0;
    this._notify();
  }

  /** Force any pending debounced write to flush now. */
  async flush(): Promise<void> {
    if (this._flushTimer === null) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    await this._doFlush();
  }

  private _scheduleFlush(delay: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this._flushWaiters.push({ resolve, reject });
      // Arm only if no timer is already running. A burst of writes
      // joins the existing window so we always flush at most once
      // per `delay`, even under continuous load.
      if (this._flushTimer === null) {
        this._flushTimer = setTimeout(() => {
          this._flushTimer = null;
          this._doFlush();
        }, delay);
      }
    });
  }

  private async _doFlush(): Promise<void> {
    const waiters = this._flushWaiters;
    this._flushWaiters = [];
    if (this._value === undefined) {
      for (const w of waiters) w.resolve();
      return;
    }
    try {
      const data = this._serializer.encode(this._value);
      await this._pico._exec(this._pico._encoder.set(this._name, data));
      for (const w of waiters) w.resolve();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const w of waiters) w.reject(e);
    }
  }

  private _cancelFlush() {
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    const waiters = this._flushWaiters;
    this._flushWaiters = [];
    for (const w of waiters) w.resolve();
  }

  /** @internal */
  _onUpdate(data: Uint8Array<ArrayBufferLike>, version: number) {
    if (version <= this._version) return;
    let value: T;
    try {
      value = this._serializer.decode(data);
    } catch (_) {
      this._selfHeal();
      return;
    }
    this._version = version;
    this._value = value;
    this._notify();
    this._saveLocalDebounced();
  }

  /** @internal */
  _onSpliceUpdate(
    _offset: number,
    _deleteCount: number,
    _data: Uint8Array<ArrayBufferLike>,
    _version: number,
  ) {
    this.refresh().catch(() => {});
  }

  /** @internal */
  _onDeleted() {
    this._serverSubscribed = false;
    this._version = 0;
    this._value = undefined;
    this._clearLocal();
    this._notify();
    for (const cb of this._deleteSubs) {
      try {
        cb();
      } catch (_) {}
    }
  }

  /** @internal */
  _resubscribe() {
    this._version = 0;
    this._serverSubscribed = false;
    this._serverSubscribe();
  }

  private _loadLocal() {
    if (!this._localKey || typeof globalThis.localStorage === "undefined")
      return;
    try {
      const raw = localStorage.getItem(this._localKey);
      if (!raw) return;
      const entry = JSON.parse(raw) as { v: number; d: string };
      const data = base64ToUint8(entry.d);
      this._version = entry.v;
      this._value = this._serializer.decode(data);
    } catch (err) {
      console.warn(
        `[pico] failed to load local cache for "${this._name}":`,
        err,
      );
    }
  }

  private _saveLocal() {
    if (
      !this._localKey ||
      this._value === undefined ||
      typeof globalThis.localStorage === "undefined"
    )
      return;
    try {
      const data = this._serializer.encode(this._value);
      const entry = JSON.stringify({
        v: this._version,
        d: uint8ToBase64(data),
      });
      localStorage.setItem(this._localKey, entry);
    } catch (_) {}
  }

  private _saveLocalDebounced() {
    if (!this._localKey || typeof globalThis.localStorage === "undefined")
      return;
    if (this._localTimer !== null) clearTimeout(this._localTimer);
    this._localTimer = setTimeout(() => {
      this._localTimer = null;
      this._saveLocal();
    }, 1000);
  }

  private _clearLocal() {
    if (!this._localKey || typeof globalThis.localStorage === "undefined")
      return;
    if (this._localTimer !== null) {
      clearTimeout(this._localTimer);
      this._localTimer = null;
    }
    try {
      localStorage.removeItem(this._localKey);
    } catch (_) {}
  }

  private _selfHeal() {
    if (this._value !== undefined) {
      // Push last known good value to server
      const data = this._serializer.encode(this._value);
      this._pico
        ._execOk(this._pico._encoder.set(this._name, data))
        .catch(() => {});
    }
    // If no local value, nothing to recover from — leave as-is.
  }

  private _notify() {
    for (const cb of this._subs) {
      try {
        cb(this._value);
      } catch (_) {}
    }
  }

  private _serverSubscribe() {
    this._serverSubscribed = true;
    this._pico
      ._exec(this._pico._encoder.subscribe(this._name))
      .then(() => this.refresh())
      .then(() => this._readyResolve())
      .catch(() => {
        this._serverSubscribed = false;
      });
  }
}
