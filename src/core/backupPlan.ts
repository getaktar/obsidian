/**
 * The rules of vault backups, kept apart from Obsidian so they can be
 * tested: where a backup goes, when the next one is due, which old ones go.
 */

export type BackupInterval = 'daily' | 'weekly';

const DAY_MS = 24 * 60 * 60 * 1000;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Outside this vault's upload folder, so "unused files" never lists them. */
export function backupFolder(vault: string): string {
  const name = vault.replace(/[/\\\u0000-\u001f\u007f]/g, '').trim() || 'vault';
  return `backups/obsidian/${name}/`;
}

/**
 * "backups/obsidian/Notes/2026-10-15-091500-<20 random characters>.zip".
 * The random part (about 103 bits) means nobody can guess a backup's
 * address, even on a bucket the public can read. Names sort by date.
 */
export function backupKey(vault: string, date: Date, random: (count: number) => Uint8Array): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const suffix = Array.from(random(20), (byte) => ALPHABET[byte % 36]).join('');
  return `${backupFolder(vault)}${stamp}-${suffix}.zip`;
}

export function isBackupKey(key: string, vault: string): boolean {
  const folder = backupFolder(vault);
  return key.startsWith(folder) && /^\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-z]{20}\.zip$/.test(key.slice(folder.length));
}

export function backupDue(lastBackup: number | null, interval: BackupInterval, now: number): boolean {
  if (lastBackup === null) return true;
  // A little early is fine: Obsidian opened at 8:55 shouldn't wait until tomorrow.
  const period = interval === 'daily' ? DAY_MS : 7 * DAY_MS;
  return now - lastBackup >= period - 60 * 60 * 1000;
}

/** Backups past the newest `keep`, oldest first: the ones to delete. */
export function expiredBackups(keys: string[], vault: string, keep: number): string[] {
  const backups = keys.filter((key) => isBackupKey(key, vault)).sort();
  return backups.slice(0, Math.max(0, backups.length - Math.max(1, keep)));
}

/** Files that don't belong in a backup: the trash, and the plugin's own pending uploads. */
export function excludedFromBackup(path: string, configDir: string): boolean {
  return (
    path === '.trash' ||
    path.startsWith('.trash/') ||
    path.startsWith(`${configDir}/plugins/aktar/queue/`) ||
    path.startsWith(`${configDir}/cache`) ||
    /(^|\/)\.DS_Store$/.test(path)
  );
}

/** Already compressed: stored as they are, which is much faster on a phone. */
export function storesWithoutCompression(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|heic|heif|mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|opus|flac|zip|gz|7z|rar|pdf|docx|xlsx|pptx|woff2?)$/i.test(path);
}
