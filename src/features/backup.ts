import { zip, type AsyncZippable } from 'fflate';
import { normalizePath, Notice, Platform } from 'obsidian';

import { backupDue, backupFolder, backupKey, excludedFromBackup, expiredBackups, storesWithoutCompression } from '../core/backupPlan.ts';
import { t } from '../core/i18n.ts';
import { errorMessage } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import { formatBytes } from '../ui/format.ts';

const LAST_BACKUP_KEY = 'aktar-last-backup';
const DEVICE_KEY = 'aktar-backup-here';
/** All of it is read into memory to be zipped: phones get a lower ceiling. */
const MAX_BYTES = Platform.isMobile ? 400 * 1024 * 1024 : 4 * 1024 * 1024 * 1024;
const CHECK_EVERY_MS = 60 * 60 * 1000;

export interface BackupResult {
  key: string;
  files: number;
  bytes: number;
  removed: number;
}

/**
 * Vault backups into the bucket: a zip of every file (and, if chosen, the
 * settings folder), on a schedule, from the devices it's turned on for,
 * keeping the newest few. One way only, so there's nothing to conflict.
 */
export class VaultBackup {
  private readonly plugin: AktarPlugin;
  private running = false;

  constructor(plugin: AktarPlugin) {
    this.plugin = plugin;
  }

  /** Backups are made from this device. Per device, so a vault on three devices isn't backed up three times. */
  get onThisDevice(): boolean {
    return this.plugin.app.loadLocalStorage(DEVICE_KEY) === 'on';
  }

  setOnThisDevice(on: boolean): void {
    this.plugin.app.saveLocalStorage(DEVICE_KEY, on ? 'on' : 'off');
  }

  get lastBackup(): { at: number; bytes: number } | null {
    const raw = this.plugin.app.loadLocalStorage(LAST_BACKUP_KEY);
    try {
      const parsed = typeof raw === 'string' ? (JSON.parse(raw) as { at?: number; bytes?: number }) : null;
      return parsed && typeof parsed.at === 'number' ? { at: parsed.at, bytes: parsed.bytes ?? 0 } : null;
    } catch {
      return null;
    }
  }

  start(): void {
    const check = () => {
      const settings = this.plugin.settings;
      if (!settings.backupInterval || !this.onThisDevice || this.running) return;
      if (!backupDue(this.lastBackup?.at ?? null, settings.backupInterval, Date.now())) return;
      void this.run().catch((error) => new Notice(t('The vault backup failed: {0}', errorMessage(error)), 10_000));
    };
    this.plugin.registerInterval(window.setInterval(check, CHECK_EVERY_MS));
    window.setTimeout(check, 30_000);
  }

  private async collect(onProgress?: (text: string) => void): Promise<{ files: AsyncZippable; count: number; bytes: number }> {
    const app = this.plugin.app;
    const configDir = app.vault.configDir;
    const paths: string[] = app.vault
      .getFiles()
      .map((file) => file.path)
      .filter((path) => !excludedFromBackup(path, configDir));
    if (this.plugin.settings.backupIncludeConfig) {
      const walk = async (folder: string): Promise<void> => {
        const listing = await app.vault.adapter.list(folder);
        for (const file of listing.files) if (!excludedFromBackup(file, configDir)) paths.push(file);
        for (const sub of listing.folders) if (!excludedFromBackup(sub + '/', configDir)) await walk(sub);
      };
      await walk(configDir);
    }
    const files: AsyncZippable = {};
    let bytes = 0;
    for (const [index, path] of paths.entries()) {
      const data = new Uint8Array(await app.vault.adapter.readBinary(normalizePath(path)));
      bytes += data.byteLength;
      if (bytes > MAX_BYTES) throw new Error(t('The vault is bigger than {0}, too big to back up from this device.', formatBytes(MAX_BYTES)));
      files[path] = [data, { level: storesWithoutCompression(path) ? 0 : 6 }];
      if (index % 50 === 0) onProgress?.(t('Reading {0} of {1} files…', index + 1, paths.length));
    }
    return { files, count: paths.length, bytes };
  }

  async run(onProgress?: (text: string) => void): Promise<BackupResult> {
    if (this.running) throw new Error(t('A backup is already running.'));
    const destination = this.plugin.defaultDestination;
    if (!destination) throw new Error(t('Add a destination first.'));
    this.running = true;
    try {
      const storage = this.plugin.storage(destination);
      const { files, count, bytes } = await this.collect(onProgress);
      onProgress?.(t('Compressing…'));
      const archive = await new Promise<Uint8Array>((resolve, reject) => zip(files, { level: 6 }, (error, data) => (error ? reject(error) : resolve(data))));
      const vault = this.plugin.app.vault.getName();
      const key = backupKey(vault, new Date(), (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
      onProgress?.(t('Uploading {0}…', formatBytes(archive.byteLength)));
      const written = await storage.upload(key, archive.buffer as ArrayBuffer, { contentType: 'application/zip' });
      this.plugin.app.saveLocalStorage(LAST_BACKUP_KEY, JSON.stringify({ at: Date.now(), bytes: archive.byteLength }));

      let removed = 0;
      const existing = await storage.listAll(backupFolder(vault));
      for (const old of expiredBackups(existing.map((o) => o.key), vault, this.plugin.settings.backupKeep)) {
        await storage.delete(old).then(() => removed++).catch(() => undefined);
      }
      return { key: written, files: count, bytes, removed };
    } finally {
      this.running = false;
    }
  }

  /** A download link for the newest backup, valid for an hour. */
  async latestLink(): Promise<string | null> {
    const destination = this.plugin.defaultDestination;
    if (!destination) return null;
    const storage = this.plugin.storage(destination);
    const keys = (await storage.listAll(backupFolder(this.plugin.app.vault.getName()))).map((o) => o.key).sort();
    const latest = keys[keys.length - 1];
    return latest ? storage.temporaryLink(latest, 3600) : null;
  }
}
