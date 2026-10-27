import { normalizePath, Platform, TFile } from 'obsidian';

import { t } from '../core/i18n.ts';
import { applyReplacements, findLocalReferences, remoteMarkup } from '../core/links.ts';
import { errorMessage } from '../core/types.ts';
import type AktarPlugin from '../main.ts';

/**
 * Moving files that are already in the vault into the bucket: upload,
 * rewrite every link to them in every note, then the local copy goes to the
 * trash (or stays, per settings). Nothing is rewritten for a file whose
 * upload failed, and nothing is trashed that a note still points to.
 */

export type MoveScope = { kind: 'notes'; notes: TFile[] } | { kind: 'vault' } | { kind: 'files'; files: TFile[] };

export interface MovePlan {
  files: TFile[];
  /** Notes whose text will change: every note linking to one of the files. */
  notes: TFile[];
  references: number;
  bytes: number;
  /** Files left out, and why. */
  skipped: { file: TFile; reason: string }[];
}

export interface MoveResult {
  moved: number;
  /** Already in the bucket from an earlier or another device's move. */
  reused: number;
  failed: { file: TFile; error: string }[];
  notesChanged: number;
  trashed: number;
  /** Still linked from somewhere the plugin doesn't rewrite (front matter, code, canvas), so kept. */
  keptInUse: number;
}

/** Not attachments: notes, canvases and bases are vault documents of their own. */
const DOCUMENT_EXTENSIONS = new Set(['md', 'canvas', 'base']);

/** Reading a whole file into memory to send it: phones get a lower ceiling. */
const MAX_BYTES = Platform.isMobile ? 300 * 1024 * 1024 : 2 * 1024 * 1024 * 1024;

export function isAttachment(file: TFile): boolean {
  return !DOCUMENT_EXTENSIONS.has(file.extension.toLowerCase());
}

/** Notes that link to `file`, from Obsidian's link index. */
export function notesLinkingTo(plugin: AktarPlugin, file: TFile): TFile[] {
  const notes: TFile[] = [];
  for (const [source, targets] of Object.entries(plugin.app.metadataCache.resolvedLinks)) {
    if (!targets[file.path]) continue;
    const note = plugin.app.vault.getFileByPath(source);
    if (note && note.extension === 'md') notes.push(note);
  }
  return notes;
}

function linkingSources(plugin: AktarPlugin, file: TFile): string[] {
  return Object.entries(plugin.app.metadataCache.resolvedLinks)
    .filter(([, targets]) => Boolean(targets[file.path]))
    .map(([source]) => source);
}

function resolve(plugin: AktarPlugin, linkpath: string, notePath: string): TFile | null {
  return plugin.app.metadataCache.getFirstLinkpathDest(linkpath, notePath);
}

export async function planMove(plugin: AktarPlugin, scope: MoveScope): Promise<MovePlan> {
  const vault = plugin.app.vault;
  const files = new Map<string, TFile>();
  if (scope.kind === 'files') {
    for (const file of scope.files) if (isAttachment(file)) files.set(file.path, file);
  } else {
    const notes = scope.kind === 'vault' ? vault.getMarkdownFiles() : scope.notes;
    for (const note of notes) {
      const text = await vault.cachedRead(note);
      for (const reference of findLocalReferences(text)) {
        const file = resolve(plugin, reference.linkpath, note.path);
        if (file && isAttachment(file)) files.set(file.path, file);
      }
    }
  }

  const skipped: MovePlan['skipped'] = [];
  const chosen: TFile[] = [];
  for (const file of files.values()) {
    if (file.stat.size > MAX_BYTES) skipped.push({ file, reason: t('too large to move from this device') });
    else chosen.push(file);
  }

  const notes = new Map<string, TFile>();
  for (const file of chosen) for (const note of notesLinkingTo(plugin, file)) notes.set(note.path, note);
  let references = 0;
  const chosenPaths = new Set(chosen.map((f) => f.path));
  for (const note of notes.values()) {
    const text = await vault.cachedRead(note);
    references += findLocalReferences(text).filter((r) => chosenPaths.has(resolve(plugin, r.linkpath, note.path)?.path ?? '')).length;
  }
  return {
    files: chosen,
    notes: [...notes.values()],
    references,
    bytes: chosen.reduce((sum, file) => sum + file.stat.size, 0),
    skipped,
  };
}

