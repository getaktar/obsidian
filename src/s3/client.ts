import { attachmentHeaders } from '../core/contentType.ts';
import { t } from '../core/i18n.ts';
import { resolvePublicURL } from '../core/publicUrl.ts';
import {
  StorageError,
  type BucketListing,
  type BucketObject,
  type ConnectionResult,
  type DestinationConfig,
  type PublicLinkCheck,
  type StorageCredentials,
} from '../core/types.ts';
import type { Storage, UploadOptions } from '../storage.ts';
import { parseEndpoint, type ParsedEndpoint } from './endpoint.ts';
import { EMPTY_PAYLOAD_HASH, encodeKeyPath, encodeRfc3986, presignUrl, sha256Hex, signRequest, UNSIGNED_PAYLOAD } from './sigv4.ts';
import { xmlBlocks, xmlValue, xmlValues } from './xml.ts';

/**
 * The one HTTP call the client needs. In Obsidian it's `requestUrl`, which
 * isn't bound by CORS (buckets rarely allow it) and works the same on
 * desktop and mobile; tests pass their own.
 */
export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer | string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

const REQUEST_TIMEOUT_MS = 60_000;
/** A single PUT gets more time per byte than a listing. */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;
const IF_NONE_MATCH = { 'If-None-Match': '*' };
export const SHORT_CACHE_CONTROL = 'public, max-age=60';

/** Files from this size on go up in parts, so a dropped connection costs one part, not the file. */
export const MULTIPART_THRESHOLD = 32 * 1024 * 1024;
export const PART_SIZE = 16 * 1024 * 1024;
const PART_ATTEMPTS = 4;

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : headers[key];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * S3-compatible storage adapter: every provider (AWS S3, Cloudflare R2,
 * MinIO, Backblaze B2, DigitalOcean Spaces, custom) through one SigV4
 * client, the same as in the other Aktar apps.
 */
export class S3Client implements Storage {
  readonly kind = 's3';
  private readonly config: DestinationConfig;
  private readonly credentials: StorageCredentials;
  private readonly http: HttpClient;
  private readonly endpoint: ParsedEndpoint | null;

  constructor(config: DestinationConfig, credentials: StorageCredentials, http: HttpClient) {
    this.config = config;
    this.credentials = credentials;
    this.http = http;
    this.endpoint = parseEndpoint(config.endpoint);
  }

  // MARK: Addressing

  private target(key: string | null): { scheme: string; host: string; path: string } {
    const endpoint = this.endpoint;
    if (!endpoint) throw new StorageError({ kind: 'unknown', message: t('The endpoint URL is not valid.') });
    const encodedKey = key === null ? '' : encodeKeyPath(key);
    if (this.config.forcePathStyle) {
      const path = `${endpoint.basePath}/${this.config.bucket}${key === null ? '' : '/' + encodedKey}`;
      return { scheme: endpoint.scheme, host: endpoint.host, path };
    }
    return { scheme: endpoint.scheme, host: `${this.config.bucket}.${endpoint.host}`, path: `${endpoint.basePath}/${encodedKey}` };
  }

  private buildURL(target: { scheme: string; host: string; path: string }, query: [string, string][]): string {
    const qs = query.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
    return `${target.scheme}://${target.host}${target.path}${qs ? '?' + qs : ''}`;
  }

