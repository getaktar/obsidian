import { Notice, TFile, type Editor } from 'obsidian';

import { plural, t } from '../core/i18n.ts';
import { findLocalReferences, findRemoteLinks } from '../core/links.ts';
import { errorMessage } from '../core/types.ts';
import { executeMove, isAttachment, planMove } from '../features/move.ts';
import { addRemoteFileItems } from '../features/remoteActions.ts';
import { PublishModal } from '../features/publish.ts';
import type AktarPlugin from '../main.ts';

/** Moves files to the bucket from a menu, with a notice instead of the wizard. */
export async function moveFiles(plugin: AktarPlugin, files: TFile[]): Promise<void> {
  const notice = new Notice(t('Moving to the bucket…'), 0);
  try {
    const plan = await planMove(plugin, { kind: 'files', files });
    if (plan.files.length === 0) {
      notice.setMessage(plan.skipped[0] ? `${plan.skipped[0].file.name}: ${plan.skipped[0].reason}` : t('There are no attachments to move here.'));
    } else {
      const result = await executeMove(plugin, plan);
      notice.setMessage(
        result.failed.length > 0
          ? t('Couldn’t move {0} to the bucket: {1}', result.failed[0].file.name, result.failed[0].error)
          : plural(result.moved + result.reused, 'Moved {0} attachment to the bucket.', 'Moved {0} attachments to the bucket.'),
      );
    }
  } catch (error) {
    notice.setMessage(errorMessage(error));
  }
  window.setTimeout(() => notice.hide(), 6000);
}

/** The link under the cursor: a file in a bucket, or a local attachment. */
function linkAtCursor(plugin: AktarPlugin, editor: Editor) {
  const cursor = editor.getCursor();
  const line = editor.getLine(cursor.line);
  const within = (range: { start: number; end: number }) => cursor.ch >= range.start && cursor.ch <= range.end;
  const remote = findRemoteLinks(line, plugin.matchers(), { includeCode: true }).find(within);
  if (remote) return { remote, local: null };
  const local = findLocalReferences(line, { includeProtected: true }).find(within);
  return { remote: null, local: local ?? null };
}

export function registerEditorMenus(plugin: AktarPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
      const notePath = info.file?.path ?? null;
      const { remote, local } = linkAtCursor(plugin, editor);
      if (remote) {
        addRemoteFileItems(plugin, menu, remote, notePath);
        return;
      }
      if (local && notePath && plugin.defaultDestination) {
        const file = plugin.app.metadataCache.getFirstLinkpathDest(local.linkpath, notePath);
        if (file && isAttachment(file)) {
          menu.addItem((item) =>
            item
              .setSection('aktar')
              .setTitle(t('Move to the bucket'))
              .setIcon('cloud-upload')
              .onClick(() => void moveFiles(plugin, [file])),
          );
        }
      }
      if (notePath && plugin.defaultDestination) {
        menu.addItem((item) =>
          item
            .setSection('aktar')
            .setTitle(t('Upload a file here…'))
            .setIcon('upload')
            .onClick(() => plugin.pickAndUpload(editor, notePath)),
        );
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || !plugin.defaultDestination) return;
      if (file.extension === 'md') {
        menu.addItem((item) =>
          item
            .setSection('aktar')
            .setTitle(t('Publish as a web page…'))
            .setIcon('globe')
            .onClick(() => new PublishModal(plugin.app, plugin, file).open()),
        );
      }
      if (isAttachment(file)) {
        menu.addItem((item) =>
          item
            .setSection('aktar')
            .setTitle(t('Move to the bucket'))
            .setIcon('cloud-upload')
            .onClick(() => void moveFiles(plugin, [file])),
        );
      }
    }),
  );

  plugin.registerEvent(
    plugin.app.workspace.on('files-menu', (menu, files) => {
      const attachments = files.filter((f): f is TFile => f instanceof TFile && isAttachment(f));
      if (attachments.length === 0 || !plugin.defaultDestination) return;
      menu.addItem((item) =>
        item
          .setSection('aktar')
          .setTitle(plural(attachments.length, 'Move {0} file to the bucket', 'Move {0} files to the bucket'))
          .setIcon('cloud-upload')
          .onClick(() => void moveFiles(plugin, attachments)),
      );
    }),
  );
}
