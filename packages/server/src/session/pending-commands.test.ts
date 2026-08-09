import { describe, it, expect, vi, afterEach } from 'vitest';
import { PendingCommands } from './pending-commands.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('PendingCommands timer lifecycle', () => {
  it('rejectAll clears the timeout timer (no leak after session disconnect)', () => {
    vi.useFakeTimers();
    const cmds = new PendingCommands();
    const id = cmds.nextId('c');
    const promise = cmds.track(id, 30_000, () => 'timed out');

    cmds.rejectAll('session disconnected');

    expect(vi.getTimerCount()).toBe(0);
    void promise.catch(() => {});
  });

  it('settle clears the timeout timer (no leak on normal resolution)', () => {
    vi.useFakeTimers();
    const cmds = new PendingCommands();
    const id = cmds.nextId('c');
    const promise = cmds.track(id, 5000, () => 'timed out');

    cmds.settle({ id, ok: true });

    expect(vi.getTimerCount()).toBe(0);
    void promise;
  });

  it('a timed-out command rejects with the described message', async () => {
    vi.useFakeTimers();
    const cmds = new PendingCommands();
    const id = cmds.nextId('c');
    const promise = cmds.track(id, 2000, () => "command 'slow_cmd' timed out after 2000ms");

    vi.advanceTimersByTime(2000);

    await expect(promise).rejects.toThrow("command 'slow_cmd' timed out after 2000ms");
  });

  it('the timeout timer is unrefed so it does not keep the process alive', () => {
    vi.useFakeTimers();
    const realSetTimeout = globalThis.setTimeout;
    const unrefCalls: unknown[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
      const timer = realSetTimeout(fn as () => void, ms as number);
      const origUnref = timer.unref.bind(timer);
      timer.unref = () => {
        unrefCalls.push(timer);
        return origUnref();
      };
      return timer;
    });

    const cmds = new PendingCommands();
    const id = cmds.nextId('c');
    void cmds.track(id, 1000, () => 'timeout').catch(() => {});

    expect(unrefCalls).toHaveLength(1);
    cmds.rejectAll('cleanup');
    vi.restoreAllMocks();
  });
});
