import { getContext, setContext } from "svelte";
import { Pico } from "./client.js";
import { Store } from "./store.js";
import { ListStore } from "./list-store.js";
import { MapStore } from "./map-store.js";
import type {
  PicoOptions,
  StoreOptions,
  CollectionStoreOptions,
  MapStoreOptions,
  Serializer,
} from "./types.js";

export type {
  PicoOptions,
  StoreOptions,
  CollectionStoreOptions,
  MapStoreOptions,
  Serializer,
};

// ── Readonly view interfaces for the svelte wrappers ───────────────
// Mirror the runes-reactive wrappers but omit mutators.

export interface ReadonlyPicoStore<T> {
  readonly value: T;
  readonly version: number;
  readonly ready: Promise<void>;
  subscribe(cb: (value: T) => void): () => void;
  refresh(): Promise<void>;
  onDelete(cb: () => void): () => void;
}

export interface ReadonlyPicoListStore<T> {
  readonly items: T[];
  readonly length: number;
  readonly version: number;
  readonly ready: Promise<void>;
  subscribe(cb: (items: T[]) => void): () => void;
  at(index: number): T | undefined;
  refresh(): Promise<void>;
  onDelete(cb: () => void): () => void;
}

export interface ReadonlyPicoMapStore<V> {
  readonly entries: Map<string, V>;
  readonly size: number;
  readonly version: number;
  readonly ready: Promise<void>;
  subscribe(cb: (entries: Map<string, V>) => void): () => void;
  get(key: string): V | undefined;
  has(key: string): boolean;
  refresh(): Promise<void>;
  onDelete(cb: () => void): () => void;
}

interface PicoInstance {
  connect(): Promise<void>;
  close(): void;
  readonly connected: boolean;
  store<T>(name: string, opts: StoreOptions<T> & { default: T }): PicoStore<T>;
  store<T>(name: string, opts?: StoreOptions<T>): PicoStore<T | undefined>;
  list<T>(name: string, opts?: CollectionStoreOptions<T>): PicoListStore<T>;
  map<V>(name: string, opts?: MapStoreOptions<V>): PicoMapStore<V>;
  readonlyStore<T>(
    name: string,
    opts: StoreOptions<T> & { default: T },
  ): ReadonlyPicoStore<T>;
  readonlyStore<T>(
    name: string,
    opts?: StoreOptions<T>,
  ): ReadonlyPicoStore<T | undefined>;
  readonlyList<T>(
    name: string,
    opts?: CollectionStoreOptions<T>,
  ): ReadonlyPicoListStore<T>;
  readonlyMap<V>(
    name: string,
    opts?: MapStoreOptions<V>,
  ): ReadonlyPicoMapStore<V>;
  readonly pico: Pico;
}

export function createPico(
  namespace: string,
  options?: PicoOptions,
): PicoInstance {
  const pico = new Pico(namespace, options);
  const stores = new Map<string, PicoStore<any>>();
  const lists = new Map<string, PicoListStore<any>>();
  const maps = new Map<string, PicoMapStore<any>>();

  let connected = $state(false);
  pico.onConnection((c) => {
    connected = c;
  });

  return {
    connect() {
      return pico.connect();
    },
    close() {
      pico.close();
    },
    get connected() {
      return connected;
    },
    store(name: string, opts?: StoreOptions<any>) {
      let s = stores.get(name);
      if (!s) {
        s = new PicoStore(pico.store(name, opts));
        stores.set(name, s);
      }
      return s;
    },
    list(name: string, opts?: CollectionStoreOptions<any>) {
      let s = lists.get(name);
      if (!s) {
        s = new PicoListStore(pico.list(name, opts));
        lists.set(name, s);
      }
      return s;
    },
    map(name: string, opts?: MapStoreOptions<any>) {
      let s = maps.get(name);
      if (!s) {
        s = new PicoMapStore(pico.map(name, opts));
        maps.set(name, s);
      }
      return s;
    },
    readonlyStore(name: string, opts?: StoreOptions<any>) {
      return this.store(name, opts);
    },
    readonlyList(name: string, opts?: CollectionStoreOptions<any>) {
      return this.list(name, opts);
    },
    readonlyMap(name: string, opts?: MapStoreOptions<any>) {
      return this.map(name, opts);
    },
    pico,
  };
}

// ── Context-based hooks ────────────────────────────────────────────

const PICO_CONTEXT_KEY = Symbol("pico");

export function setPicoContext(pico: PicoInstance): PicoInstance {
  setContext(PICO_CONTEXT_KEY, pico);
  return pico;
}

export function usePico(): PicoInstance {
  const pico = getContext<PicoInstance | undefined>(PICO_CONTEXT_KEY);
  if (!pico) {
    throw new Error(
      "usePico: no Pico context found. Call setPicoContext(createPico(...)) in a parent component.",
    );
  }
  return pico;
}

export function usePicoStore<T>(
  name: string,
  options: StoreOptions<T> & { default: T },
): PicoStore<T>;
export function usePicoStore<T>(
  name: string,
  options?: StoreOptions<T>,
): PicoStore<T | undefined>;
export function usePicoStore<T>(
  name: string,
  options?: StoreOptions<T>,
): PicoStore<T | undefined> {
  return usePico().store<T>(name, options as StoreOptions<T>);
}

