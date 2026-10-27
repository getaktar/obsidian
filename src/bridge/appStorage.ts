import { requestUrl } from 'obsidian';

import { resolvePublicURL } from '../core/publicUrl.ts';
import { StorageError, type BucketListing, type BucketObject, type ConnectionResult, type DestinationConfig } from '../core/types.ts';
import type { Storage, UploadOptions } from '../storage.ts';
import { AppError, type AppClient } from './appClient.ts';

/** App errors as the storage errors the rest of the plugin acts on: not running is worth waiting for. */
function mapped(error: unknown): unknown {
  if (!(error instanceof AppError)) return error;
  if (error.kind === 'notRunning') return new StorageError({ kind: 'network', message: error.message });
  return new StorageError({ kind: 'unknown', message: error.message });
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw mapped(error);
  }
}

function folderOf(key: string): { folder: string; name: string } {
  const slash = key.lastIndexOf('/');
  return { folder: slash === -1 ? '' : key.slice(0, slash + 1), name: key.slice(slash + 1) };
}

/**
 * A destination through the Aktar app: the app holds the keys, applies the
 * destination's own settings (image processing, hooks), and lists the
 * uploads in its history. The app never replaces a file, so `upload` may
 * come back with "name 2" instead of the key asked for.
 */
export class AppStorage implements Storage {
  readonly kind = 'app';
  private readonly destination: DestinationConfig;
  private readonly client: AppClient;

  constructor(destination: DestinationConfig, client: AppClient) {
    this.destination = destination;
    this.client = client;
  }

  publicURL(key: string): string {
    return resolvePublicURL(this.destination.publicBaseURL, key);
  }

  async testConnection(): Promise<ConnectionResult> {
    await call(() => this.client.listObjects(this.destination.id, ''));
    return { bucketReachable: true, writable: true, publicLink: null };
  }

  async upload(key: string, data: ArrayBuffer, options: UploadOptions): Promise<string> {
    const { folder, name } = folderOf(key);
    options.onProgress?.(0);
    const upload = await call(() => this.client.upload(this.destination.id, folder, name, data));
    options.onProgress?.(1);
    return upload.objectKey;
  }

  /** Through a link the app signs, so it works for private buckets too. */
  async download(key: string): Promise<ArrayBuffer | null> {
    const url = await this.temporaryLink(key, 300);
    const response = await requestUrl({ url, method: 'GET', throw: false });
    if (response.status === 404) return null;
    if (response.status < 200 || response.status >= 300) throw new StorageError({ kind: 'unknown', message: `HTTP ${response.status}` });
    return response.arrayBuffer;
  }

  delete(key: string): Promise<void> {
    return call(() => this.client.deleteObject(this.destination.id, key));
  }

  async objectExists(key: string): Promise<boolean> {
    return (await this.objectInfo(key)) !== null;
  }

  async objectInfo(key: string): Promise<{ size: number; lastModified: number | null } | null> {
    const { folder } = folderOf(key);
    let token: string | null | undefined = null;
    do {
      const page = await call(() => this.client.listObjects(this.destination.id, folder, token));
      const object = page.objects.find((o) => o.key === key);
      if (object) return { size: object.size, lastModified: object.lastModified ? Date.parse(object.lastModified) : null };
      token = page.nextContinuationToken;
    } while (token);
    return null;
  }

  async list(prefix: string, continuationToken?: string | null): Promise<BucketListing> {
    const page = await call(() => this.client.listObjects(this.destination.id, prefix, continuationToken));
    return {
      prefix: page.prefix,
      folders: page.folders.map((f) => f.prefix),
      objects: page.objects.map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified ? Date.parse(o.lastModified) : null })),
      nextContinuationToken: page.nextContinuationToken ?? null,
    };
  }

  /** The app lists one folder at a time, so the whole tree is walked. */
  async listAll(prefix: string, onPage?: (count: number) => void): Promise<BucketObject[]> {
    const objects: BucketObject[] = [];
    const folders = [prefix];
    while (folders.length > 0) {
      const folder = folders.shift() ?? '';
      let token: string | null = null;
      do {
        const page = await this.list(folder, token);
        objects.push(...page.objects);
        folders.push(...page.folders);
        onPage?.(objects.length);
        token = page.nextContinuationToken;
      } while (token);
    }
    return objects;
  }

  temporaryLink(key: string, seconds: number): Promise<string> {
    return call(() => this.client.temporaryLink(this.destination.id, key, seconds));
  }
}
