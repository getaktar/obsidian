import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { after, before, test } from 'node:test';

import { AppClient, AppError, helloProof } from '../src/bridge/appClient.ts';
import { backupDue, backupKey, expiredBackups, excludedFromBackup, isBackupKey, storesWithoutCompression } from '../src/core/backupPlan.ts';
import { pageHTML } from '../src/features/publishTemplate.ts';
import { outputType, renamed, targetSize, wantsProcessing } from '../src/upload/imageProcessing.ts';
import { afterFailure, RETRY_DELAYS_MS } from '../src/upload/retryPolicy.ts';

// MARK: Backups

const random = (n: number) => new Uint8Array(n).map((_, i) => i * 7);

test('backup keys are dated, unguessable and recognized', () => {
  const key = backupKey('My Vault', new Date(2026, 9, 15, 9, 5, 7), random);
  assert.match(key, /^backups\/obsidian\/My Vault\/2026-10-15-090507-[0-9a-z]{20}\.zip$/);
  assert.equal(isBackupKey(key, 'My Vault'), true);
  assert.equal(isBackupKey('backups/obsidian/My Vault/notes.zip', 'My Vault'), false);
  assert.equal(isBackupKey(key, 'Other'), false);
});

test('only the newest backups are kept, and nothing else in the folder is touched', () => {
  const keys = ['2026-10-01', '2026-10-03', '2026-10-02', '2026-10-04'].map((d) => `backups/obsidian/V/${d}-000000-${'a'.repeat(20)}.zip`);
  keys.push('backups/obsidian/V/keep-me.txt');
  assert.deepEqual(
    expiredBackups(keys, 'V', 2).map((k) => k.slice(19, 29)),
    ['2026-10-01', '2026-10-02'],
  );
  assert.deepEqual(expiredBackups(keys, 'V', 0).length, 3, 'at least one is always kept');
});

test('backup schedule', () => {
  const day = 24 * 3600 * 1000;
  const now = Date.UTC(2026, 9, 15, 9);
  assert.equal(backupDue(null, 'daily', now), true);
  assert.equal(backupDue(now - day + 30 * 60 * 1000, 'daily', now), true, 'half an hour early is fine');
  assert.equal(backupDue(now - 3 * 3600 * 1000, 'daily', now), false);
  assert.equal(backupDue(now - 3 * day, 'weekly', now), false);
  assert.equal(backupDue(now - 7 * day, 'weekly', now), true);
});

test('what goes into a backup', () => {
  assert.equal(excludedFromBackup('.trash/a.md', '.obsidian'), true);
  assert.equal(excludedFromBackup('.obsidian/plugins/aktar/queue/x.bin', '.obsidian'), true);
  assert.equal(excludedFromBackup('Notes/a.md', '.obsidian'), false);
  assert.equal(storesWithoutCompression('a/b.JPG'), true);
  assert.equal(storesWithoutCompression('a/b.md'), false);
});

// MARK: Image processing

test('photos are scaled down, never up, and get a format the device can make', () => {
  assert.deepEqual(targetSize(4032, 3024, 1920), { width: 1920, height: 1440, scaled: true });
  assert.deepEqual(targetSize(800, 600, 1920), { width: 800, height: 600, scaled: false });
  assert.deepEqual(targetSize(4032, 3024, 0), { width: 4032, height: 3024, scaled: false });

  const webp = { format: 'webp' as const, maxEdge: 0, quality: 80 };
  const keep = { format: 'original' as const, maxEdge: 1920, quality: 80 };
  assert.equal(outputType('a.jpg', webp, true), 'image/webp');
  assert.equal(outputType('a.jpg', webp, false), 'image/jpeg', 'iOS can’t make WebP');
  assert.equal(outputType('a.png', webp, false), 'image/png', 'a PNG may be transparent');
  assert.equal(outputType('a.heic', keep, true), 'image/jpeg');
  assert.equal(outputType('a.webp', keep, true), 'image/webp');
  assert.equal(renamed('IMG_1.HEIC', 'image/jpeg'), 'IMG_1.jpg');

  assert.equal(wantsProcessing('a.gif', webp), false);
  assert.equal(wantsProcessing('a.svg', webp), false);
  assert.equal(wantsProcessing('a.jpg', { format: 'original', maxEdge: 0, quality: 80 }), false);
  assert.equal(wantsProcessing('a.jpg', webp), true);
});

// MARK: Upload retries

