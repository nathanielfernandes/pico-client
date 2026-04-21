import { Pico } from "./client";
import { ListStore } from "./list-store";
import { MapStore } from "./map-store";
import { Json, CsvStringArray } from "./serializers";
import { Store } from "./store";
import { Serializer } from "./types";

export type StoreTypes = "store" | "list" | "map";

export type StoreForType<T, S extends StoreTypes> = S extends "store"
  ? Store<T>
  : S extends "list"
    ? ListStore<T>
    : S extends "map"
      ? MapStore<T>
      : never;

type ValueTypeByStoreType<T, S extends StoreTypes> = S extends "store"
  ? T
  : S extends "list"
    ? T[]
    : S extends "map"
      ? Map<string, T>
      : never;

type MultiStoreCallback<V, S extends StoreTypes> = (
  key: string,
  store: StoreForType<V, S> | undefined,
) => void;

export class MultiStore<V, S extends StoreTypes> {
  private _pico: Pico;
  private _name: string;
  private _type: S;
  private _stores: Map<string, StoreForType<V, S>>;
  private _keys: Store<string[]>;
  private _serializer: Serializer<ValueTypeByStoreType<V, S>>;
  private _localKey: string | null;
  private _readyResolve!: () => void;
  private _subs: Set<MultiStoreCallback<V, S>>;
  private _unsubs: Map<string, () => void>;
  readonly ready: Promise<void>;

  constructor(
    pico: Pico,
    name: string,
    type: S,
    serializer?: Serializer<ValueTypeByStoreType<V, S>>,
    localKey?: string,
  ) {
    this._pico = pico;
    this._stores = new Map();
    this._name = name;
    this._keys = pico.store<string[]>(name, {
      default: [],
      serializer: CsvStringArray,
      local: !!localKey,
    });
    this._localKey = localKey ?? null;
    this._serializer = serializer ?? Json;
    this._type = type;
    this._subs = new Set();
    this._unsubs = new Map();
    this.ready = new Promise((r) => {
      this._readyResolve = r;
    });
    this._init();
  }

  /** Subscribe to all inner store changes. Fires immediately for each existing key. */
  subscribe(cb: MultiStoreCallback<V, S>): () => void {
    this._subs.add(cb);

    for (const [key, store] of this._stores) {
      cb(key, store);
    }

    return () => {
      this._subs.delete(cb);
    };
  }

  /** Get a store by key, creating it if it doesn't exist. */
  async store(name: string): Promise<StoreForType<V, S>> {
    let store = this._stores.get(name);
    if (!store) {
      store = await this._createStore(name);
      // Register locally before persisting, so that the _reconcile
      // callback (triggered by _keys.set) sees the key as a no-op.
      this._stores.set(name, store);
      this._subscribeInner(name, store);
      await this._persistKeys();
    }
    return store;
  }

  /** Delete a store by key. */
  async delete(name: string): Promise<void> {
    const store = this._stores.get(name);
    if (store) {
      this._unsubscribeInner(name);
      await store.delete();
      this._stores.delete(name);
      this._notify(name, undefined);
    }
    await this._persistKeys();
  }

  /** Get a store by key without creating it. */
  get(key: string): StoreForType<V, S> | undefined {
    return this._stores.get(key);
  }

  /** Check whether a store exists for the given key. */
  has(key: string): boolean {
    return this._stores.has(key);
  }

  /** Current store keys. */
  keys(): string[] {
    return Array.from(this._stores.keys());
  }

  /** Number of inner stores. */
  get size(): number {
    return this._stores.size;
  }

  // ── private ────────────────────────────────────────────────────────

  private async _init() {
    await this._keys.ready;

    const names = this._keys.value ?? [];
    const readyPromises: Promise<void>[] = [];

    for (const name of names) {
      const store = await this._createStore(name);
      this._stores.set(name, store);
      this._subscribeInner(name, store);
      readyPromises.push(store.ready);
    }

    await Promise.all(readyPromises);
    this._readyResolve();

    // Stay in sync with other clients: when the key list changes
    // (via server push from another client), reconcile inner stores.
    this._keys.subscribe((names) => {
      this._reconcile(new Set(names ?? []));
    });
  }

  /** Reconcile local stores with the authoritative key set. */
  private async _reconcile(remoteKeys: Set<string>) {
    // Add stores that appeared remotely
    for (const key of remoteKeys) {
      if (!this._stores.has(key)) {
        const store = await this._createStore(key);
        this._stores.set(key, store);
        this._subscribeInner(key, store);
      }
    }

    // Remove stores that disappeared remotely
    for (const key of this._stores.keys()) {
      if (!remoteKeys.has(key)) {
        this._unsubscribeInner(key);
        this._stores.delete(key);
        this._notify(key, undefined);
      }
    }
  }

  private async _persistKeys(): Promise<void> {
    await this._keys.set(Array.from(this._stores.keys()));
  }

  private _subscribeInner(key: string, store: StoreForType<V, S>) {
    const unsub = store.subscribe(() => {
      this._notify(key, store);
    });
    this._unsubs.set(key, unsub);
  }

  private _unsubscribeInner(key: string) {
    const unsub = this._unsubs.get(key);
    if (unsub) {
      unsub();
      this._unsubs.delete(key);
    }
  }

  private _notify(key: string, store: StoreForType<V, S> | undefined) {
    for (const cb of this._subs) {
      try {
        cb(key, store);
      } catch (_) {}
    }
  }

  private async _createStore(name: string): Promise<StoreForType<V, S>> {
    const storeName = `${this._name}-${name}`;
    let store: StoreForType<V, S>;
    switch (this._type) {
      case "store":
        store = this._pico.store<ValueTypeByStoreType<V, S>>(storeName, {
          serializer: this._serializer,
          local: !!this._localKey,
        }) as StoreForType<V, S>;
        break;
      case "list":
        store = this._pico.list<ValueTypeByStoreType<V, S>>(storeName, {
          serializer: this._serializer,
          local: !!this._localKey,
        }) as StoreForType<V, S>;
        break;
      case "map":
        store = this._pico.map<ValueTypeByStoreType<V, S>>(storeName, {
          serializer: this._serializer,
          local: !!this._localKey,
        }) as StoreForType<V, S>;
        break;
    }
    await store.ready;

    return store;
  }
}
