import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * The Aktar app's local API on this computer (Mac 0.18.0 / Windows 0.11.0
 * and later), the same one the CLI and the Raycast extension use. Aktar
 * keeps the storage keys; this only sends files to it on 127.0.0.1.
 *
 * Requests go through Node's `http`, which Obsidian has on desktop only:
 * the local API turns away anything that looks like a web page (an Origin
 * header), and a browser request always has one.
 */

export const DEFAULT_PORT = 47913;
const HELLO_PREFIX = 'aktar-hello-v1:';
const REQUEST_TIMEOUT_MS = 30_000;

export interface AppConnection {
  port: number;
  token: string;
}

export interface AppStatus {
  app: string;
  version: string;
  apiVersion: number;
  defaultDestinationId: string | null;
}

export interface AppDestination {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  bucket: string;
  publicBaseURL: string;
  isDefault: boolean;
}

export interface AppUpload {
  id: string;
  filename: string;
  objectKey: string;
  url: string;
  destinationId: string;
  size: number;
}

export interface AppListing {
  prefix: string;
  folders: { prefix: string; name: string }[];
  objects: { key: string; name: string; size: number; lastModified?: string | null; url?: string | null }[];
  nextContinuationToken?: string | null;
}

export type AppErrorKind = 'notRunning' | 'unauthorized' | 'unverified' | 'failed';

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly status?: number;

  constructor(kind: AppErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.status = status;
  }
}

type NodeHttp = {
  request(
    options: Record<string, unknown>,
    callback: (response: {
      statusCode?: number;
      on(event: 'data', listener: (chunk: Uint8Array) => void): void;
      on(event: 'end', listener: () => void): void;
    }) => void,
  ): {
    on(event: 'error', listener: (error: Error & { code?: string }) => void): void;
    on(event: 'timeout', listener: () => void): void;
    destroy(error?: Error): void;
    end(body?: Uint8Array): void;
  };
};

/** Node's http module, only where Obsidian has Node (desktop). */
export function nodeHttp(): NodeHttp | null {
  const load = typeof window === 'undefined' ? undefined : (window as unknown as { require?: (name: string) => unknown }).require;
  try {
    return (load?.('http') as NodeHttp | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The proof the app has to give: HMAC-SHA256 of the nonce, keyed with the token. */
export function helloProof(token: string, nonce: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(token), utf8ToBytes(`${HELLO_PREFIX}${nonce}`)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class AppClient {
  readonly connection: AppConnection;
  private readonly http: NodeHttp;
  private verified: Promise<void> | null = null;

  constructor(connection: AppConnection, http: NodeHttp) {
    this.connection = connection;
    this.http = http;
  }

  /**
   * The app proves it has the token before the token is sent, so a program
   * squatting the port while Aktar isn't running never gets it, or a file.
   */
  verify(): Promise<void> {
    if (!this.verified) {
      const check = this.hello();
      this.verified = check;
      check.catch(() => {
        if (this.verified === check) this.verified = null;
      });
    }
    return this.verified;
  }

  private async hello(): Promise<void> {
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    let reply: { app?: unknown; proof?: unknown };
    try {
      reply = await this.request('GET', 'hello', { query: { nonce }, anonymous: true });
    } catch (error) {
      if (error instanceof AppError && error.kind !== 'notRunning' && error.status !== undefined) {
        throw new AppError('unverified', 'This Aktar is too old to connect. Update to Aktar for Mac 0.18.0 or Windows 0.11.0 or later.', error.status);
      }
      throw error;
    }
    const proof = typeof reply.proof === 'string' ? reply.proof.toLowerCase() : '';
    if (reply.app !== 'Aktar' || !/^[0-9a-f]{64}$/.test(proof) || !constantTimeEqual(proof, helloProof(this.connection.token, nonce))) {
      throw new AppError('unverified', `The app on port ${this.connection.port} couldn't prove it's Aktar, so nothing was sent. Connect again from Settings > Aktar.`);
    }
  }

  status(): Promise<AppStatus> {
    return this.request('GET', 'status');
  }

  async destinations(): Promise<AppDestination[]> {
    return (await this.request<{ destinations: AppDestination[] }>('GET', 'destinations')).destinations ?? [];
  }

  /** The file goes exactly into `prefix` under `filename`, or "filename 2" when that's taken. */
  async upload(destinationId: string, prefix: string, filename: string, data: ArrayBuffer): Promise<AppUpload> {
    const reply = await this.request<{ upload: AppUpload }>('POST', 'uploads', {
      query: { destinationId, prefix: prefix || '/', filename, short: 0 },
      body: new Uint8Array(data),
      timeoutMs: 0,
    });
    return reply.upload;
  }

  listObjects(destinationId: string, prefix: string, continuationToken?: string | null): Promise<AppListing> {
    return this.request('GET', `destinations/${encodeURIComponent(destinationId)}/objects`, {
      query: { prefix, continuationToken: continuationToken ?? undefined },
    });
  }

  async deleteObject(destinationId: string, key: string): Promise<void> {
    await this.request('DELETE', `destinations/${encodeURIComponent(destinationId)}/objects`, { query: { key } });
  }

  async temporaryLink(destinationId: string, key: string, expiresIn: number): Promise<string> {
    const reply = await this.request<{ url: string }>('POST', `destinations/${encodeURIComponent(destinationId)}/links`, {
      json: { key, expiresIn },
    });
    return reply.url;
  }

  private async request<T>(
    method: string,
    route: string,
    options: { query?: Record<string, string | number | undefined>; json?: unknown; body?: Uint8Array; anonymous?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!options.anonymous) await this.verify();
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) search.set(key, String(value));
    const query = search.toString();
    const headers: Record<string, string | number> = { Accept: 'application/json' };
    if (!options.anonymous) headers.Authorization = `Bearer ${this.connection.token}`;
    let body: Uint8Array | undefined;
    if (options.json !== undefined) {
      body = utf8ToBytes(JSON.stringify(options.json));
      headers['Content-Type'] = 'application/json';
    } else if (options.body) {
      body = options.body;
      headers['Content-Type'] = 'application/octet-stream';
    }
    if (body || method !== 'GET') headers['Content-Length'] = body?.length ?? 0;

    return new Promise<T>((resolve, reject) => {
      const request = this.http.request(
        {
          host: '127.0.0.1',
          port: this.connection.port,
          method,
          path: `/v1/${route}${query ? `?${query}` : ''}`,
          headers,
          timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
        },
        (response) => {
          const chunks: Uint8Array[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const total = chunks.reduce((sum, c) => sum + c.length, 0);
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }
            const text = new TextDecoder().decode(bytes);
            let payload: unknown = {};
            try {
              payload = text ? JSON.parse(text) : {};
            } catch {
              payload = {};
            }
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(payload as T);
              return;
            }
            const message = (payload as { error?: string }).error ?? `Aktar answered HTTP ${status}.`;
            reject(new AppError(status === 401 ? 'unauthorized' : 'failed', message, status));
          });
        },
      );
      request.on('timeout', () => request.destroy(new Error('Aktar took too long to answer.')));
      request.on('error', (error) => {
        if (error.code === 'ECONNREFUSED') reject(new AppError('notRunning', 'Aktar isn’t running, or its local API is off.'));
        else reject(new AppError('failed', error.message));
      });
      request.end(body);
    });
  }
}