test('a lost connection is tried again soon, then later; bad keys wait to be asked', () => {
  assert.deepEqual(afterFailure(1, true), { retryIn: RETRY_DELAYS_MS[0] });
  assert.deepEqual(afterFailure(RETRY_DELAYS_MS.length, true), { retryIn: RETRY_DELAYS_MS.at(-1) });
  assert.deepEqual(afterFailure(RETRY_DELAYS_MS.length + 1, true), { resumable: true }, 'out of quick tries, but it goes again on the next start or round');
  assert.deepEqual(afterFailure(1, false), { resumable: false });
});

// MARK: Publishing

test('a published page can run no script and escapes its title', () => {
  const html = pageHTML({ title: '<script>x</script> & notes', body: '<p>Hi</p>', date: new Date(Date.UTC(2026, 9, 15)), lang: 'tr' });
  assert.match(html, /Content-Security-Policy" content="default-src 'none';/);
  assert.doesNotMatch(html, /script-src/);
  assert.match(html, /<title>&lt;script&gt;x&lt;\/script&gt; &amp; notes<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<html lang="tr">/);
});

// MARK: Aktar app bridge

const TOKEN = 'ab'.repeat(32);
let server: ReturnType<typeof createServer>;
let port = 0;
let impostor: ReturnType<typeof createServer>;
let impostorPort = 0;
const seenTokens: string[] = [];

function body(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

before(async () => {
  // A stand-in for the app's local API: the hello proof, one destination, uploads into a folder.
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/hello') {
      res.end(JSON.stringify({ app: 'Aktar', proof: helloProof(TOKEN, url.searchParams.get('nonce') ?? '') }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized.' }));
      return;
    }
    if (url.pathname === '/v1/status') return res.end(JSON.stringify({ app: 'Aktar', version: '0.18.0', apiVersion: 1, defaultDestinationId: 'D1' }));
    if (url.pathname === '/v1/destinations') {
      return res.end(JSON.stringify({ destinations: [{ id: 'D1', name: 'Files', provider: 'cloudflareR2', providerName: 'Cloudflare R2', bucket: 'b', publicBaseURL: 'https://f.example.com', isDefault: true }] }));
    }
    if (url.pathname === '/v1/uploads' && req.method === 'POST') {
      const data = await body(req);
      const prefix = url.searchParams.get('prefix') === '/' ? '' : (url.searchParams.get('prefix') ?? '');
      const key = `${prefix}${url.searchParams.get('filename')}`;
      res.statusCode = 201;
      return res.end(JSON.stringify({ upload: { id: 'U1', filename: url.searchParams.get('filename'), objectKey: key, url: `https://f.example.com/${key}`, destinationId: 'D1', size: data.length } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  // Something else on a port, which can't prove it has the token.
  impostor = createServer(async (req, res) => {
    if (req.headers.authorization) seenTokens.push(req.headers.authorization);
    res.end(JSON.stringify({ app: 'Aktar', proof: '0'.repeat(64) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => impostor.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  impostorPort = (impostor.address() as { port: number }).port;
});

after(() => {
  server.close();
  impostor.close();
});

const nodeHttp = { request: httpRequest } as unknown as ConstructorParameters<typeof AppClient>[1];

test('the bridge talks to the app once it has proved itself', async () => {
  const client = new AppClient({ token: TOKEN, port }, nodeHttp);
  assert.equal((await client.status()).version, '0.18.0');
  assert.equal((await client.destinations())[0].name, 'Files');
  const upload = await client.upload('D1', 'obsidian/V/', 'a.png', new Uint8Array([1, 2, 3]).buffer);
  assert.equal(upload.objectKey, 'obsidian/V/a.png');
  assert.equal(upload.size, 3);
  const root = await client.upload('D1', '', 'b.png', new Uint8Array([1]).buffer);
  assert.equal(root.objectKey, 'b.png');
});

test('an app that can’t prove it has the token never gets it', async () => {
  const client = new AppClient({ token: TOKEN, port: impostorPort }, nodeHttp);
  await assert.rejects(client.status(), (error: unknown) => error instanceof AppError && error.kind === 'unverified');
  assert.deepEqual(seenTokens, []);
});

test('nothing listening is "not running"', async () => {
  const client = new AppClient({ token: TOKEN, port: 1 }, nodeHttp);
  await assert.rejects(client.status(), (error: unknown) => error instanceof AppError && error.kind === 'notRunning');
});

test('a wrong token is unauthorized', async () => {
  // The proof is made with the client's token, so this server proves a different one: unverified, not sent.
  const client = new AppClient({ token: 'cd'.repeat(32), port }, nodeHttp);
  await assert.rejects(client.status(), (error: unknown) => error instanceof AppError && error.kind === 'unverified');
});
