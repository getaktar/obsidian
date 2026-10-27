import type { App } from 'obsidian';

import type { StorageCredentials } from '../core/types.ts';

/**
 * A destination's keys, in Obsidian's secret storage under
 * "aktar-<destination id>". Secret storage isn't synced, so each device has
 * its own copy and data.json (which is) never holds a key. A device that
 * gets the destination through sync and not its keys asks for them, most
 * easily with a transfer code from an Aktar app.
 */
export class CredentialStore {
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  private static secretId(destinationId: string): string {
    return `aktar-${destinationId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
  }

  get(destinationId: string): StorageCredentials | null {
    const raw = this.app.secretStorage.getSecret(CredentialStore.secretId(destinationId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<StorageCredentials>;
      if (typeof parsed.accessKeyId !== 'string' || typeof parsed.secretAccessKey !== 'string') return null;
      if (!parsed.accessKeyId || !parsed.secretAccessKey) return null;
      return { accessKeyId: parsed.accessKeyId, secretAccessKey: parsed.secretAccessKey, sessionToken: parsed.sessionToken ?? null };
    } catch {
      return null;
    }
  }

  has(destinationId: string): boolean {
    return this.get(destinationId) !== null;
  }

  set(destinationId: string, credentials: StorageCredentials): void {
    const value: StorageCredentials = { accessKeyId: credentials.accessKeyId.trim(), secretAccessKey: credentials.secretAccessKey.trim() };
    if (credentials.sessionToken) value.sessionToken = credentials.sessionToken.trim();
    this.app.secretStorage.setSecret(CredentialStore.secretId(destinationId), JSON.stringify(value));
  }

  /** Secret storage can't delete, so the value is emptied, which `get` reads as no keys. */
  remove(destinationId: string): void {
    this.app.secretStorage.setSecret(CredentialStore.secretId(destinationId), '');
  }
}
