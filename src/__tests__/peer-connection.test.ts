// src/__tests__/peer-connection.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PeerConnection } from '../network/peer-connection.js';
import { EventBus } from '../core/events.js';
import type { PeerId } from '../core/types.js';

function makePeerId(s: string): PeerId { return s as PeerId; }

function makeDataConn(open = true) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    peer:   'remote-peer',
    label:  '',
    open,
    send:   vi.fn(),
    close:  vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event]!.push(cb);
    },
    _trigger: (event: string, ...args: unknown[]) => {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
  };
}

describe('PeerConnection', () => {
  let bus:  EventBus;
  const pid = makePeerId('remote-peer');
  const myId = makePeerId('me');

  beforeEach(() => {
    bus = new EventBus();
  });

  it('isOpen() returns true when conn is open and not disposed', () => {
    const conn = makeDataConn(true);
    const pc = new PeerConnection(pid, conn as never, bus, myId);
    expect(pc.isOpen()).toBe(true);
  });

  it('isOpen() returns false when conn is closed', () => {
    const conn = makeDataConn(false);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    expect(pc.isOpen()).toBe(false);
  });

  it('send() returns true on success', () => {
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    const sent = pc.send({ type: 'ping' });
    expect(sent).toBe(true);
    expect(conn.send).toHaveBeenCalledWith({ type: 'ping' });
  });

  it('send() returns false when disposed', () => {
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    pc.dispose();
    const sent = pc.send({ type: 'ping' });
    expect(sent).toBe(false);
  });

  it('dispose() emits peer:offline', () => {
    const events: string[] = [];
    bus.on('peer:offline', () => events.push('offline'));

    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    pc.dispose();

    expect(events).toHaveLength(1);
    expect(pc.isDisposed()).toBe(true);
  });

  it('double dispose() is idempotent', () => {
    const events: string[] = [];
    bus.on('peer:offline', () => events.push('offline'));
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    pc.dispose();
    pc.dispose();
    expect(events).toHaveLength(1); // only one event
  });

  it('conn close event triggers dispose', () => {
    const events: string[] = [];
    bus.on('peer:offline', () => events.push('offline'));
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    conn._trigger('close');
    expect(pc.isDisposed()).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('recordPong tracks RTT and emits latency-update', () => {
    const latencies: number[] = [];
    bus.on('peer:latency-update', ({ rtt }) => latencies.push(rtt));
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    const sent = Date.now() - 50;
    pc.recordPong(sent);
    expect(latencies).toHaveLength(1);
    expect(latencies[0]).toBeGreaterThanOrEqual(50);
  });

  it('getAverageRtt returns Infinity with no samples', () => {
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    expect(pc.getAverageRtt()).toBe(Infinity);
  });

  it('getAverageRtt computes average over samples', () => {
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    // Fake three pongs with known RTTs
    pc.recordPong(Date.now() - 100);
    pc.recordPong(Date.now() - 200);
    pc.recordPong(Date.now() - 300);
    const avg = pc.getAverageRtt(3);
    expect(avg).toBeGreaterThan(100);
    expect(avg).toBeLessThan(500);
  });

  it('room tracking works', () => {
    const conn = makeDataConn(true);
    const pc   = new PeerConnection(pid, conn as never, bus, myId);
    pc.addRoom('room-1');
    pc.addRoom('room-2');
    expect(pc.getRooms().has('room-1')).toBe(true);
    pc.removeRoom('room-1');
    expect(pc.getRooms().has('room-1')).toBe(false);
    expect(pc.getRooms().has('room-2')).toBe(true);
  });
});
