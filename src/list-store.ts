import type { Serializer, StoreHandler, ReadonlyListStore } from "./types.js";
import type { Pico } from "./client.js";
import {
  type EntrySpan,
  applySpliceToBuffer,
  encodeEntries,
  parseListEntries,
} from "./buffer.js";
import { uint8ToBase64, base64ToUint8 } from "./serializers.js";
import { PicoError } from "./errors.js";

export class ListStore<T> implements StoreHandler {
  private _items: T[] = [];
  private _spans: EntrySpan[] = [];
  private _raw: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private _version = 0;
  private _subs = new Set<(items: T[]) => void>();
  private _deleteSubs = new Set<() => void>();
  private _pico: Pico;
  private _name: string;
  private _serializer: Serializer<T>;
  private _serverSubscribed = false;
  private _localKey: string | null;
  private _localTimer: ReturnType<typeof setTimeout> | null = null;
  private _readyResolve!: () => void;
  readonly ready: Promise<void>;

  /** @internal */
  constructor(
    pico: Pico,
    name: string,
    serializer: Serializer<T>,
    defaultItems?: T[],
    localKey?: string,
  ) {
    this._pico = pico;
    this._name = name;
    this._serializer = serializer;
    this._localKey = localKey ?? null;
    if (defaultItems) this._items = [...defaultItems];
    if (this._localKey) this._loadLocal();
    this.ready = new Promise((r) => {
      this._readyResolve = r;
    });
    this._serverSubscribe();
  }

  get items(): T[] {
    return this._items;
  }

  get length(): number {
    return this._items.length;
  }

  get version(): number {
    return this._version;
  }

  at(index: number): T | undefined {
    return this._items[index];
  }

  /** A type-narrowed view of this list that exposes only read operations. */
  get readonly(): ReadonlyListStore<T> {
    return this;
  }

  async push(...items: T[]): Promise<void> {
    const encoded = encodeEntries(items, this._serializer);
    return this._spliceWithRetry(
      () => this._raw.length,
      () => 0,
      encoded,
      () => this._items.length,
      0,
      items,
    );
  }

  async insertAt(index: number, ...items: T[]): Promise<void> {
    const encoded = encodeEntries(items, this._serializer);
    return this._spliceWithRetry(
      () => this._byteOffset(index),
      () => 0,
      encoded,
      () => Math.max(0, Math.min(index, this._items.length)),
      0,
      items,
    );
  }

  async removeAt(index: number, count = 1): Promise<void> {
    if (index < 0 || index >= this._spans.length) return;
    const empty = new Uint8Array(0);
    return this._spliceWithRetry(
      () => this._spans[index].start,
      () => {
        const end = Math.min(index + count, this._spans.length);
        return this._spans[end - 1].end - this._spans[index].start;
      },
      empty,
      () => index,
      Math.min(count, this._spans.length - index),
      [],
    );
  }

  async setAt(index: number, value: T): Promise<void> {
    if (index < 0 || index >= this._spans.length) return;
    const encoded = encodeEntries([value], this._serializer);
    return this._spliceWithRetry(
      () => this._spans[index].start,
      () => this._spans[index].end - this._spans[index].start,
      encoded,
      () => index,
      1,
      [value],
    );
  }

  /** Partially update the item at `index`, merging `partial` into the existing value. */
  patch(index: number, partial: Partial<T>): Promise<void> {
    const current = this._items[index];
    if (current === undefined) return Promise.resolve();
    return this.setAt(index, { ...current, ...partial });
  }

  /**
   * Apply a splice optimistically, then send it to the server. The local
   * state is updated immediately so the next splice sees correct offsets
   * without waiting for the round-trip. On server error, resync.
   */
  private _spliceWithRetry(
    offsetFn: () => number,
    deleteCountFn: () => number,
    data: Uint8Array,
    itemIndexFn: () => number,
    itemDeleteCount: number,
    newItems: T[],
  ): Promise<void> {
    // Compute offsets against current local state and apply immediately.
    const offset = offsetFn();
    const deleteCount = deleteCountFn();
    const version = this._version;
    this._applySplice(
      offset,
      deleteCount,
      data,
      itemIndexFn(),
      itemDeleteCount,
      newItems,
    );

    // Fire the network request without blocking subsequent splices.
    return this._sendSplice(version, offset, deleteCount, data);
  }

