// src/__tests__/stores.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../core/state/utils.js';

describe('createStore', () => {
  // ── get ───────────────────────────────────────────────────────────────────

  it('returns initial state', () => {
    const store = createStore({ count: 0 });
    expect(store.get().count).toBe(0);
  });

  it('returned state is frozen', () => {
    const store = createStore({ count: 0 });
    const state = store.get() as { count: number };
    expect(Object.isFrozen(state)).toBe(true);
  });

  // ── set ───────────────────────────────────────────────────────────────────

  it('updates state via set', () => {
    const store = createStore({ count: 0 });
    store.set(s => ({ ...s, count: 5 }));
    expect(store.get().count).toBe(5);
  });

  it('set receives mutable clone — original not mutated by accident', () => {
    const store = createStore({ items: [1, 2, 3] });
    store.set(s => {
      s.items.push(4); // mutating the clone is fine
      return s;
    });
    expect(store.get().items).toEqual([1, 2, 3, 4]);
  });

  it('previous state object is not the same reference after set', () => {
    const store = createStore({ count: 0 });
    const before = store.get();
    store.set(s => ({ ...s, count: 1 }));
    const after = store.get();
    expect(before).not.toBe(after);
  });

  // ── subscribe ────────────────────────────────────────────────────────────

  it('subscriber called after each set', () => {
    const store = createStore({ count: 0 });
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(s => ({ ...s, count: 1 }));
    store.set(s => ({ ...s, count: 2 }));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('subscriber receives new state', () => {
    const store = createStore({ count: 0 });
    const cb = vi.fn();
    store.subscribe(cb);
    store.set(s => ({ ...s, count: 42 }));
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ count: 42 });
  });

  it('unsubscribe stops notifications', () => {
    const store = createStore({ count: 0 });
    const cb = vi.fn();
    const unsub = store.subscribe(cb);
    unsub();
    store.set(s => ({ ...s, count: 1 }));
    expect(cb).not.toHaveBeenCalled();
  });

  it('error in subscriber does not crash other subscribers', () => {
    const store = createStore({ count: 0 });
    const boom = vi.fn(() => { throw new Error('boom'); });
    const safe = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.subscribe(boom);
    store.subscribe(safe);
    store.set(s => ({ ...s, count: 1 }));
    expect(safe).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  // ── snapshot ─────────────────────────────────────────────────────────────

  it('snapshot returns deep clone', () => {
    const store = createStore({ nested: { x: 1 } });
    const snap = store.snapshot() as { nested: { x: number } };
    expect(snap.nested.x).toBe(1);
    // Mutating snapshot does not affect store
    (snap.nested as { x: number }).x = 99;
    expect(store.get().nested.x).toBe(1);
  });

  // ── Maps ─────────────────────────────────────────────────────────────────

  it('stores and retrieves Maps correctly via structuredClone', () => {
    const store = createStore({ map: new Map([['a', 1]]) });
    expect(store.get().map.get('a')).toBe(1);
    store.set(s => { s.map.set('b', 2); return s; });
    expect(store.get().map.get('b')).toBe(2);
    expect(store.get().map.get('a')).toBe(1);
  });

  // ── Type safety sanity (compile-time, checked via tsc in CI) ─────────────

  it('generic type inference preserves shape', () => {
    interface MyState { readonly name: string; readonly age: number; }
    const store = createStore<MyState>({ name: 'Alice', age: 30 });
    store.set(s => ({ ...s, age: 31 }));
    const state: MyState = store.get(); // must type-check
    expect(state.age).toBe(31);
  });
});
