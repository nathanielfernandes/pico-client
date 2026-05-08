import type {
  Serializer,
  StoreHandler,
  ReadonlyMapStore,
  WriteOptions,
} from "./types.js";
import type { Pico } from "./client.js";
import {
  type MapEntrySpan,
  applySpliceToBuffer,
  encodeMapEntry,
  parseMapEntries,
} from "./buffer.js";
import { uint8ToBase64, base64ToUint8 } from "./serializers.js";
import { PicoError } from "./errors.js";

export class MapStore<V> implements StoreHandler {
  private _entries = new Map<string, V>();
  private _default: Map<string, V>;
  private _spans: MapEntrySpan[] = [];
  private _spanIndex = new Map<string, number>();
  private _raw: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private _version = 0;
  private _subs = new Set<(entries: Map<string, V>) => void>();
  private _deleteSubs = new Set<() => void>();
  private _pico: Pico;
  private _name: string;
  private _serializer: Serializer<V>;
  private _serverSubscribed = false;
  private _localKey: string | null;
  private _localTimer: ReturnType<typeof setTimeout> | null = null;
  private _readyResolve!: () => void;
  ready: Promise<void>;

  // Leading + trailing debounce: see store.ts for semantics.
  private _defaultDebounce: number;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingTrailing = false;
  private _flushWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];

  /** @internal */
  constructor(
    pico: Pico,
    name: string,
    serializer: Serializer<V>,
    defaults?: Record<string, V>,
    localKey?: string,
    defaultDebounce?: number,
  ) {
    this._pico = pico;
    this._name = name;
    this._serializer = serializer;
    this._localKey = localKey ?? null;
    this._defaultDebounce = defaultDebounce ?? 0;
    this._default = new Map();
    if (defaults) {
      for (const [k, v] of Object.entries(defaults)) {
        this._default.set(k, v);
        this._entries.set(k, v);
      }
    }
    if (this._localKey) this._loadLocal();
    this.ready = new Promise((r) => {
      this._readyResolve = r;
    });
    this._serverSubscribe();
  }

  get entries(): Map<string, V> {
    return this._entries;
  }

  get size(): number {
    return this._entries.size;
  }

  get version(): number {
    return this._version;
  }

  get(key: string): V | undefined {
    return this._entries.get(key);
  }

  /** A type-narrowed view of this map that exposes only read operations. */
  get readonly(): ReadonlyMapStore<V> {
    return this;
  }

  has(key: string): boolean {
    return this._entries.has(key);
  }

  keys(): IterableIterator<string> {
    return this._entries.keys();
  }

  values(): IterableIterator<V> {
    return this._entries.values();
  }

  async set(key: string, value: V, opts?: WriteOptions): Promise<void> {
    const encoded = await encodeMapEntry(key, value, this._serializer);
    return this._spliceWithRetry(key, encoded, value, opts);
  }

  async remove(key: string, opts?: WriteOptions): Promise<void> {
    if (!this._findSpan(key)) return;
    return this._spliceWithRetry(key, new Uint8Array(0), undefined, opts);
  }

  /**
   * Svelte-style update for a single key: receives the current value, returns
   * the next. Returning `undefined` removes the key. Honors debounce options.
   */
  async update(
    key: string,
    fn: (current: V | undefined) => V | undefined,
    opts?: WriteOptions,
  ): Promise<void> {
    const next = fn(this._entries.get(key));
    if (next === undefined) return this.remove(key, opts);
    return this.set(key, next, opts);
  }

  /**
   * Apply a single-key splice optimistically, then send to server.
   * Local state is updated immediately so subsequent ops see correct
   * offsets without waiting for the round-trip.
   */
  private _spliceWithRetry(
    key: string,
    data: Uint8Array,
    value: V | undefined,
    opts: WriteOptions | undefined,
  ): Promise<void> {
    const debounce = opts?.debounce ?? this._defaultDebounce;
    const existing = this._findSpan(key);
    let offset: number;
    let byteDelete: number;
    if (existing) {
      offset = existing.start;
      byteDelete = existing.end - existing.start;
    } else {
      if (value === undefined) return Promise.resolve();
      offset = this._raw.length;
      byteDelete = 0;
    }
    const version = this._version;
    this._applySpliceAt(offset, byteDelete, data, key, value, debounce > 0);

    if (debounce > 0) return this._scheduleFlush(debounce);
    return this._sendSplice(version, offset, byteDelete, data, key, value);
  }

  private async _sendSplice(
    expectedVersion: number,
    offset: number,
    deleteCount: number,
    data: Uint8Array,
    key: string,
    value: V | undefined,
  ): Promise<void> {
    try {
      await this._pico._execOk(
        this._pico._encoder.splice(
          this._name,
          expectedVersion,
          offset,
          deleteCount,
          data,
        ),
      );
    } catch (err) {
      if (
        err instanceof PicoError &&
        (err.code === PicoError.VersionMismatch ||
          err.code === PicoError.SpliceConflict)
      ) {
        // Splice conflict — fall back to full state replacement.
        await this._pico._execOk(
          this._pico._encoder.set(this._name, this._raw),
        );
        return;
      }
      await this.refresh().catch(() => {});
      throw err;
    }
  }

  async setAll(entries: Record<string, V>, opts?: WriteOptions): Promise<void> {
    const debounce = opts?.debounce ?? this._defaultDebounce;
    const pairs = Object.entries(entries);
    const parts = await Promise.all(
      pairs.map(([k, v]) => encodeMapEntry(k, v, this._serializer)),
    );
    let total = 0;
    for (const p of parts) total += p.length;
    const buf = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
      buf.set(part, pos);
      pos += part.length;
    }
    if (debounce > 0) {
      this._raw = buf;
      await this._reparse();
      this._notify();
      this._saveLocalDebounced();
      return this._scheduleFlush(debounce);
    }
    await this._pico._execOk(this._pico._encoder.set(this._name, buf));
    // Apply locally — broadcast may not arrive if not subscribed
    this._raw = buf;
    await this._reparse();
    this._version++;
    this._notify();
    this._saveLocalDebounced();
  }

  async delete(): Promise<void> {
    this._cancelFlush();
    await this._pico.deleteStore(this._name);
    this._reset();
    this._clearLocal();
    this._notify();
  }

  /** Force any pending debounced trailing write to flush now. */
  async flush(): Promise<void> {
    if (this._flushTimer === null) return;
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    if (!this._pendingTrailing) return;
    this._pendingTrailing = false;
    await this._doFlush();
  }

  async refresh(): Promise<void> {
    const resp = await this._pico._execData(
      this._pico._encoder.get(this._name),
    );
    if (resp.version > this._version) {
      this._raw = resp.data;
      if (!(await this._tryReparse())) {
        // Server has corrupt data — heal with local state if possible
        this._selfHeal();
        return;
      }
      this._version = resp.version;
      this._notify();
      this._saveLocalDebounced();
    }
  }

  subscribe(cb: (entries: Map<string, V>) => void): () => void {
    this._subs.add(cb);
    cb(this._entries);
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

  /** @internal */
  async _onUpdate(data: Uint8Array<ArrayBufferLike>, version: number) {
    if (version <= this._version) return;
    const prevRaw = this._raw;
    this._raw = data;
    if (!(await this._tryReparse())) {
      this._raw = prevRaw;
      this._selfHeal();
      return;
    }
    if (version <= this._version) return;
    this._version = version;
    this._notify();
    this._saveLocalDebounced();
  }

  /** @internal */
  async _onSpliceUpdate(
    offset: number,
    deleteCount: number,
    data: Uint8Array<ArrayBufferLike>,
    version: number,
  ) {
    if (version <= this._version) return;
    if (version !== this._version + 1) {
      this.refresh().catch(() => {});
      return;
    }
    const prevRaw = this._raw;
    this._raw = applySpliceToBuffer(this._raw, offset, deleteCount, data);
    if (!(await this._tryReparse())) {
      // Splice produced corrupt data — restore and fetch clean state
      this._raw = prevRaw;
      this.refresh().catch(() => {});
      return;
    }
    this._version = version;
    this._notify();
    this._saveLocalDebounced();
  }

  /** @internal */
  _onDeleted() {
    this._serverSubscribed = false;
    this._reset();
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

  /** @internal */
  _switchNamespace(newNamespace: string) {
    this._cancelFlush();
    if (this._localTimer !== null) {
      clearTimeout(this._localTimer);
      this._localTimer = null;
    }
    if (this._localKey) {
      this._localKey = `__pico_local_${newNamespace}_${this._name}`;
    }
    this._raw = new Uint8Array(0);
    this._entries = new Map(this._default);
    this._spans = [];
    this._spanIndex.clear();
    this._version = 0;
    this._serverSubscribed = false;
    this.ready = new Promise((r) => {
      this._readyResolve = r;
    });
    if (this._localKey) this._loadLocal();
    this._notify();
  }

  private _findSpan(key: string): MapEntrySpan | undefined {
    const idx = this._spanIndex.get(key);
    if (idx === undefined) return undefined;
    return this._spans[idx];
  }

  /**
   * Surgically apply a splice for a single key operation.
   * For set: replaces or appends the key's entry.
   * For remove: deletes the key's entry (value=undefined).
   */
  private _applySpliceAt(
    byteOffset: number,
    byteDeleteCount: number,
    byteData: Uint8Array,
    key: string,
    value: V | undefined,
    debounced: boolean,
  ) {
    this._raw = applySpliceToBuffer(
      this._raw,
      byteOffset,
      byteDeleteCount,
      byteData,
    );
    const sizeDelta = byteData.length - byteDeleteCount;

    // Find the span index being affected
    const existingIdx = this._spanIndex.get(key);

    if (value === undefined) {
      // Removing a key
      if (existingIdx !== undefined) {
        this._entries.delete(key);
        this._spans.splice(existingIdx, 1);
        // Rebuild index for shifted spans and adjust offsets
        this._spanIndex.delete(key);
        for (let i = existingIdx; i < this._spans.length; i++) {
          this._spans[i].start += sizeDelta;
          this._spans[i].end += sizeDelta;
          this._spanIndex.set(this._spans[i].key, i);
        }
      }
    } else if (existingIdx !== undefined) {
      // Updating existing key in place
      this._entries.set(key, value);
      this._spans[existingIdx] = {
        key,
        start: byteOffset,
        end: byteOffset + byteData.length,
      };
      // Adjust offsets for spans after this one
      for (let i = existingIdx + 1; i < this._spans.length; i++) {
        this._spans[i].start += sizeDelta;
        this._spans[i].end += sizeDelta;
      }
    } else {
      // Appending new key
      this._entries.set(key, value);
      const newIdx = this._spans.length;
      this._spans.push({
        key,
        start: byteOffset,
        end: byteOffset + byteData.length,
      });
      this._spanIndex.set(key, newIdx);
    }

    // When debouncing, the network flush will be a single `set` (one server
    // version bump). Don't optimistically increment locally or we'd reject
    // the broadcast that comes back.
    if (!debounced) this._version++;
    this._notify();
    this._saveLocalDebounced();
  }

  private async _reparse() {
    const parsed = await parseMapEntries(this._raw, this._serializer);
    this._entries = parsed.entries;
    this._spans = parsed.spans;
    this._rebuildIndex();
  }

  private async _tryReparse(): Promise<boolean> {
    const parsed = await parseMapEntries(this._raw, this._serializer);
    if (parsed.corrupt) {
      return false;
    }
    this._entries = parsed.entries;
    this._spans = parsed.spans;
    this._rebuildIndex();
    return true;
  }

  private _selfHeal() {
    if (this._entries.size > 0) {
      // Re-encode from last known good entries — snapshot first
      const snapshot = Array.from(this._entries);
      (async () => {
        try {
          const parts = await Promise.all(
            snapshot.map(([k, v]) => encodeMapEntry(k, v, this._serializer)),
          );
          let total = 0;
          for (const p of parts) total += p.length;
          const buf = new Uint8Array(total);
          let pos = 0;
          for (const part of parts) {
            buf.set(part, pos);
            pos += part.length;
          }
          this._raw = buf;
          await this._reparse();
          await this._pico._execOk(
            this._pico._encoder.set(this._name, this._raw),
          );
        } catch (_) {}
      })();
    } else {
      // Nothing to recover from — reset to clean empty state.
      console.warn(
        `[pico] corrupt data for "${this._name}" with no local state to recover`,
      );
      this._raw = new Uint8Array(0);
      this._spans = [];
      this._spanIndex.clear();
      this._notify();
    }
  }

  private _rebuildIndex() {
    this._spanIndex.clear();
    for (let i = 0; i < this._spans.length; i++) {
      this._spanIndex.set(this._spans[i].key, i);
    }
  }

  private _reset() {
    this._raw = new Uint8Array(0);
    this._entries = new Map();
    this._spans = [];
    this._spanIndex.clear();
    this._version = 0;
  }

  private _notify() {
    for (const cb of this._subs) {
      try {
        cb(this._entries);
      } catch (_) {}
    }
  }

  private async _loadLocal() {
    if (!this._localKey || typeof globalThis.localStorage === "undefined")
      return;
    try {
      const raw = localStorage.getItem(this._localKey);
      if (!raw) return;
      const entry = JSON.parse(raw) as { v: number; d: string };
      // Don't clobber a newer version that may have arrived from the server
      if (entry.v <= this._version) return;
      this._raw = base64ToUint8(entry.d);
      this._version = entry.v;
      if (!(await this._tryReparse())) {
        console.warn(
          `[pico] corrupt local cache for "${this._name}", clearing`,
        );
        this._reset();
        this._clearLocal();
        return;
      }
      this._notify();
    } catch (err) {
      console.warn(
        `[pico] failed to load local cache for "${this._name}":`,
        err,
      );
    }
  }

  private _saveLocal() {
    if (!this._localKey || typeof globalThis.localStorage === "undefined")
      return;
    try {
      const entry = JSON.stringify({
        v: this._version,
        d: uint8ToBase64(this._raw),
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

  private _scheduleFlush(delay: number): Promise<void> {
    if (this._flushTimer === null) {
      // Leading edge: arm cooldown, fire current state now.
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        if (this._pendingTrailing) {
          this._pendingTrailing = false;
          this._doFlush();
        }
      }, delay);
      return this._doFlush();
    }
    // Within cooldown: queue for the trailing flush.
    this._pendingTrailing = true;
    return new Promise<void>((resolve, reject) => {
      this._flushWaiters.push({ resolve, reject });
    });
  }

  private async _doFlush(): Promise<void> {
    const waiters = this._flushWaiters;
    this._flushWaiters = [];
    try {
      await this._pico._execOk(this._pico._encoder.set(this._name, this._raw));
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
    this._pendingTrailing = false;
    const waiters = this._flushWaiters;
    this._flushWaiters = [];
    for (const w of waiters) w.resolve();
  }
}
