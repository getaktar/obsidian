import { hmac } from '@noble/hashes/hmac.js';
import { md5 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * AWS Signature Version 4, written against the spec rather than pulled in
 * from the AWS SDK, so it runs the same in Obsidian on desktop and mobile,
 * and every S3-compatible provider Aktar supports speaks plain SigV4.
 */

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface SigningCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | null;
}

export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const chunk = (a << 16) | (b << 8) | c;
    result += BASE64_ALPHABET[(chunk >> 18) & 63] + BASE64_ALPHABET[(chunk >> 12) & 63];
    result += i + 1 < bytes.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : '=';
    result += i + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] : '=';
  }
  return result;
}

/**
 * The Content-MD5 header value (base64 of the body's MD5), which
 * PutBucketLifecycleConfiguration requires on AWS and R2.
 */
export function contentMD5(body: string): string {
  return bytesToBase64(md5(utf8ToBytes(body)));
}

/** Strict RFC 3986 encoding, which is what SigV4 canonicalization expects. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Encodes an object key for a URL path, keeping the "/" separators. */
export function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function hmacBytes(key: Uint8Array | string, data: string): Uint8Array {
  return hmac(sha256, typeof key === 'string' ? utf8ToBytes(key) : key, utf8ToBytes(data));
}

function amzDate(date: Date): { stamp: string; day: string } {
  const stamp = date.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  return { stamp, day: stamp.slice(0, 8) };
}

function canonicalQuery(query: [string, string][]): string {
  return query
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function signingKey(secret: string, day: string, region: string, service: string): Uint8Array {
  const kDate = hmacBytes('AWS4' + secret, day);
  const kRegion = hmacBytes(kDate, region);
  const kService = hmacBytes(kRegion, service);
  return hmacBytes(kService, 'aws4_request');
}

export interface SignableRequest {
  method: string;
  host: string;
  /** Already percent-encoded path, starting with "/". */
  path: string;
  query: [string, string][];
  headers: Record<string, string>;
  payloadHash: string;
}

/**
 * Returns the headers to send (the originals plus x-amz-date,
 * x-amz-content-sha256, the session token and Authorization). Only `host`
 * and `x-amz-*` headers are signed: HTTP stacks are free to adjust
 * Content-Type (Android appends a charset), which would break a signature
 * that covered it.
 */
export function signRequest(
  request: SignableRequest,
  credentials: SigningCredentials,
  region: string,
  date: Date = new Date(),
  service = 's3',
): Record<string, string> {
  const { stamp, day } = amzDate(date);
  const headers: Record<string, string> = { ...request.headers };
  headers['x-amz-date'] = stamp;
  headers['x-amz-content-sha256'] = request.payloadHash;
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  const signed: Record<string, string> = { host: request.host };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    // Content-Disposition and If-None-Match are signed too, so they can't be stripped on the way to the bucket.
    if (lower.startsWith('x-amz-') || lower === 'content-disposition' || lower === 'if-none-match') signed[lower] = String(value).trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery(request.query),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = bytesToHex(hmacBytes(signingKey(credentials.secretAccessKey, day, region, service), stringToSign));

  headers['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

/** A query-string signed (presigned) URL, valid for `expiresIn` seconds. */
export function presignUrl(
  request: { method: string; scheme: string; host: string; path: string },
  credentials: SigningCredentials,
  region: string,
  expiresIn: number,
  date: Date = new Date(),
  service = 's3',
): string {
  const { stamp, day } = amzDate(date);
  const scope = `${day}/${region}/${service}/aws4_request`;
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (credentials.sessionToken) query.push(['X-Amz-Security-Token', credentials.sessionToken]);

  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery(query),
    `host:${request.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = bytesToHex(hmacBytes(signingKey(credentials.secretAccessKey, day, region, service), stringToSign));

  return `${request.scheme}://${request.host}${request.path}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}
