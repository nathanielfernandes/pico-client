import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
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
  ReadonlyStore,
  ReadonlyListStore,
  ReadonlyMapStore,
} from "./types.js";

export type {
  PicoOptions,
  StoreOptions,
  CollectionStoreOptions,
  MapStoreOptions,
  Serializer,
  ReadonlyStore,
  ReadonlyListStore,
  ReadonlyMapStore,
};

// ── Context ────────────────────────────────────────────────────────

const PicoContext = createContext<Pico | null>(null);

export function PicoProvider({
  namespace,
  options,
  children,
}: {
  namespace: string;
  options?: PicoOptions;
  children: React.ReactNode;
}) {
  const picoRef = useRef<Pico | null>(null);
  if (!picoRef.current) {
    picoRef.current = new Pico(namespace, options);
  }

  useEffect(() => {
    const pico = picoRef.current!;
    // Swallow the initial-connect rejection — reconnect logic will keep
    // trying in the background, and consumers observe state via
    // `usePicoConnection()`.
    pico.connect().catch(() => {});
    return () => pico.close();
  }, []);

  return createElement(
    PicoContext.Provider,
    { value: picoRef.current },
    children,
  );
}

export function usePico(): Pico {
  const pico = useContext(PicoContext);
  if (!pico) throw new Error("usePico must be used within a PicoProvider");
  return pico;
}

// ── Optimistic wrapper ─────────────────────────────────────────────

class OptimisticStore<T> {
  private _store: Store<T>;
  private _optimistic: T | undefined;
  private _hasOptimistic = false;
  private _subs = new Set<() => void>();
  private _baseUnsub: (() => void) | null = null;

  constructor(store: Store<T>) {
    this._store = store;
  }

  get value(): T | undefined {
    return this._hasOptimistic ? this._optimistic : this._store.value;
  }

  get raw(): Store<T> {
    return this._store;
  }

  subscribe(onStoreChange: () => void): () => void {
    this._subs.add(onStoreChange);
    if (this._subs.size === 1) {
      let first = true;
      this._baseUnsub = this._store.subscribe(() => {
        if (first) {
          first = false;
          return;
        }
        this._hasOptimistic = false;
        this._notify();
      });
    }
    return () => {
      this._subs.delete(onStoreChange);
      if (this._subs.size === 0 && this._baseUnsub) {
        this._baseUnsub();
        this._baseUnsub = null;
      }
    };
  }

  set(value: T) {
    this._optimistic = value;
    this._hasOptimistic = true;
    this._notify();
    this._store.set(value).catch(() => {
      this._hasOptimistic = false;
      this._notify();
    });
  }

  private _notify() {
    for (const cb of this._subs) {
      try {
        cb();
      } catch (_) {}
    }
  }
}

// ── Hooks ──────────────────────────────────────────────────────────

export function usePicoStore<T>(
  name: string,
  options: StoreOptions<T> & { default: T },
): [value: T, set: (value: T | ((prev: T) => T)) => void, store: Store<T>];
export function usePicoStore<T>(
  name: string,
  options?: StoreOptions<T>,
): [
  value: T | undefined,
  set: (value: T | ((prev: T | undefined) => T)) => void,
  store: Store<T>,
];
export function usePicoStore<T>(
  name: string,
  options?: StoreOptions<T>,
): [
  value: T | undefined,
  set: (value: T | ((prev: T | undefined) => T)) => void,
  store: Store<T>,
] {
  const pico = usePico();
  const ref = useRef<OptimisticStore<T> | null>(null);
  if (!ref.current) {
    ref.current = new OptimisticStore(pico.store<T>(name, options));
  }
  const os = ref.current;

  const sub = useCallback(
    (onStoreChange: () => void) => os.subscribe(onStoreChange),
    [os],
  );
  const snap = useCallback(() => os.value, [os]);

  const value = useSyncExternalStore(sub, snap);

  const setValue = useCallback(
    (valueOrFn: T | ((prev: T | undefined) => T)) => {
      const next =
        typeof valueOrFn === "function"
          ? (valueOrFn as (prev: T | undefined) => T)(os.value)
          : valueOrFn;
      os.set(next);
    },
    [os],
  );

  return [value, setValue, os.raw];
}

// ── List store hook ────────────────────────────────────────────────

