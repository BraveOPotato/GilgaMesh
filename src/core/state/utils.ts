// src/core/state/utils.ts
// ─── IMMUTABLE STORE FACTORY ─────────────────────────────────────────────────
// Wraps domain state in a minimal reactive container.
// All reads return frozen copies. Mutations go through set().

export interface Store<T> {
  /** Current state (frozen deep clone). */
  readonly get: () => Readonly<T>;
  /**
   * Update state. Updater receives a deep clone of current state.
   * Return a new value — never mutate the argument.
   */
  readonly set: (updater: (prev: T) => T) => void;
  /** Subscribe to state changes. Returns unsubscribe function. */
  readonly subscribe: (listener: (state: Readonly<T>) => void) => () => void;
  /** One-time snapshot — deep frozen clone. */
  readonly snapshot: () => Readonly<T>;
}

/**
 * createStore<T>(initial)
 *
 * Uses structuredClone for deep immutability. Maps and Sets are preserved.
 * Note: structuredClone does NOT clone class instances — keep state as plain
 * objects/Maps/Sets only.
 */
export function createStore<T>(initial: T): Store<T> {
  let state: T = freeze(initial);
  const listeners = new Set<(state: Readonly<T>) => void>();

  function freeze(val: T): T {
    return Object.freeze(structuredClone(val)) as T;
  }

  return {
    get: () => state as Readonly<T>,

    set: (updater) => {
      // Give updater a mutable clone; freeze the result.
      const mutableCopy = structuredClone(state) as T;
      const next = freeze(updater(mutableCopy));
      state = next;
      for (const listener of listeners) {
        try {
          listener(next as Readonly<T>);
        } catch (err) {
          console.error('[Store] Error in subscriber:', err);
        }
      }
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    snapshot: () => Object.freeze(structuredClone(state)) as Readonly<T>,
  };
}
