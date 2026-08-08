import { describe, expect, it } from 'vitest';
import { PendingCommands } from './pending-commands.js';

const result = (id: string, ok = true, data?: unknown): {
  kind: 'command_result'; id: string; ok: boolean; result?: unknown;
} => ({ kind: 'command_result', id, ok, ...(data !== undefined ? { result: data } : {}) });

describe('PendingCommands', () => {
  it('resolves when settle is called with a matching id', async () => {
    const pc = new PendingCommands();
    const id = pc.nextId('c');
    const promise = pc.track(id, 5000, () => 'timed out');
    pc.settle(result(id, true, 'done'));
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.result).toBe('done');
  });

  it('rejects on timeout with a lazy message', async () => {
    const pc = new PendingCommands();
    const id = pc.nextId('c');
    const promise = pc.track(id, 1, () => 'command X timed out');
    await expect(promise).rejects.toThrow('command X timed out');
  });

  it('rejectAll clears every in-flight command', async () => {
    const pc = new PendingCommands();
    const a = pc.track(pc.nextId('c'), 5000, () => '');
    const b = pc.track(pc.nextId('c'), 5000, () => '');
    pc.rejectAll('disconnect');
    await expect(a).rejects.toThrow('disconnect');
    await expect(b).rejects.toThrow('disconnect');
  });

  it('timeout timer is unrefed so it does not keep the event loop alive', async () => {
    const pc = new PendingCommands();
    const id = pc.nextId('c');
    const promise = pc.track(id, 60_000, () => 'should not fire');
    pc.settle(result(id));
    await promise;
  });
});