  private async _sendSplice(
    expectedVersion: number,
    offset: number,
    deleteCount: number,
    data: Uint8Array,
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
        // _raw already has the optimistic change applied.
        await this._pico._execOk(
          this._pico._encoder.set(this._name, this._raw),
        );
        return;
      }
      // Unrecoverable — resync to known state.
      await this.refresh().catch(() => {});
      throw err;
    }
  }

  async set(items: T[]): Promise<void> {
    const encoded = encodeEntries(items, this._serializer);
    await this._pico._execOk(this._pico._encoder.set(this._name, encoded));
    // Apply locally — broadcast may not arrive if not subscribed
    this._raw = encoded;
    this._reparse();
    this._version++;
    this._notify();
    this._saveLocalDebounced();
  }

  async delete(): Promise<void> {
    await this._pico.deleteStore(this._name);
    this._reset();
    this._clearLocal();
    this._notify();
  }

  async refresh(): Promise<void> {
    const resp = await this._pico._execData(
      this._pico._encoder.get(this._name),
    );
    if (resp.version > this._version) {
      this._raw = resp.data;
      if (!this._tryReparse()) {
        // Server has corrupt data — heal with local state if possible
        this._selfHeal();
        return;
      }
      this._version = resp.version;
      this._notify();
      this._saveLocalDebounced();
    }
  }

  subscribe(cb: (items: T[]) => void): () => void {
    this._subs.add(cb);
    cb(this._items);
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
  _onUpdate(data: Uint8Array<ArrayBufferLike>, version: number) {
    if (version <= this._version) return;
    this._raw = data;
    if (!this._tryReparse()) {
      // Corrupt data from server — try to heal by pushing local state
      this._selfHeal();
      return;
    }
    this._version = version;
    this._notify();
    this._saveLocalDebounced();
  }

  /** @internal */
  _onSpliceUpdate(
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
    if (!this._tryReparse()) {
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

  private _byteOffset(index: number): number {
    if (index <= 0) return 0;
    if (index >= this._spans.length) return this._raw.length;
    return this._spans[index].start;
  }

  /**
   * Surgically apply a splice to both the raw buffer and the items/spans arrays
   * without reparsing the entire buffer.
   */
  private _applySplice(
    byteOffset: number,
    byteDeleteCount: number,
    byteData: Uint8Array,
    itemIndex: number,
    itemDeleteCount: number,
    newItems: T[],
  ) {
    this._raw = applySpliceToBuffer(
      this._raw,
      byteOffset,
      byteDeleteCount,
      byteData,
    );
    const sizeDelta = byteData.length - byteDeleteCount;

    // Build spans for the newly inserted data
    const newSpans: EntrySpan[] = [];
    if (byteData.length > 0) {
      // Parse only the inserted region to get spans
      const parsed = parseListEntries(byteData, this._serializer);
      for (const span of parsed.spans) {
        newSpans.push({
          start: span.start + byteOffset,
          end: span.end + byteOffset,
        });
      }
      // Use parsed items if we don't already have decoded values
      if (newItems.length === 0 && parsed.items.length > 0) {
        newItems = parsed.items;
      }
    }

    // Splice items and spans arrays
    this._items.splice(itemIndex, itemDeleteCount, ...newItems);
    this._spans.splice(itemIndex, itemDeleteCount, ...newSpans);

    // Adjust byte offsets for all spans after the splice point
    const adjustStart = itemIndex + newSpans.length;
    for (let i = adjustStart; i < this._spans.length; i++) {
      this._spans[i].start += sizeDelta;
      this._spans[i].end += sizeDelta;
    }

    this._version++;
    this._notify();
    this._saveLocalDebounced();
  }

  private _tryReparse(): boolean {
    const parsed = parseListEntries(this._raw, this._serializer);
    if (parsed.corrupt) {
      return false;
    }
    this._items = parsed.items;
    this._spans = parsed.spans;
    return true;
  }

  private _reparse() {
    const parsed = parseListEntries(this._raw, this._serializer);
    this._items = parsed.items;
    this._spans = parsed.spans;
  }

  private _selfHeal() {
    if (this._items.length > 0) {
      // Re-encode items from the last known good state
      const encoded = encodeEntries(this._items, this._serializer);
      this._raw = encoded;
      this._reparse();
      // Push clean state to server
      this._pico
        ._execOk(this._pico._encoder.set(this._name, this._raw))
        .catch(() => {});
    } else {
      // Nothing to recover from — reset to clean empty state.
      // Don't call refresh() here to avoid a loop if the server is also corrupt.
      console.warn(
        `[pico] corrupt data for "${this._name}" with no local state to recover`,
      );
      this._raw = new Uint8Array(0);
      this._spans = [];
      this._notify();
    }
  }

  private _reset() {
    this._raw = new Uint8Array(0);
    this._items = [];
    this._spans = [];
    this._version = 0;
  }

  private _notify() {
    for (const cb of this._subs) {
      try {
        cb(this._items);
      } catch (_) {}
    }
  }

  private _loadLocal() {
    if (!this._localKey || typeof globalThis.localStorage === "undefined")
      return;
    try {
      const raw = localStorage.getItem(this._localKey);
      if (!raw) return;
      const entry = JSON.parse(raw) as { v: number; d: string };
      this._raw = base64ToUint8(entry.d);
      this._version = entry.v;
      if (!this._tryReparse()) {
        console.warn(
          `[pico] corrupt local cache for "${this._name}", clearing`,
        );
        this._raw = new Uint8Array(0);
        this._items = [];
        this._spans = [];
        this._version = 0;
        this._clearLocal();
        return;
      }
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
}
