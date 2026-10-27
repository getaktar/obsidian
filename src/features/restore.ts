import { Notice, TFile } from 'obsidian';

import { plural, t } from '../core/i18n.ts';
import { applyReplacements, findRemoteLinks, type RemoteLink } from '../core/links.ts';
import { errorMessage, objectName } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import { ensureParentFolder, type MoveRecord } from './move.ts';

/**
 * The way back: files in the bucket come into the vault again and their
 * links become ordinary attachment links, written the way the vault's own
 * link settings say. The files stay in the bucket too; the library's
 * "unused files" finds them later.
 */

export interface RestoreResult {
  files: number;
  links: number;
  failed: { key: string; error: string }[];
}

export async function bringBack(
  plugin: AktarPlugin,
  notes: TFile[],
  options: { only?: (link: RemoteLink) => boolean; preferredPaths?: Map<string, string> } = {},
): Promise<RestoreResult> {
  const vault = plugin.app.vault;
  const matchers = plugin.matchers();
  const result: RestoreResult = { files: 0, links: 0, failed: [] };
  const local = new Map<string, TFile>();
  const failed = new Set<string>();

  const fileFor = async (link: RemoteLink, notePath: string): Promise<TFile | null> => {
    const id = `${link.destinationId}/${link.key}`;
    if (local.has(id)) return local.get(id) ?? null;
    if (failed.has(id)) return null;
    try {
      const destination = plugin.destination(link.destinationId);
      if (!destination) throw new Error(t('The destination for this file was removed.'));
      const data = await plugin.storage(destination).download(link.key);
      if (!data) throw new Error(t('It’s no longer in the bucket.'));
      const preferred = options.preferredPaths?.get(id);
      const path = preferred && !vault.getAbstractFileByPath(preferred)
        ? preferred
        : await plugin.app.fileManager.getAvailablePathForAttachment(objectName(link.key), notePath);
      await ensureParentFolder(plugin, path);
      plugin.autoMover?.ignore(path);
      const file = await vault.createBinary(path, data);
      local.set(id, file);
      result.files++;
      return file;
    } catch (error) {
      failed.add(id);
      result.failed.push({ key: link.key, error: errorMessage(error) });
      return null;
    }
  };

  for (const note of notes) {
    const text = await vault.read(note);
    const links = findRemoteLinks(text, matchers).filter((link) => link.style === 'markdown' && (options.only?.(link) ?? true));
    if (links.length === 0) continue;
    const files = new Map<RemoteLink, TFile>();
    for (const link of links) {
      const file = await fileFor(link, note.path);
      if (file) files.set(link, file);
    }
    if (files.size === 0) continue;
    await vault.process(note, (current) => {
      // The note may have changed while files downloaded: the links are found again by URL.
      const fresh = findRemoteLinks(current, matchers).filter((link) => link.style === 'markdown');
      const replacements = fresh.flatMap((link) => {
        const file = local.get(`${link.destinationId}/${link.key}`);
        if (!file || !(options.only?.(link) ?? true)) return [];
        const alias = link.embed ? (link.size ?? link.caption ?? undefined) : (link.caption ?? undefined);
        const markup = plugin.app.fileManager.generateMarkdownLink(file, note.path, undefined, alias === file.name ? undefined : alias);
        result.links++;
        return [{ start: link.start, end: link.end, text: link.embed ? `!${markup.replace(/^!/, '')}` : markup }];
      });
      return replacements.length === 0 ? current : applyReplacements(current, replacements);
    });
  }
  return result;
}

function report(result: RestoreResult): void {
  if (result.files === 0 && result.failed.length === 0) {
    new Notice(t('No files from the bucket in this note.'));
    return;
  }
  const parts = [plural(result.files, '{0} file is back in the vault.', '{0} files are back in the vault.')];
  if (result.failed.length > 0) parts.push(t('{0} couldn’t be downloaded: {1}', result.failed.length, result.failed[0].error));
  new Notice(parts.join(' '), 8000);
}

export async function bringBackNote(plugin: AktarPlugin, note: TFile): Promise<void> {
  try {
    report(await bringBack(plugin, [note]));
  } catch (error) {
    new Notice(errorMessage(error));
  }
}

/** Undoes the last move: every file returns to the path it had, and every note that links it is rewritten. */
export async function undoLastMove(plugin: AktarPlugin): Promise<void> {
  const batch = await plugin.lastMove();
  if (!batch || batch.length === 0) {
    new Notice(t('There’s no move to undo.'));
    return;
  }
  const ids = new Set(batch.map((record: MoveRecord) => `${record.destinationId}/${record.key}`));
  const preferredPaths = new Map(batch.map((record: MoveRecord) => [`${record.destinationId}/${record.key}`, record.path]));
  const matchers = plugin.matchers();
  const notes: TFile[] = [];
  for (const note of plugin.app.vault.getMarkdownFiles()) {
    const text = await plugin.app.vault.cachedRead(note);
    if (findRemoteLinks(text, matchers).some((link) => ids.has(`${link.destinationId}/${link.key}`))) notes.push(note);
  }
  const result = await bringBack(plugin, notes, { only: (link) => ids.has(`${link.destinationId}/${link.key}`), preferredPaths });
  if (result.failed.length === 0) await plugin.forgetLastMove();
  report(result);
}
