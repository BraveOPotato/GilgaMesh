// src/__tests__/event-bus.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../core/events.js';
import type { EventMap } from '../core/events.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ── on / emit ──────────────────────────────────────────────────────────────

  it('delivers payload to subscribed handler', () => {
    const handler = vi.fn();
    bus.on('peer:online', handler);
    bus.emit('peer:online', { peerId: 'amber-anvil-1234' as EventMap['peer:online']['peerId'] });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ peerId: 'amber-anvil-1234' });
  });

  it('delivers to multiple handlers for same event', () => {
    const h1 = vi.fn(), h2 = vi.fn();
    bus.on('peer:online', h1);
    bus.on('peer:online', h2);
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('does not deliver to handler of different event', () => {
    const handler = vi.fn();
    bus.on('peer:offline', handler);
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── unsubscribe ────────────────────────────────────────────────────────────

  it('unsubscribe stops delivery', () => {
    const handler = vi.fn();
    const unsub = bus.on('peer:online', handler);
    unsub();
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });
    expect(handler).not.toHaveBeenCalled();
  });

  it('unsubscribing one handler does not affect others', () => {
    const h1 = vi.fn(), h2 = vi.fn();
    const unsub1 = bus.on('peer:online', h1);
    bus.on('peer:online', h2);
    unsub1();
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });

  it('double-unsubscribe is a no-op', () => {
    const handler = vi.fn();
    const unsub = bus.on('peer:online', handler);
    unsub();
    expect(() => unsub()).not.toThrow();
  });

  // ── once ──────────────────────────────────────────────────────────────────

  it('once fires exactly once', () => {
    const handler = vi.fn();
    bus.once('peer:online', handler);
    const p = { peerId: 'a' as EventMap['peer:online']['peerId'] };
    bus.emit('peer:online', p);
    bus.emit('peer:online', p);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('once returns unsubscribe that cancels before first delivery', () => {
    const handler = vi.fn();
    const unsub = bus.once('peer:online', handler);
    unsub();
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });
    expect(handler).not.toHaveBeenCalled();
  });

  // ── error isolation ────────────────────────────────────────────────────────

  it('error in one handler does not prevent others from running', () => {
    const boom  = vi.fn(() => { throw new Error('boom'); });
    const safe  = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    bus.on('peer:online', boom);
    bus.on('peer:online', safe);
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });

    expect(safe).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  // ── listenerCount ─────────────────────────────────────────────────────────

  it('listenerCount returns correct count', () => {
    expect(bus.listenerCount('peer:online')).toBe(0);
    const u1 = bus.on('peer:online', vi.fn());
    const u2 = bus.on('peer:online', vi.fn());
    expect(bus.listenerCount('peer:online')).toBe(2);
    u1();
    expect(bus.listenerCount('peer:online')).toBe(1);
    u2();
    expect(bus.listenerCount('peer:online')).toBe(0);
  });

  // ── clear ─────────────────────────────────────────────────────────────────

  it('clear removes all listeners', () => {
    const handler = vi.fn();
    bus.on('peer:online', handler);
    bus.on('peer:offline', handler);
    bus.clear();
    bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] });
    expect(handler).not.toHaveBeenCalled();
    expect(bus.listenerCount('peer:online')).toBe(0);
  });

  // ── emit with no listeners ────────────────────────────────────────────────

  it('emit with no listeners is a no-op (no throw)', () => {
    expect(() =>
      bus.emit('peer:online', { peerId: 'a' as EventMap['peer:online']['peerId'] })
    ).not.toThrow();
  });

  // ── logger ────────────────────────────────────────────────────────────────

  it('logger receives event name, payload, and listener count', () => {
    const logger = vi.fn();
    const b = new EventBus({ logger });
    b.on('peer:online', vi.fn());
    const p = { peerId: 'a' as EventMap['peer:online']['peerId'] };
    b.emit('peer:online', p);
    expect(logger).toHaveBeenCalledWith('peer:online', p, 1);
  });
});