export interface MoveRecord {
  path: string;
  destinationId: string;
  key: string;
  url: string;
}

async function runLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) await work(items[next++]);
  });
  await Promise.all(workers);
}

export async function executeMove(
  plugin: AktarPlugin,
  plan: MovePlan,
  options: { onProgress?: (done: number, total: number, current: string) => void; signal?: AbortSignal } = {},
): Promise<MoveResult> {
  const destination = plugin.defaultDestination;
  if (!destination) throw new Error(t('Add a destination first.'));
  const client = plugin.storage(destination);
  const vault = plugin.app.vault;
  const result: MoveResult = { moved: 0, reused: 0, failed: [], notesChanged: 0, trashed: 0, keptInUse: 0 };
  const uploaded = new Map<string, MoveRecord>();
  let done = 0;

  await runLimited(
    plan.files,
    3,
    async (file) => {
      options.onProgress?.(done, plan.files.length, file.name);
      try {
        const data = await vault.readBinary(file);
        const notePath = notesLinkingTo(plugin, file)[0]?.path ?? file.path;
        const outcome = await plugin.upload({ data, filename: file.name, destination, client, notePath, stable: true, date: new Date(file.stat.ctime) });
        uploaded.set(file.path, { path: file.path, destinationId: destination.id, key: outcome.key, url: outcome.url });
        if (outcome.reused) result.reused++;
        else result.moved++;
      } catch (error) {
        result.failed.push({ file, error: errorMessage(error) });
      }
      done++;
      options.onProgress?.(done, plan.files.length, file.name);
    },
    options.signal,
  );
  if (uploaded.size === 0) return result;

  for (const note of plan.notes) {
    let changed = false;
    await vault.process(note, (text) => {
      const replacements = findLocalReferences(text).flatMap((reference) => {
        const file = resolve(plugin, reference.linkpath, note.path);
        const record = file ? uploaded.get(file.path) : undefined;
        if (!file || !record) return [];
        const text = remoteMarkup(record.url, file.name, { embed: reference.embed, caption: reference.caption, size: reference.size });
        return [{ start: reference.start, end: reference.end, text }];
      });
      if (replacements.length === 0) return text;
      changed = true;
      return applyReplacements(text, replacements);
    });
    if (changed) result.notesChanged++;
  }

  await plugin.recordMove([...uploaded.values()]);

  if (plugin.settings.localCopy === 'trash') {
    for (const [path] of uploaded) {
      const file = vault.getFileByPath(path);
      if (!file) continue;
      if (await stillReferenced(plugin, file)) {
        result.keptInUse++;
        continue;
      }
      await plugin.app.fileManager.trashFile(file);
      result.trashed++;
    }
  }
  return result;
}

/**
 * Whether anything still points at the file after the rewrite: a link in
 * front matter or code (left alone on purpose), or a canvas. The link
 * index may lag behind the rewrite, so the notes it names are read again.
 */
async function stillReferenced(plugin: AktarPlugin, file: TFile): Promise<boolean> {
  for (const source of linkingSources(plugin, file)) {
    const document = plugin.app.vault.getFileByPath(source);
    if (!document) continue;
    if (document.extension !== 'md') return true;
    const text = await plugin.app.vault.read(document);
    const references = findLocalReferences(text, { includeProtected: true });
    if (references.some((r) => resolve(plugin, r.linkpath, document.path)?.path === file.path)) return true;
  }
  return false;
}

/** Makes the folders above `path` that don't exist yet. */
export async function ensureParentFolder(plugin: AktarPlugin, path: string): Promise<void> {
  const folder = normalizePath(path).split('/').slice(0, -1).join('/');
  if (!folder || plugin.app.vault.getFolderByPath(folder)) return;
  await plugin.app.vault.createFolder(folder).catch(() => undefined);
}