export function usePicoListStore<T>(
  name: string,
  options?: CollectionStoreOptions<T>,
): PicoListStore<T> {
  return usePico().list<T>(name, options);
}

export function usePicoMapStore<V>(
  name: string,
  options?: MapStoreOptions<V>,
): PicoMapStore<V> {
  return usePico().map<V>(name, options);
}

export class PicoListStore<T> {
  #items = $state<T[]>([]);
  #version = $state(0);
  #base;

  constructor(base: ListStore<T>) {
    this.#base = base;
    this.#items = base.items;
    this.#version = base.version;
    base.subscribe((items) => {
      this.#items = [...items];
      this.#version = base.version;
    });
  }

  get items(): T[] {
    return this.#items;
  }

  get length(): number {
    return this.#items.length;
  }

  get version(): number {
    return this.#version;
  }

  get store() {
    return this.#base;
  }

  get ready(): Promise<void> {
    return this.#base.ready;
  }

  /** A type-narrowed readonly view of this list. */
  get readonly(): ReadonlyPicoListStore<T> {
    return this;
  }

  at(index: number) {
    return this.#base.at(index);
  }
  push(...items: T[]) {
    return this.#base.push(...items);
  }
  insertAt(index: number, ...items: T[]) {
    return this.#base.insertAt(index, ...items);
  }
  removeAt(index: number, count?: number) {
    return this.#base.removeAt(index, count);
  }
  setAt(index: number, value: T) {
    return this.#base.setAt(index, value);
  }
  patch(index: number, partial: Partial<T>) {
    return this.#base.patch(index, partial);
  }
  set(items: T[]) {
    return this.#base.set(items);
  }
  refresh() {
    return this.#base.refresh();
  }
  delete() {
    return this.#base.delete();
  }
  onDelete(cb: () => void) {
    return this.#base.onDelete(cb);
  }
  subscribe(cb: (items: T[]) => void): () => void {
    return this.#base.subscribe(cb);
  }
}

export class PicoMapStore<V> {
  #entries = $state<Map<string, V>>(new Map());
  #version = $state(0);
  #base;

  constructor(base: MapStore<V>) {
    this.#base = base;
    this.#entries = new Map(base.entries);
    this.#version = base.version;
    base.subscribe((entries) => {
      this.#entries = new Map(entries);
      this.#version = base.version;
    });
  }

  get entries(): Map<string, V> {
    return this.#entries;
  }

  get size(): number {
    return this.#entries.size;
  }

  get version(): number {
    return this.#version;
  }

  get store() {
    return this.#base;
  }

  /** A type-narrowed readonly view of this map. */
  get readonly(): ReadonlyPicoMapStore<V> {
    return this;
  }

  get ready(): Promise<void> {
    return this.#base.ready;
  }

  get(key: string) {
    return this.#entries.get(key);
  }
  has(key: string) {
    return this.#entries.has(key);
  }
  set(key: string, value: V) {
    return this.#base.set(key, value);
  }
  remove(key: string) {
    return this.#base.remove(key);
  }
  setAll(entries: Record<string, V>) {
    return this.#base.setAll(entries);
  }
  refresh() {
    return this.#base.refresh();
  }
  delete() {
    return this.#base.delete();
  }
  onDelete(cb: () => void) {
    return this.#base.onDelete(cb);
  }
  subscribe(cb: (entries: Map<string, V>) => void): () => void {
    return this.#base.subscribe(cb);
  }
}

export class PicoStore<T> {
  #value = $state<T>() as T;
  #version = $state(0);
  #base;
  #errorCbs = new Set<(error: Error) => void>();

  constructor(base: Store<T>) {
    this.#base = base;
    this.#value = base.value as T;
    this.#version = base.version;
    base.subscribe((v) => {
      this.#value = v as T;
      this.#version = base.version;
    });
  }

  get value(): T {
    return this.#value;
  }

  set value(v: T) {
    this.#value = v;
    this.#base.set(v).catch((err) => {
      this.#value = this.#base.value as T;
      this.#version = this.#base.version;
      for (const cb of this.#errorCbs) {
        try {
          cb(err instanceof Error ? err : new Error(String(err)));
        } catch (_) {}
      }
    });
  }

  get version(): number {
    return this.#version;
  }

  get store() {
    return this.#base;
  }

  /** A type-narrowed readonly view of this store. */
  get readonly(): ReadonlyPicoStore<T> {
    return this;
  }

  get ready(): Promise<void> {
    return this.#base.ready;
  }

  refresh() {
    return this.#base.refresh();
  }

  delete() {
    return this.#base.delete();
  }

  onDelete(cb: () => void) {
    return this.#base.onDelete(cb);
  }
  subscribe(cb: (value: T) => void): () => void {
    return this.#base.subscribe(cb as (value: T | undefined) => void);
  }
  set(value: T): void {
    this.value = value;
  }

  onError(cb: (error: Error) => void) {
    this.#errorCbs.add(cb);
    return () => {
      this.#errorCbs.delete(cb);
    };
  }
}
