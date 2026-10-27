/**
 * Files from the bucket kept on this device, so notes open with their
 * images without a connection, and faster with one. IndexedDB, one store,
 * least recently used goes first once the limit is reached.
 */

interface Entry {
  id: string;
  blob: Blob;
  size: number;
  usedAt: number;
}

const STORE = 'files';

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class MediaCache {
  private readonly name: string;
  private db: Promise<IDBDatabase> | null = null;

  constructor(vaultName: string) {
    this.name = `aktar-cache-${vaultName}`;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('usedAt', 'usedAt');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      this.db.catch(() => (this.db = null));
    }
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async get(id: string): Promise<Blob | null> {
    try {
      const store = await this.store('readwrite');
      const entry = (await promised(store.get(id))) as Entry | undefined;
      if (!entry) return null;
      entry.usedAt = Date.now();
      store.put(entry);
      return entry.blob;
    } catch {
      return null;
    }
  }

  async put(id: string, blob: Blob, limitBytes: number): Promise<void> {
    if (blob.size > limitBytes / 4) return;
    try {
      const store = await this.store('readwrite');
      await promised(store.put({ id, blob, size: blob.size, usedAt: Date.now() } satisfies Entry));
      await this.trim(limitBytes);
    } catch {
      // A full disk or a private window: the file just isn't kept.
    }
  }

  /** Total size, and the entries oldest-used first. */
  async usage(): Promise<{ bytes: number; count: number }> {
    try {
      const entries = (await promised((await this.store('readonly')).getAll())) as Entry[];
      return { bytes: entries.reduce((sum, e) => sum + e.size, 0), count: entries.length };
    } catch {
      return { bytes: 0, count: 0 };
    }
  }

  private async trim(limitBytes: number): Promise<void> {
    const store = await this.store('readwrite');
    const entries = ((await promised(store.index('usedAt').getAll())) as Entry[]).sort((a, b) => a.usedAt - b.usedAt);
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries) {
      if (total <= limitBytes) break;
      store.delete(entry.id);
      total -= entry.size;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      await promised((await this.store('readwrite')).delete(id));
    } catch {
      // Nothing to delete.
    }
  }

  async clear(): Promise<void> {
    try {
      await promised((await this.store('readwrite')).clear());
    } catch {
      // Nothing kept.
    }
  }
}