  /** A signed request. `body` bytes are sent with an unsigned payload, strings are hashed. */
  private async send(
    method: string,
    options: { key?: string | null; query?: [string, string][]; headers?: Record<string, string>; body?: string | ArrayBuffer; timeoutMs?: number } = {},
  ): Promise<HttpResponse> {
    const target = this.target(options.key ?? null);
    const query = options.query ?? [];
    const payloadHash =
      options.body === undefined ? EMPTY_PAYLOAD_HASH : typeof options.body === 'string' ? sha256Hex(options.body) : UNSIGNED_PAYLOAD;
    const headers = signRequest(
      { method, host: target.host, path: target.path, query, headers: options.headers ?? {}, payloadHash },
      this.credentials,
      this.config.region,
    );
    let timer: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new StorageError({ kind: 'network', message: t('The storage provider didn’t answer in time.') })),
        options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([this.http({ url: this.buildURL(target, query), method, headers, body: options.body }), timeout]);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // requestUrl rejects only when no HTTP answer came back at all.
      throw new StorageError({ kind: 'network', message: error instanceof Error ? error.message : String(error) });
    } finally {
      window.clearTimeout(timer);
    }
  }

  private fail(response: HttpResponse): never {
    throw S3Client.mapError(response.status, response.text, this.config.bucket);
  }

  private static ok(response: HttpResponse): boolean {
    return response.status >= 200 && response.status < 300;
  }

  publicURL(key: string): string {
    return resolvePublicURL(this.config.publicBaseURL, key);
  }

  // MARK: Operations

  async testConnection(): Promise<ConnectionResult> {
    const head = await this.send('HEAD');
    if (!S3Client.ok(head)) {
      if (head.status === 404) throw new StorageError({ kind: 'bucketNotFound', bucket: this.config.bucket });
      this.fail(head);
    }
    const testKey = `_aktar_test_${crypto.randomUUID().slice(0, 8).toUpperCase()}.txt`;
    let writable = false;
    try {
      const put = await this.send('PUT', { key: testKey, body: 'aktar connection test', headers: { 'Content-Type': 'text/plain' } });
      writable = S3Client.ok(put);
    } catch {
      writable = false;
    }
    let publicLink: PublicLinkCheck | null = null;
    if (writable && this.config.publicBaseURL.trim() && !this.config.private) {
      publicLink = await this.probe(this.publicURL(testKey));
    }
    if (writable) await this.send('DELETE', { key: testKey }).catch(() => undefined);
    return { bucketReachable: true, writable, publicLink };
  }

  private async probe(url: string): Promise<PublicLinkCheck> {
    try {
      let response = await this.http({ url, method: 'HEAD', headers: {} });
      if (response.status === 405 || response.status === 501) response = await this.http({ url, method: 'GET', headers: {} });
      return S3Client.ok(response) ? { kind: 'reachable' } : { kind: 'status', status: response.status };
    } catch {
      return { kind: 'noResponse' };
    }
  }

  private objectHeaders(key: string, contentType: string, inline = false): Record<string, string> {
    return {
      'Content-Type': contentType,
      ...(inline ? {} : attachmentHeaders(key, contentType)),
      ...(this.config.shortCache ? { 'Cache-Control': SHORT_CACHE_CONTROL } : {}),
    };
  }

  /**
   * Uploads the bytes to `key`, in parts from `MULTIPART_THRESHOLD` on.
   * `ifNoneMatch` only writes a key that isn't taken and fails with
   * `alreadyExists` otherwise.
   */
  async upload(key: string, data: ArrayBuffer, options: UploadOptions): Promise<string> {
    if (data.byteLength >= MULTIPART_THRESHOLD) {
      await this.uploadInParts(key, data, options);
      return key;
    }
    options.onProgress?.(0);
    const response = await this.send('PUT', {
      key,
      body: data,
      headers: { ...this.objectHeaders(key, options.contentType, options.inline), ...(options.ifNoneMatch ? IF_NONE_MATCH : {}) },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (!S3Client.ok(response)) this.fail(response);
    options.onProgress?.(1);
    return key;
  }

  private async uploadInParts(key: string, data: ArrayBuffer, options: UploadOptions): Promise<void> {
    const created = await this.send('POST', {
      key,
      query: [['uploads', '']],
      body: '',
      headers: this.objectHeaders(key, options.contentType, options.inline),
    });
    if (!S3Client.ok(created)) this.fail(created);
    const uploadId = xmlValue(created.text, 'UploadId');
    if (!uploadId) throw new StorageError({ kind: 'unknown', message: 'CreateMultipartUpload: no UploadId' });

    const parts: { partNumber: number; etag: string }[] = [];
    const count = Math.ceil(data.byteLength / PART_SIZE);
    try {
      for (let index = 0; index < count; index++) {
        const partNumber = index + 1;
        const chunk = data.slice(index * PART_SIZE, Math.min(data.byteLength, (index + 1) * PART_SIZE));
        parts.push({ partNumber, etag: await this.uploadPart(key, uploadId, partNumber, chunk) });
        options.onProgress?.(partNumber / count);
      }
      await this.completeMultipartUpload(key, uploadId, parts, options.ifNoneMatch ?? false);
    } catch (error) {
      await this.send('DELETE', { key, query: [['uploadId', uploadId]] }).catch(() => undefined);
      throw error;
    }
  }

  private async uploadPart(key: string, uploadId: string, partNumber: number, chunk: ArrayBuffer): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PART_ATTEMPTS; attempt++) {
      try {
        const response = await this.send('PUT', {
          key,
          query: [
            ['partNumber', String(partNumber)],
            ['uploadId', uploadId],
          ],
          body: chunk,
          timeoutMs: UPLOAD_TIMEOUT_MS,
        });
        // A 5xx maps to a network error, the server having a moment, and is tried again.
        if (!S3Client.ok(response)) this.fail(response);
        const etag = headerValue(response.headers, 'ETag');
        if (!etag) throw new StorageError({ kind: 'network', message: t('The provider didn’t confirm part {0}.', partNumber) });
        return etag;
      } catch (error) {
        lastError = error;
        const retryable = error instanceof StorageError && error.isTransient;
        if (!retryable || attempt === PART_ATTEMPTS) throw error;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
    throw lastError;
  }

  private async completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[], ifNoneMatch: boolean): Promise<void> {
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body =
      '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${escape(part.etag)}</ETag></Part>`).join('') +
      '</CompleteMultipartUpload>';
    const response = await this.send('POST', {
      key,
      query: [['uploadId', uploadId]],
      body,
      headers: { 'Content-Type': 'application/xml', ...(ifNoneMatch ? IF_NONE_MATCH : {}) },
      timeoutMs: 5 * 60_000,
    });
    if (!S3Client.ok(response)) this.fail(response);
    // A failure can arrive inside a 200 response.
    if (response.text.includes('<Error>')) throw S3Client.mapError(500, response.text, this.config.bucket);
  }

  /** The object's bytes, or null when it isn't there. */
  async download(key: string): Promise<ArrayBuffer | null> {
    const response = await this.send('GET', { key, timeoutMs: UPLOAD_TIMEOUT_MS });
    if (response.status === 404) return null;
    if (!S3Client.ok(response)) this.fail(response);
    return response.arrayBuffer;
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', { key });
    if (!S3Client.ok(response) && response.status !== 404) this.fail(response);
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.objectInfo(key)) !== null;
  }

  /** Size and last write of exactly `key`, by listing (HEAD answers vary between providers). */
  async objectInfo(key: string): Promise<{ size: number; lastModified: number | null } | null> {
    const listing = await this.listPage(key, null, null, { maxKeys: 1, keepPrefix: true });
    const object = listing.objects[0];
    return object && object.key === key ? { size: object.size, lastModified: object.lastModified } : null;
  }

  /** S3 has no rename: a server-side copy, then the original is deleted. */
  async move(sourceKey: string, destinationKey: string): Promise<void> {
    const response = await this.send('PUT', {
      key: destinationKey,
      body: '',
      headers: { 'x-amz-copy-source': `${this.config.bucket}/${encodeKeyPath(sourceKey)}` },
    });
    if (!S3Client.ok(response)) this.fail(response);
    if (response.text.includes('<Error>')) throw S3Client.mapError(500, response.text, this.config.bucket);
    await this.delete(sourceKey);
  }

  /** One level: the folders and the objects directly under `prefix`. */
  list(prefix: string, continuationToken: string | null = null): Promise<BucketListing> {
    return this.listPage(prefix, continuationToken, '/');
  }

  /** Every key under `prefix`, however deep, one page at a time. */
  listRecursively(prefix: string, continuationToken: string | null = null): Promise<BucketListing> {
    return this.listPage(prefix, continuationToken, null);
  }

  /** All keys under `prefix`, following every page. */
  async listAll(prefix: string, onPage?: (count: number) => void): Promise<BucketObject[]> {
    const objects: BucketObject[] = [];
    let token: string | null = null;
    do {
      const page = await this.listRecursively(prefix, token);
      objects.push(...page.objects);
      onPage?.(objects.length);
      token = page.nextContinuationToken;
    } while (token);
    return objects;
  }

  /**
   * One ListObjectsV2 page. The prefix itself is left out (it's the folder
   * being listed) unless `keepPrefix`, for looking up exactly one key.
   */
  private async listPage(
    prefix: string,
    continuationToken: string | null,
    delimiter: string | null,
    options: { maxKeys?: number; keepPrefix?: boolean } = {},
  ): Promise<BucketListing> {
    const query: [string, string][] = [
      ['list-type', '2'],
      ['max-keys', String(options.maxKeys ?? 1000)],
    ];
    if (delimiter) query.push(['delimiter', delimiter]);
    if (prefix) query.push(['prefix', prefix]);
    if (continuationToken) query.push(['continuation-token', continuationToken]);
    const response = await this.send('GET', { query });
    if (!S3Client.ok(response)) this.fail(response);
    const xml = response.text;
    const folders = xmlBlocks(xml, 'CommonPrefixes').flatMap((block) => xmlValues(block, 'Prefix'));
    const objects: BucketObject[] = [];
    for (const block of xmlBlocks(xml, 'Contents')) {
      const key = xmlValue(block, 'Key');
      if (!key || (key === prefix && !options.keepPrefix)) continue;
      if (key.endsWith('/')) {
        if (!delimiter) folders.push(key);
        continue;
      }
      const parsed = Date.parse(xmlValue(block, 'LastModified') ?? '');
      objects.push({ key, size: Number(xmlValue(block, 'Size') ?? 0), lastModified: Number.isNaN(parsed) ? null : parsed });
    }
    const truncated = xmlValue(xml, 'IsTruncated') === 'true';
    return { prefix, folders, objects, nextContinuationToken: truncated ? (xmlValue(xml, 'NextContinuationToken') ?? null) : null };
  }

  /** A presigned GET URL: works for private buckets, computed here without a request. */
  temporaryURL(key: string, expiresInSeconds: number, date: Date = new Date()): string {
    const target = this.target(key);
    return presignUrl({ method: 'GET', ...target }, this.credentials, this.config.region, expiresInSeconds, date);
  }

  async temporaryLink(key: string, seconds: number): Promise<string> {
    return this.temporaryURL(key, Math.min(Math.max(seconds, 60), 604_800));
  }

  static mapError(status: number, body: string, bucket: string): StorageError {
    const code = (xmlValue(body, 'Code') ?? '').toLowerCase();
    const message = xmlValue(body, 'Message');
    if (status === 412 || code === 'preconditionfailed' || code === 'conditionalrequestconflict') {
      return new StorageError({ kind: 'alreadyExists' });
    }
    if (code === 'nosuchbucket') return new StorageError({ kind: 'bucketNotFound', bucket });
    if (code === 'invalidaccesskeyid' || code === 'signaturedoesnotmatch' || code === 'unauthorized' || status === 401) {
      return new StorageError({ kind: 'invalidCredentials' });
    }
    if (code === 'accessdenied' || status === 403) return new StorageError({ kind: 'accessDenied' });
    if (status >= 500 && status !== 501) {
      return new StorageError({ kind: 'network', message: [xmlValue(body, 'Code'), message].filter(Boolean).join(': ') || `HTTP ${status}` });
    }
    const detail = [xmlValue(body, 'Code'), message].filter(Boolean).join(': ');
    return new StorageError({ kind: 'unknown', message: detail || `HTTP ${status}` });
  }
}