export interface PicoListHookResult<T> {
  value: T[];
  length: number;
  version: number;
  at(index: number): T | undefined;
  push(...items: T[]): Promise<void>;
  insertAt(index: number, ...items: T[]): Promise<void>;
  removeAt(index: number, count?: number): Promise<void>;
  setAt(index: number, value: T): Promise<void>;
  set(items: T[]): Promise<void>;
  patch(index: number, partial: Partial<T>): Promise<void>;
  refresh(): Promise<void>;
  delete(): Promise<void>;
  store: ListStore<T>;
}

export function usePicoListStore<T>(
  name: string,
  options?: CollectionStoreOptions<T>,
): PicoListHookResult<T> {
  const pico = usePico();
  const ref = useRef<ListStore<T> | null>(null);
  if (!ref.current) {
    ref.current = pico.list<T>(name, options);
  }
  const store = ref.current;

  const sub = useCallback(
    (onStoreChange: () => void) => {
      let first = true;
      return store.subscribe(() => {
        if (first) {
          first = false;
          return;
        }
        onStoreChange();
      });
    },
    [store],
  );
  const snap = useCallback(() => store.version, [store]);

  const version = useSyncExternalStore(sub, snap);

  return {
    value: store.items,
    length: store.length,
    version,
    at: (i) => store.at(i),
    push: (...items) => store.push(...items),
    insertAt: (index, ...items) => store.insertAt(index, ...items),
    removeAt: (index, count) => store.removeAt(index, count),
    setAt: (index, value) => store.setAt(index, value),
    patch: (index, partial) => store.patch(index, partial),
    set: (items) => store.set(items),
    refresh: () => store.refresh(),
    delete: () => store.delete(),
    store,
  };
}

// ── Map store hook ─────────────────────────────────────────────────

export interface PicoMapHookResult<V> {
  value: Map<string, V>;
  size: number;
  version: number;
  get(key: string): V | undefined;
  has(key: string): boolean;
  set(key: string, value: V): Promise<void>;
  remove(key: string): Promise<void>;
  setAll(entries: Record<string, V>): Promise<void>;
  refresh(): Promise<void>;
  delete(): Promise<void>;
  store: MapStore<V>;
}

export function usePicoMapStore<V>(
  name: string,
  options?: MapStoreOptions<V>,
): PicoMapHookResult<V> {
  const pico = usePico();
  const ref = useRef<MapStore<V> | null>(null);
  if (!ref.current) {
    ref.current = pico.map<V>(name, options);
  }
  const store = ref.current;

  const sub = useCallback(
    (onStoreChange: () => void) => {
      let first = true;
      return store.subscribe(() => {
        if (first) {
          first = false;
          return;
        }
        onStoreChange();
      });
    },
    [store],
  );
  const snap = useCallback(() => store.version, [store]);

  const version = useSyncExternalStore(sub, snap);

  return {
    value: store.entries,
    size: store.size,
    version,
    get: (key) => store.get(key),
    has: (key) => store.has(key),
    set: (key, value) => store.set(key, value),
    remove: (key) => store.remove(key),
    setAll: (entries) => store.setAll(entries),
    refresh: () => store.refresh(),
    delete: () => store.delete(),
    store,
  };
}

// ── Readonly hooks ─────────────────────────────────────────────────
// Thin wrappers that return type-narrowed views. Same subscription
// behavior as the mutable hooks — just no setter surface.

export function useReadonlyPicoStore<T>(
  name: string,
  options: StoreOptions<T> & { default: T },
): T;
export function useReadonlyPicoStore<T>(
  name: string,
  options?: StoreOptions<T>,
): T | undefined;
export function useReadonlyPicoStore<T>(
  name: string,
  options?: StoreOptions<T>,
): T | undefined {
  const [value] = usePicoStore<T>(name, options);
  return value;
}

export function useReadonlyPicoListStore<T>(
  name: string,
  options?: CollectionStoreOptions<T>,
): ReadonlyListStore<T> {
  return usePicoListStore<T>(name, options).store;
}

export function useReadonlyPicoMapStore<V>(
  name: string,
  options?: MapStoreOptions<V>,
): ReadonlyMapStore<V> {
  return usePicoMapStore<V>(name, options).store;
}

export function usePicoConnection(): boolean {
  const pico = usePico();

  const sub = useCallback(
    (onStoreChange: () => void) => {
      let first = true;
      return pico.onConnection(() => {
        if (first) {
          first = false;
          return;
        }
        onStoreChange();
      });
    },
    [pico],
  );
  const snap = useCallback(() => pico.connected, [pico]);

  return useSyncExternalStore(sub, snap);
}
