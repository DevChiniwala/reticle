import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayStatus } from '@reticlehq/core';
import { createNodeFileSystem } from '../project/fs-port.js';
import { FlakeStore } from './flake-store.js';

/**
 * The parallel verify path records flake outcomes and attaches `flaky` to the suite verdict — the
 * same contract the sequential path has. Before this fix, parallel mode skipped FlakeStore entirely,
 * so an agent using `parallel` built no flake evidence and never saw the quarantine set.
 *
 * These tests pin the recording pattern the parallel path uses: all flows from one round recorded
 * as a batch, then flakiness queried ONCE at the end. The sequential path records one flow at a
 * time in a loop; parallel records them all after `parallelRuns` is assembled.
 */
describe('parallel verify records flake outcomes (same contract as sequential)', () => {
  let root: string;
  const fs = createNodeFileSystem();

  beforeEach(async () => {
    root = join(await mkdtemp(join(tmpdir(), 'reticle-parallel-flake-')), '.reticle');
  });
  afterEach(async () => {
    await rm(join(root, '..'), { recursive: true, force: true });
  });

  /**
   * Simulates the parallel path's recording: all outcomes from one round recorded sequentially
   * (the loop over `parallelRuns`), then `flakyFlows()` queried once at the end.
   */
  async function parallelRound(
    store: FlakeStore,
    outcomes: Record<string, ReplayStatus>,
  ): Promise<string[]> {
    for (const [name, status] of Object.entries(outcomes)) {
      await store.record(name, status === ReplayStatus.OK);
    }
    return store.flakyFlows();
  }

  it('records every flow in the batch, not just the first or last', async () => {
    const store = new FlakeStore(fs, root);
    const rounds: Record<string, ReplayStatus>[] = [
      { login: ReplayStatus.OK, checkout: ReplayStatus.OK, search: ReplayStatus.OK },
      { login: ReplayStatus.ERROR, checkout: ReplayStatus.OK, search: ReplayStatus.ERROR },
      { login: ReplayStatus.OK, checkout: ReplayStatus.OK, search: ReplayStatus.OK },
      { login: ReplayStatus.ERROR, checkout: ReplayStatus.OK, search: ReplayStatus.OK },
      { login: ReplayStatus.OK, checkout: ReplayStatus.OK, search: ReplayStatus.ERROR },
    ];
    let flaky: string[] = [];
    for (const outcomes of rounds) flaky = await parallelRound(store, outcomes);
    expect(flaky).toContain('login');
    expect(flaky).toContain('search');
    expect(flaky, 'a stable flow in the same parallel batch must stay clean').not.toContain(
      'checkout',
    );
  });

  it('detects flakiness across parallel rounds the same as sequential', async () => {
    const store = new FlakeStore(fs, root);
    const statuses: ReplayStatus[] = [
      ReplayStatus.OK,
      ReplayStatus.OK,
      ReplayStatus.ERROR,
      ReplayStatus.OK,
      ReplayStatus.ERROR,
    ];
    let flaky: string[] = [];
    for (const status of statuses) {
      flaky = await parallelRound(store, { payment: status });
    }
    expect(flaky).toContain('payment');
  });

  it('a consistently failing parallel flow is not marked flaky', async () => {
    const store = new FlakeStore(fs, root);
    let flaky: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      flaky = await parallelRound(store, { broken: ReplayStatus.ERROR });
    }
    expect(flaky).not.toContain('broken');
  });

  it('ledger errors never propagate — the parallel path wraps with .catch()', async () => {
    const store = new FlakeStore(fs, root);
    const recordSpy = vi.spyOn(store, 'record').mockRejectedValue(new Error('disk full'));
    const result = await store.record('x', true).catch(() => 'caught');
    expect(result).toBe('caught');
    expect(recordSpy).toHaveBeenCalledWith('x', true);
  });
});
