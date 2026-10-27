import { Notice, type Menu } from 'obsidian';

import { t } from '../core/i18n.ts';
import { applyReplacements, findRemoteLinks } from '../core/links.ts';
import { errorMessage, objectName } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import { ConfirmModal } from '../ui/confirmModal.ts';
import { bringBack } from './restore.ts';
import { usageId } from './usage.ts';

/** A file in a destination, as the menus and the library act on it. */
export interface RemoteFile {
  destinationId: string;
  key: string;
  url: string;
}

const TEMPORARY_LINKS: [number, string][] = [
  [3600, '1 hour'],
  [86_400, '1 day'],
  [604_800, '7 days'],
];

async function copy(text: string, message: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  new Notice(message);
}

/**
 * The actions on a bucket file, added to a menu: copy its link or a
 * temporary one, open it, bring it into the vault, delete it from the
 * bucket. `notePath` is the note the menu was opened from, if any.
 */
export function addRemoteFileItems(plugin: AktarPlugin, menu: Menu, file: RemoteFile, notePath: string | null): void {
  const destination = plugin.destination(file.destinationId);
  if (!destination) return;
  menu.addItem((item) =>
    item
      .setSection('aktar')
      .setTitle(t('Copy link'))
      .setIcon('link')
      .onClick(() => copy(file.url, t('Link copied.'))),
  );
  for (const [seconds, label] of TEMPORARY_LINKS) {
    menu.addItem((item) =>
      item
        .setSection('aktar')
        .setTitle(t('Copy link valid for {0}', t(label)))
        .setIcon('timer')
        .onClick(async () => {
          try {
            await copy(await plugin.storage(destination).temporaryLink(file.key, seconds), t('Temporary link copied. It stops working in {0}.', t(label)));
          } catch (error) {
            new Notice(errorMessage(error));
          }
        }),
    );
  }
  menu.addItem((item) =>
    item
      .setSection('aktar')
      .setTitle(t('Open in browser'))
      .setIcon('external-link')
      .onClick(async () => window.open(await plugin.renderer.openableURL(file.url))),
  );
  if (notePath) {
    menu.addItem((item) =>
      item
        .setSection('aktar')
        .setTitle(t('Bring into the vault'))
        .setIcon('hard-drive-download')
        .onClick(async () => {
          const note = plugin.app.vault.getFileByPath(notePath);
          if (!note) return;
          const result = await bringBack(plugin, [note], { only: (link) => link.destinationId === file.destinationId && link.key === file.key });
          new Notice(result.failed.length > 0 ? result.failed[0].error : t('{0} is in the vault now.', objectName(file.key)));
        }),
    );
  }
  menu.addItem((item) =>
    item
      .setSection('aktar-danger')
      .setTitle(t('Delete from bucket…'))
      .setIcon('trash-2')
      .setWarning(true)
      .onClick(() => void confirmDelete(plugin, file)),
  );
}

/**
 * Deleting from the bucket can't be undone and breaks every link to the
 * file, so it says first how many notes link it, and offers to take the
 * links out of them.
 */
export async function confirmDelete(plugin: AktarPlugin, file: RemoteFile, onDeleted?: () => void): Promise<void> {
  const destination = plugin.destination(file.destinationId);
  if (!destination) return;
  const usage = (await plugin.usage.get()).get(usageId(file.destinationId, file.key));
  const notes = usage ? [...usage.notes] : [];
  const body =
    notes.length === 0
      ? t('{0} will be deleted from {1}. No note links it. This can’t be undone.', objectName(file.key), destination.name)
      : notes.length === 1
        ? t('{0} is linked from 1 note, and that link will stop working. This can’t be undone.', objectName(file.key))
        : t('{0} is linked from {1} notes, and those links will stop working. This can’t be undone.', objectName(file.key), notes.length);
  new ConfirmModal(plugin.app, {
    title: t('Delete from the bucket?'),
    body,
    confirm: notes.length > 0 ? t('Delete and remove links') : t('Delete'),
    danger: true,
    onConfirm: async () => {
      try {
        await plugin.storage(destination).delete(file.key);
        await plugin.renderer.forget(file.destinationId, file.key);
      } catch (error) {
        new Notice(errorMessage(error));
        return;
      }
      for (const path of notes) {
        const note = plugin.app.vault.getFileByPath(path);
        if (!note) continue;
        await plugin.app.vault.process(note, (text) => {
          const links = findRemoteLinks(text, plugin.matchers()).filter((l) => l.destinationId === file.destinationId && l.key === file.key);
          return applyReplacements(text, links.map((l) => ({ start: l.start, end: l.end, text: '' })));
        });
      }
      plugin.usage.invalidate();
      new Notice(t('Deleted {0}.', objectName(file.key)));
      onDeleted?.();
    },
  }).open();
}
