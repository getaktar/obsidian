import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripLocation } from '../src/core/exif.ts';
import {
  applyReplacements,
  findLocalReferences,
  findPlaceholder,
  findRemoteLinks,
  linkMatcher,
  placeholderMarkup,
  remoteMarkup,
  splitSize,
} from '../src/core/links.ts';
import { DEFAULT_KEY_TEMPLATE, generateObjectKey, templatePrefix } from '../src/core/objectKey.ts';
import { shortCodeFromHash, SHORT_CODE_ALPHABET } from '../src/core/shortKeys.ts';
import { openTransfer, TransferError } from '../src/core/transfer.ts';
import { presignUrl } from '../src/s3/sigv4.ts';
import { CODE, FULL, MINIMAL, NEWER_PAYLOAD, NEWER_VERSION } from './transferVectors.ts';

// MARK: SigV4

test('presigned URL matches the AWS documentation example', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const url = presignUrl(
    { method: 'GET', scheme: 'https', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt' },
    { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
    'us-east-1',
    86400,
    new Date('2013-05-24T00:00:00Z'),
  );
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

// MARK: Transfer

test('shared transfer vectors open with the code', async () => {
  const full = await openTransfer(FULL, CODE);
  assert.equal(full.destination.name, 'Screenshots');
  assert.equal(full.destination.id, '6F9619FF-8B86-D011-B42D-00C04FC964FF');
  assert.equal(full.destination.preset, 'cloudflareR2');
  assert.equal(full.destination.bucket, 'shots');
  assert.equal(full.destination.publicBaseURL, 'https://files.example.com');
  assert.deepEqual(full.credentials, { accessKeyId: 'EXAMPLEACCESSKEYID000', secretAccessKey: 'example-secret-not-real-0000000000000000' });

  const minimal = await openTransfer(MINIMAL, 'k7p2 qx9m 4trw');
  assert.equal(minimal.destination.preset, 'minIO');
  assert.equal(minimal.destination.forcePathStyle, true);
  assert.equal(minimal.destination.objectPathTemplate, '{uuid}.{ext}');
  assert.equal(minimal.destination.region, 'us-east-1');
});

test('transfer errors', async () => {
  const kind = (k: string) => (error: unknown) => error instanceof TransferError && error.kind === k;
  await assert.rejects(openTransfer(FULL, 'K7P2QX9M4TRX'), kind('wrongCode'));
  await assert.rejects(openTransfer(FULL, 'K7P2-QX9M'), kind('wrongCode'));
  await assert.rejects(openTransfer(NEWER_VERSION, CODE), kind('newerVersion'));
  await assert.rejects(openTransfer(NEWER_PAYLOAD, CODE), kind('newerVersion'));
  await assert.rejects(openTransfer('https://example.com', CODE), kind('notAktar'));
});

// MARK: Keys

test('keys fill the vault variables and never leave empty segments', () => {
  const date = new Date(2026, 9, 15, 9, 5, 7);
  const vault = { vault: 'My Vault', note: 'Trip / Day 1', noteFolder: 'Journal/2026' };
  assert.equal(
    generateObjectKey(DEFAULT_KEY_TEMPLATE, 'IMG 1.JPG', { date, vault, shortCode: () => 'aB3xK9q' }),
    'obsidian/My Vault/2026/10/aB3xK9q.jpg',
  );
  assert.equal(generateObjectKey('{noteFolder}/{note}-{filename}.{ext}', 'a.png', { date, vault }), 'Journal/2026/Trip  Day 1-a.png');
  assert.equal(generateObjectKey('x/{noteFolder}/{filename}.{ext}', 'a.png', { date, vault: { ...vault, noteFolder: '' } }), 'x/a.png');
  assert.equal(generateObjectKey('{filename}.{ext}', 'README', { date }), 'README');
});

test('a hash gives the same {short} every time', () => {
  const hash = 'ff00aa5512c4e0b7d3f1a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e3f5a7b9c1d3';
  const first = generateObjectKey('{short}.{ext}', 'a.png', { sha256: hash });
  assert.equal(first, generateObjectKey('{short}.{ext}', 'a.png', { sha256: hash }));
  assert.equal(shortCodeFromHash(hash).length, 7);
  assert.ok([...shortCodeFromHash(hash)].every((c) => SHORT_CODE_ALPHABET.includes(c)));
});

test('template prefix is the fixed folder part', () => {
  const vault = { vault: 'Notes', note: '', noteFolder: '' };
  assert.equal(templatePrefix(DEFAULT_KEY_TEMPLATE, vault), 'obsidian/Notes/');
  assert.equal(templatePrefix('{year}/{short}.{ext}', vault), '');
});

// MARK: Links

test('local references: wiki and markdown, size and caption, code left alone', () => {
  const text = [
    '---',
    'cover: "[[cover.png]]"',
    '---',
    'Look ![[photo one.png|300]] and [[report.pdf|the report]].',
    '![A cat|200x100](assets/cat%20face.jpg) [[Other note]] [x](https://e.com/a.png)',
    '`![[inline.png]]`',
    '```',
    '![[fenced.png]]',
    '```',
    '![[after.gif]]',
  ].join('\n');
  const refs = findLocalReferences(text);
  assert.deepEqual(
    refs.map((r) => [r.linkpath, r.embed, r.style, r.size, r.caption]),
    [
      ['photo one.png', true, 'wiki', '300', null],
      ['report.pdf', false, 'wiki', null, 'the report'],
      ['assets/cat face.jpg', true, 'markdown', '200x100', 'A cat'],
      ['after.gif', true, 'wiki', null, null],
    ],
  );
});

test('remote links: markdown and bare, matched by base URL', () => {
  const matchers = [linkMatcher('d1', 'files.example.com/')!];
  const text = 'a ![cap|300](https://files.example.com/obsidian/V/a%20b.png) b https://files.example.com/x/doc.pdf. c https://other.com/z.png';
  const links = findRemoteLinks(text, matchers);
  assert.deepEqual(
    links.map((l) => [l.key, l.embed, l.style, l.size, l.caption]),
    [
      ['obsidian/V/a b.png', true, 'markdown', '300', 'cap'],
      ['x/doc.pdf', false, 'bare', null, null],
    ],
  );
  assert.equal(text.slice(links[1].start, links[1].end), 'https://files.example.com/x/doc.pdf');
});

test('remote markup keeps caption and size, links non-media', () => {
  assert.equal(remoteMarkup('https://f.co/a.png', 'a.png', { size: '300' }), '![300](https://f.co/a.png)');
  assert.equal(remoteMarkup('https://f.co/a.png', 'a.png', { caption: 'Cat [1]', size: '300' }), '![Cat \\[1\\]|300](https://f.co/a.png)');
  assert.equal(remoteMarkup('https://f.co/a.mp4', 'a.mp4'), '![](https://f.co/a.mp4)');
  assert.equal(remoteMarkup('https://f.co/r(1).pdf', 'r(1).pdf'), '[r(1).pdf](<https://f.co/r(1).pdf>)');
  assert.equal(remoteMarkup('https://f.co/a.png', 'a.png', { embed: false, caption: 'see' }), '[see](https://f.co/a.png)');
});

test('placeholders are found by ID and replaced', () => {
  const id = 'k3j2-1';
  const text = `before ${placeholderMarkup(id, 'shot [1].png', 'Uploading')} after`;
  const range = findPlaceholder(text, id)!;
  assert.equal(applyReplacements(text, [{ ...range, text: '![](u)' }]), 'before ![](u) after');
  assert.equal(findPlaceholder(text, 'other'), null);
});

test('splitSize', () => {
  assert.deepEqual(splitSize('300'), { caption: null, size: '300' });
  assert.deepEqual(splitSize('a|b'), { caption: 'a|b', size: null });
  assert.deepEqual(splitSize(''), { caption: null, size: null });
});

// MARK: EXIF

/** A minimal JPEG: SOI, an APP1 EXIF block with IFD0 (Orientation, GPS pointer) and a GPS IFD, then EOI. */
function jpegWithGPS(): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push(v & 0xff, v >> 8);
  const u32 = (v: number) => tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24);
  tiff.push(0x49, 0x49); // "II"
  u16(42);
  u32(8);
  // IFD0 at 8: 2 entries.
  u16(2);
  u16(0x0112); u16(3); u32(1); u32(6); // Orientation = 6
  u16(0x8825); u16(4); u32(1); u32(38); // GPS IFD at 38
  u32(0);
  // GPS IFD at 38: 1 entry, latitude (3 rationals = 24 bytes) at 56.
  u16(1);
  u16(0x0002); u16(5); u32(3); u32(56);
  u32(0);
  for (let i = 0; i < 24; i++) tiff.push(0xab);
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = body.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...body, 0xff, 0xd9]);
}

test('location is removed from a JPEG, orientation stays', () => {
  const input = jpegWithGPS();
  const { data, removed } = stripLocation(input.buffer as ArrayBuffer);
  assert.equal(removed, true);
  const out = new Uint8Array(data);
  assert.equal(out.length, input.length);
  assert.ok(!out.includes(0xab), 'latitude bytes are zeroed');
  const tiffStart = 12;
  assert.equal(out[tiffStart + 8 + 2 + 8], 6, 'orientation value kept');
  assert.equal(out[tiffStart + 38] | (out[tiffStart + 39] << 8), 0, 'GPS IFD is empty');
});

test('files without location are returned as they are', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  assert.equal(stripLocation(png.buffer).removed, false);
  assert.equal(stripLocation(new Uint8Array([1, 2, 3]).buffer).removed, false);
});
