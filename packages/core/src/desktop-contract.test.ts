import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DESKTOP_CONTRACT } from './desktop-contract.js';
import { renderDesktopContract } from '../scripts/gen-desktop-contract.mjs';

/**
 * The desktop contract has to hold across module systems that cannot import each other: a CommonJS
 * Electron preload, the ESM renderer SDK, and the Node daemon. It used to hold because six files
 * hand-copied the same strings, and a rename in any one broke desktop silently.
 *
 * Now the CommonJS view is GENERATED from the TypeScript source, so drift is not something to police
 * — it is impossible by construction. What is still worth asserting is that the generator stays
 * honest and that the committed build output is current.
 */
describe('desktop contract generation', () => {
  it('renders every exported constant into the CommonJS view', () => {
    const rendered = renderDesktopContract(DESKTOP_CONTRACT);
    for (const [name, value] of Object.entries(DESKTOP_CONTRACT)) {
      expect(rendered, `${name} must reach the CJS side`).toContain(name);
      expect(rendered, `${name}'s value must reach the CJS side`).toContain(JSON.stringify(value));
    }
  });

  it('renders a module a CommonJS preload can actually require', () => {
    const rendered = renderDesktopContract({ EXAMPLE: 'value' });
    expect(rendered).toContain("'use strict'");
    expect(rendered).toContain('exports.EXAMPLE');
    // Frozen so a misbehaving app cannot mutate the contract out from under the SDK.
    expect(rendered).toContain('Object.freeze(exports)');
  });

  it('marks the output as generated so nobody hand-edits it', () => {
    expect(renderDesktopContract(DESKTOP_CONTRACT)).toMatch(/GENERATED/);
  });

  /**
   * Catches the one failure the generator cannot prevent: a constant changed in source and the
   * package published without rebuilding, so the preload requires stale values.
   */
  it('has a built CJS view matching the current source', () => {
    const built = join(process.cwd(), 'dist', 'desktop-contract.cjs');
    if (!existsSync(built)) return; // a clean tree before `pnpm build` — nothing to compare yet
    expect(readFileSync(built, 'utf8')).toBe(renderDesktopContract(DESKTOP_CONTRACT));
  });
});

/**
 * The Rust side of the contract, which no generator can reach.
 *
 * `reticle-tauri` writes the capture file and the daemon decides whether to read it, and the two
 * agree only on a shared filename prefix. They are in different languages and different build
 * systems, so nothing but this test stands between a rename here and screenshots that go on being
 * written while the daemon silently refuses every one of them.
 */
describe('desktop contract — the Rust capture helper', () => {
  const CRATE = join(process.cwd(), '..', 'tauri', 'src', 'capture.rs');

  it('spells the capture prefix exactly as the daemon requires', () => {
    if (!existsSync(CRATE)) return; // the crate is not part of the TypeScript build
    const source = readFileSync(CRATE, 'utf8');
    expect(source).toContain(`{CAPTURE_FILE_PREFIX}`);
  });

  it('defines that prefix as the value the daemon checks for', () => {
    const lib = join(process.cwd(), '..', 'tauri', 'src', 'lib.rs');
    if (!existsSync(lib)) return;
    expect(readFileSync(lib, 'utf8')).toContain(
      `const CAPTURE_FILE_PREFIX: &str = "${DESKTOP_CONTRACT.RETICLE_CAPTURE_FILE_PREFIX}";`,
    );
  });

  it('spells the full-page refusal exactly as the daemon reads it', () => {
    const lib = join(process.cwd(), '..', 'tauri', 'src', 'lib.rs');
    if (!existsSync(lib)) return;
    expect(readFileSync(lib, 'utf8')).toContain(
      `pub const FULL_PAGE_UNSUPPORTED: &str = "${DESKTOP_CONTRACT.RETICLE_FULL_PAGE_UNSUPPORTED}";`,
    );
  });

  it('registers the command name the SDK invokes', () => {
    const capture = existsSync(CRATE) ? readFileSync(CRATE, 'utf8') : '';
    if (capture === '') return;
    expect(capture).toContain(`pub async fn ${DESKTOP_CONTRACT.RETICLE_TAURI_CAPTURE_COMMAND}(`);
  });
});
