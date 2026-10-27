import { MarkdownView, Notice, type Editor, type MarkdownFileInfo } from 'obsidian';

import { extensionForMimeType, isImageFilename, pathExtension } from '../core/contentType.ts';
import { t } from '../core/i18n.ts';
import { isEmbeddable, placeholderMarkup } from '../core/links.ts';
import type AktarPlugin from '../main.ts';
import type { UploadTrigger } from '../settings.ts';

/** Obsidian's own name for a pasted image, so notes look the same with or without the plugin. */
function pastedName(file: File): string {
  if (file.name && file.name !== 'image.png' && pathExtension(file.name)) return file.name;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const extension = pathExtension(file.name) || extensionForMimeType(file.type) || 'bin';
  return `Pasted image ${stamp}.${extension}`;
}

function wanted(files: File[], trigger: UploadTrigger): File[] {
  if (trigger === 'off') return [];
  if (trigger === 'all') return files;
  return files.filter((file) => file.type.startsWith('image/') || isImageFilename(file.name));
}

/**
 * Where the files go: the default destination, if its keys are on this
 * device. Without one the paste is left to Obsidian (the file goes into the
 * vault as usual) and the user is told once why.
 */
function readyDestination(plugin: AktarPlugin) {
  const destination = plugin.defaultDestination;
  if (!destination) return null;
  if (!plugin.canUpload(destination)) {
    new Notice(t('The keys for “{0}” aren’t on this device yet, so this file stays in the vault. Add them in Settings > Aktar.', destination.name), 8000);
    return null;
  }
  return destination;
}

/**
 * The files go into the note as placeholders at once and upload from the
 * queue; each placeholder becomes its link when its upload is done, even
 * if that's after a restart.
 */
export async function uploadIntoEditor(plugin: AktarPlugin, files: File[], editor: Editor, notePath: string, at?: { line: number; ch: number }): Promise<void> {
  const destination = readyDestination(plugin);
  if (!destination) return;
  const entries = files.map((file) => ({ file, id: globalThis.crypto.randomUUID(), filename: pastedName(file) }));
  const markup = entries.map((e) => placeholderMarkup(e.id, e.filename, t('Uploading'))).join('\n');
  if (at) editor.replaceRange(markup, at);
  else editor.replaceSelection(markup);
  const size = plugin.settings.imageWidth || null;
  for (const entry of entries) {
    try {
      const data = await entry.file.arrayBuffer();
      await plugin.queue.add(
        {
          id: entry.id,
          notePath,
          filename: entry.filename,
          destinationId: destination.id,
          embed: isEmbeddable(entry.filename),
          size: isImageFilename(entry.filename) ? size : null,
        },
        data,
      );
    } catch (error) {
      console.error('Aktar: could not queue a file', error);
      new Notice(t('Couldn’t read {0}.', entry.filename));
    }
  }
}

function notePathOf(info: MarkdownView | MarkdownFileInfo): string | null {
  return info.file?.path ?? null;
}

/** The editor position under the pointer of a drop, through CodeMirror; the cursor when that isn't available. */
function dropPosition(editor: Editor, event: DragEvent): { line: number; ch: number } | undefined {
  const view = (editor as unknown as { cm?: { posAtCoords(c: { x: number; y: number }): number | null } }).cm;
  const offset = view?.posAtCoords({ x: event.clientX, y: event.clientY });
  return offset === null || offset === undefined ? undefined : editor.offsetToPos(offset);
}

export function registerPasteAndDrop(plugin: AktarPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-paste', (event, editor, info) => {
      if (event.defaultPrevented) return;
      const files = wanted(Array.from(event.clipboardData?.files ?? []), plugin.settings.pasteUpload);
      const notePath = notePathOf(info);
      if (files.length === 0 || !notePath || !plugin.defaultDestination) return;
      if (!plugin.canUpload(plugin.defaultDestination)) {
        readyDestination(plugin);
        return;
      }
      event.preventDefault();
      void uploadIntoEditor(plugin, files, editor, notePath);
    }),
  );
  plugin.registerEvent(
    plugin.app.workspace.on('editor-drop', (event, editor, info) => {
      if (event.defaultPrevented) return;
      const files = wanted(Array.from(event.dataTransfer?.files ?? []), plugin.settings.dropUpload);
      const notePath = notePathOf(info);
      if (files.length === 0 || !notePath || !plugin.defaultDestination) return;
      if (!plugin.canUpload(plugin.defaultDestination)) {
        readyDestination(plugin);
        return;
      }
      event.preventDefault();
      void uploadIntoEditor(plugin, files, editor, notePath, dropPosition(editor, event));
    }),
  );
}
