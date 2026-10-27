/**
 * The S3 client and the uploader against a real S3 server: a throwaway
 * MinIO on a free port, when the `minio` binary is installed (otherwise
 * skipped). Run with `pnpm test`.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { DestinationConfig, StorageCredentials } from '../src/core/types.ts';
import { MULTIPART_THRESHOLD, S3Client, type HttpClient } from '../src/s3/client.ts';
import { signRequest, EMPTY_PAYLOAD_HASH } from '../src/s3/sigv4.ts';
import { uploadFile } from '../src/upload/uploader.ts';

const hasMinio = spawnSync('which', ['minio']).status === 0;
const credentials: StorageCredentials = { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };

const fetchHttp: HttpClient = async (request) => {
  const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
  const arrayBuffer = await response.arrayBuffer();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  return { status: response.status, headers, text: new TextDecoder().decode(arrayBuffer), arrayBuffer };
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

let minio: ChildProcess | null = null;
let dataDir = '';
let destination: DestinationConfig;
let client: S3Client;

before(async () => {
  if (!hasMinio) return;
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'aktar-minio-'));
  minio = spawn('minio', ['server', dataDir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${await freePort()}`, '--quiet'], {
    env: { ...process.env, MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' },
    stdio: 'ignore',
  });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${endpoint}/minio/health/live`)).ok) break;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  destination = {
    id: 'TEST',
    name: 'Test',
    preset: 'minIO',
    endpoint,
    region: 'us-east-1',
    bucket: 'notes',
    publicBaseURL: `${endpoint}/notes`,
    objectPathTemplate: '{short}.{ext}',
    forcePathStyle: true,
  };
  const headers = signRequest({ method: 'PUT', host: `127.0.0.1:${port}`, path: '/notes', query: [], headers: {}, payloadHash: EMPTY_PAYLOAD_HASH }, credentials, 'us-east-1');
  const created = await fetch(`${endpoint}/notes`, { method: 'PUT', headers });
  assert.ok(created.ok, `bucket created (${created.status})`);
  client = new S3Client(destination, credentials, fetchHttp);
});

after(() => {
  minio?.kill();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const bytes = (size: number, seed = 1) => {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + seed) & 0xff;
  return data.buffer;
};

test('connection test, upload, info, download, list, move, delete', { skip: !hasMinio }, async () => {
  const result = await client.testConnection();
  assert.equal(result.writable, true);

  await client.upload('a/b c.txt', new TextEncoder().encode('hello').buffer as ArrayBuffer, { contentType: 'text/plain' });
  assert.deepEqual((await client.objectInfo('a/b c.txt'))?.size, 5);
  assert.equal(new TextDecoder().decode((await client.download('a/b c.txt'))!), 'hello');
  assert.equal(await client.download('a/missing.txt'), null);

  const listing = await client.list('');
  assert.deepEqual(listing.folders, ['a/']);
  assert.deepEqual((await client.list('a/')).objects.map((o) => o.key), ['a/b c.txt']);

  await client.move('a/b c.txt', 'a/moved.txt');
  assert.equal(await client.objectExists('a/b c.txt'), false);
  assert.equal(await client.objectExists('a/moved.txt'), true);

  // The public URL and a presigned one reach the same object.
  const signed = client.temporaryURL('a/moved.txt', 60);
  assert.equal(await (await fetch(signed)).text(), 'hello');

  await client.delete('a/moved.txt');
  assert.equal(await client.objectExists('a/moved.txt'), false);
});

test('a large file goes up in parts', { skip: !hasMinio }, async () => {
  const data = bytes(MULTIPART_THRESHOLD + 1234, 7);
  const progress: number[] = [];
  await client.upload('big.bin', data, { contentType: 'application/octet-stream', onProgress: (f) => progress.push(f) });
  const back = new Uint8Array((await client.download('big.bin'))!);
  assert.equal(back.length, data.byteLength);
  assert.deepEqual(back.subarray(MULTIPART_THRESHOLD, MULTIPART_THRESHOLD + 50), new Uint8Array(data).subarray(MULTIPART_THRESHOLD, MULTIPART_THRESHOLD + 50));
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.length >= 3);
});

test('uploader: vault template, stable keys reuse the object, collisions get a new name', { skip: !hasMinio }, async () => {
  const vault = { vault: 'Test Vault', note: 'Day', noteFolder: 'Journal' };
  const data = bytes(2048, 3);
  const first = await uploadFile({ data, filename: 'Photo.PNG', destination, client, template: 'obsidian/{vault}/{short}.{ext}', vault, removeLocation: true });
  assert.match(first.key, /^obsidian\/Test Vault\/[0-9A-Za-z]{7}\.png$/);
  assert.equal(first.url, `${destination.publicBaseURL}/obsidian/Test%20Vault/${first.key.split('/').pop()}`);
  assert.equal(await (await fetch(first.url)).status, 403, 'MinIO buckets are private by default');

  const date = new Date(2024, 0, 2);
  const stableA = await uploadFile({ data, filename: 'x.png', destination, client, template: '{year}/{short}.{ext}', vault, removeLocation: false, stable: true, date });
  const stableB = await uploadFile({ data, filename: 'x.png', destination, client, template: '{year}/{short}.{ext}', vault, removeLocation: false, stable: true, date });
  assert.equal(stableA.key, stableB.key);
  assert.equal(stableA.reused, false);
  assert.equal(stableB.reused, true);

  const one = await uploadFile({ data, filename: 'same.txt', destination, client, template: 'named/{filename}.{ext}', vault, removeLocation: false });
  const two = await uploadFile({ data: bytes(10), filename: 'same.txt', destination, client, template: 'named/{filename}.{ext}', vault, removeLocation: false });
  assert.equal(one.key, 'named/same.txt');
  assert.equal(two.key, 'named/same 2.txt');
});

test('errors map to what the user can act on', { skip: !hasMinio }, async () => {
  const wrongKeys = new S3Client(destination, { accessKeyId: 'minioadmin', secretAccessKey: 'wrong-secret' }, fetchHttp);
  await assert.rejects(wrongKeys.list(''), (error: Error & { detail?: { kind: string } }) => error.detail?.kind === 'invalidCredentials');
  const noBucket = new S3Client({ ...destination, bucket: 'missing' }, credentials, fetchHttp);
  await assert.rejects(noBucket.testConnection(), (error: Error & { detail?: { kind: string } }) => error.detail?.kind === 'bucketNotFound');
});

test('processed photos keep stable keys made from the original, and the converted name', { skip: !hasMinio }, async () => {
  const vault = { vault: 'V', note: 'n', noteFolder: '' };
  const original = bytes(4096, 9);
  // Processing that differs between runs, as encoders do between devices.
  let run = 0;
  const processImage = async (_data: ArrayBuffer, filename: string) => ({ data: bytes(100 + run++, 5), filename: filename.replace(/\.jpg$/, '.webp') });
  const date = new Date(2025, 5, 1);
  const a = await uploadFile({ data: original, filename: 'p.jpg', destination, client, template: 'm/{short}.{ext}', vault, removeLocation: true, processImage, stable: true, date });
  const b = await uploadFile({ data: original, filename: 'p.jpg', destination, client, template: 'm/{short}.{ext}', vault, removeLocation: true, processImage, stable: true, date });
  assert.match(a.key, /^m\/[0-9A-Za-z]{7}\.webp$/);
  assert.equal(a.filename, 'p.webp');
  assert.equal(b.key, a.key);
  assert.equal(b.reused, true);
  assert.equal((await client.objectInfo(a.key))?.size, 100);
});

test('a page uploaded inline is served to be read, not downloaded', { skip: !hasMinio }, async () => {
  const html = new TextEncoder().encode('<!doctype html><p>hi</p>').buffer as ArrayBuffer;
  await client.upload('pub/page.html', html, { contentType: 'text/html; charset=utf-8', inline: true });
  await client.upload('pub/other.html', html, { contentType: 'text/html; charset=utf-8' });
  const inline = await fetch(client.temporaryURL('pub/page.html', 60));
  const download = await fetch(client.temporaryURL('pub/other.html', 60));
  assert.equal(inline.headers.get('content-disposition'), null);
  assert.equal(download.headers.get('content-disposition'), 'attachment');
});
