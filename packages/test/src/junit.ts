import type { FileSystemPort } from '@reticlehq/server';
import { DEFAULT_JUNIT_SUITE_NAME, JUnit, TestStatus } from './constants.js';
import { summarize } from './summary.js';
import type { SpecResult } from './types.js';

/**
 * Characters illegal in XML 1.0 per section 2.2: U+0000-U+0008, U+000B, U+000C, U+000E-U+001F.
 * Tab (U+0009), newline (U+000A), and carriage return (U+000D) are the only control chars allowed.
 */
// eslint-disable-next-line no-control-regex -- intentional: these are the exact chars to strip
const XML_ILLEGAL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/**
 * Strip characters illegal in XML 1.0 then escape the five XML-significant characters. Without the
 * strip, ANSI colour codes in error output produce a document no parser will read — CI shows
 * nothing instead of showing the failure.
 */
function escapeXml(value: string): string {
  return value
    .replace(XML_ILLEGAL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** First line of text (for the attribute summary). Handles LF, CRLF, and bare CR. */
function firstLine(text: string): string {
  const match = /\r?\n|\r/.exec(text);
  return match === null ? text : text.slice(0, match.index);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function caseXml(r: SpecResult): string {
  const open =
    `  <${JUnit.CASE} ${JUnit.ATTR_NAME}="${escapeXml(r.name)}" ` +
    `${JUnit.ATTR_TIME}="${seconds(r.durationMs)}">`;
  if (r.status === TestStatus.FAIL) {
    const full = escapeXml(r.error ?? '');
    const summary = escapeXml(firstLine(r.error ?? ''));
    return (
      `${open}\n    <${JUnit.FAILURE} ${JUnit.ATTR_MESSAGE}="${summary}">` +
      `${full}</${JUnit.FAILURE}>\n  </${JUnit.CASE}>`
    );
  }
  if (r.status === TestStatus.SKIP) {
    const msg = escapeXml(r.skipReason ?? '');
    return `${open}\n    <${JUnit.SKIPPED} ${JUnit.ATTR_MESSAGE}="${msg}"></${JUnit.SKIPPED}>\n  </${JUnit.CASE}>`;
  }
  return `${open}</${JUnit.CASE}>`;
}

/** Render results as a single JUnit `<testsuite>` document (CI consumable). */
export function toJUnitXml(results: readonly SpecResult[], opts?: { suite?: string }): string {
  const suite = escapeXml(opts?.suite ?? DEFAULT_JUNIT_SUITE_NAME);
  const s = summarize(results);
  const header =
    `<${JUnit.SUITE} ${JUnit.ATTR_NAME}="${suite}" ` +
    `${JUnit.ATTR_TESTS}="${String(s.total)}" ` +
    `${JUnit.ATTR_FAILURES}="${String(s.failed)}" ` +
    `${JUnit.ATTR_SKIPPED}="${String(s.skipped)}">`;
  const body = results.map(caseXml).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${header}\n${body}\n</${JUnit.SUITE}>\n`;
}

/** Write the JUnit report through the injected filesystem seam (tests pass a fake adapter). */
export async function writeJUnit(
  fs: FileSystemPort,
  path: string,
  results: readonly SpecResult[],
  opts?: { suite?: string },
): Promise<void> {
  await fs.writeFile(path, toJUnitXml(results, opts));
}
