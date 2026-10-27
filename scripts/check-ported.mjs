// Some code is shared with the other Aktar apps and has to stay the same
// as theirs, or the plugin and the apps start naming files differently or
// stop reading each other's transfer links. This compares each shared piece
// with its source and fails on drift.
//
//   pnpm check:ported [path/to/source]
//
// The source folder comes from the argument or from `.ported-source` (one
// line, not committed); without either, the check is skipped. Only code is
// compared: comments and blank lines are ignored, and a few lines that had
// to change for Obsidian are listed below.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = join(import.meta.dirname, '..');
const configured = existsSync(join(root, '.ported-source')) ? readFileSync(join(root, '.ported-source'), 'utf8').trim() : '';
const source = process.argv[2] ?? (configured ? resolve(root, configured) : null);
if (!source || !existsSync(source)) {
  console.log('skipped: no source to compare with (see scripts/check-ported.mjs)');
  process.exit(0);
}

/** [plugin file, source file, the part to compare: [from, to in the plugin, to in the source (if different)]] */
const PORTED = [
  ['src/s3/sigv4.ts', 's3/sigv4.ts', ['export const UNSIGNED_PAYLOAD', null]],
  ['src/s3/xml.ts', 's3/xml.ts', ['function decodeEntities', null]],
  ['src/s3/endpoint.ts', 's3/endpoint.ts', ['export function parseEndpoint', '/** The host without']],
  ['src/core/publicUrl.ts', 'upload/publicUrl.ts', ['const PATH_ALLOWED', null]],
  ['src/core/contentType.ts', 'upload/contentType.ts', ['const MIME_TYPES', 'const TEXT_PREVIEW_EXTENSIONS']],
  ['src/core/shortKeys.ts', 'upload/shortKeys.ts', ['export function makeShortCode', 'export function shortCodeFromHash', 'export function usesShortCode']],
  ['src/core/shortKeys.ts', 'upload/shortKeys.ts', ['export const MAX_SHORT_KEY_ATTEMPTS', null]],
  ['src/core/transfer.ts', 'transfer/codec.ts', ['export function normalizeTransferCode', 'export function formatTransferCodeInput']],
  ['src/core/transfer.ts', 'transfer/codec.ts', ['export function base64urlToBytes', null]],
];

function code(text, [from, to]) {
  // Formatting may differ (line breaks, indentation); the code itself may not.
  let start = text.indexOf(from);
  if (start === -1) throw new Error(`"${from}" not found`);
  const end = to ? text.indexOf(to, start) : text.length;
  return text
    .slice(start, end === -1 ? text.length : end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    // Short keys: the plugin passes WebCrypto where the source uses its own random bytes.
    .map((line) => line.replace('randomBytes: (count: number) => Uint8Array = secureRandomBytes', 'randomBytes: (count: number) => Uint8Array = getRandomBytes'))
    .join('')
    .replace(/\s+/g, '')
    .replace(/,([)\]}])/g, '$1');
}

let failed = 0;
for (const [ours, theirs, part] of PORTED) {
  try {
    const a = code(readFileSync(join(import.meta.dirname, '..', ours), 'utf8'), [part[0], part[1]]);
    const b = code(readFileSync(join(source, theirs), 'utf8'), [part[0], part[2] === undefined ? part[1] : part[2]]);
    if (a === b) {
      console.log(`ok - ${ours} (${part[0]})`);
      continue;
    }
    failed++;
    let at = 0;
    while (at < a.length && a[at] === b[at]) at++;
    console.log(`not ok - ${ours} differs from ${theirs} (${part[0]})`);
    console.log(`  plugin: …${a.slice(Math.max(0, at - 30), at + 50)}\n  source: …${b.slice(Math.max(0, at - 30), at + 50)}`);
  } catch (error) {
    failed++;
    console.log(`not ok - ${ours}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
