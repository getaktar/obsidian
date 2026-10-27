import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { TR } from '../src/core/locales/tr.ts';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );
}

/** Every string passed to t() or plural() in the source. */
function keys(): string[] {
  const found = new Set<string>(['1 hour', '1 day', '7 days']);
  const pattern = /\b(?:t|plural)\(\s*(?:[^'"()]*?,\s*)?'((?:[^'\\]|\\.)*)'(?:\s*,\s*'((?:[^'\\]|\\.)*)')?/g;
  for (const file of sources('src')) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      if (match[1]) found.add(match[1]);
      if (match[2]) found.add(match[2]);
    }
  }
  return [...found];
}

test('every string has a Turkish translation', () => {
  const missing = keys().filter((key) => !(key in TR));
  assert.deepEqual(missing, []);
});

test('translations keep their placeholders', () => {
  for (const [key, value] of Object.entries(TR)) {
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
});

test('no em or en dashes in user-facing text', () => {
  for (const file of [...sources('src'), 'README.md', 'styles.css']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /[–—]/, file);
  }
});
