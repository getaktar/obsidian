import { Modal, Setting, type App } from 'obsidian';

import { plural, t } from '../core/i18n.ts';
import { errorMessage } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import { formatBytes } from '../ui/format.ts';
import { executeMove, planMove, type MovePlan, type MoveScope } from './move.ts';
import { undoLastMove } from './restore.ts';

/**
 * The move wizard: first what would happen (a dry run, nothing touched),
 * then the move with progress, then what happened, with an undo.
 */
export class MoveModal extends Modal {
  private readonly plugin: AktarPlugin;
  private readonly moveScope: MoveScope;
  private controller: AbortController | null = null;

  constructor(app: App, plugin: AktarPlugin, scope: MoveScope) {
    super(app);
    this.plugin = plugin;
    this.moveScope = scope;
  }

  onOpen(): void {
    this.modalEl.addClass('aktar-modal');
    this.setTitle(this.moveScope.kind === 'vault' ? t('Move attachments to the bucket') : t('Move this note’s attachments'));
    void this.showPlan();
  }

  onClose(): void {
    this.controller?.abort();
    this.contentEl.empty();
  }

  private async showPlan(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const destination = this.plugin.defaultDestination;
    if (!destination || !this.plugin.canUpload(destination)) {
      contentEl.createEl('p', { text: t('Add a destination with its keys first, in Settings > Aktar.') });
      return;
    }
    contentEl.createEl('p', { cls: 'aktar-muted', text: t('Looking through your notes…') });
    let plan: MovePlan;
    try {
      plan = await planMove(this.plugin, this.moveScope);
    } catch (error) {
      contentEl.empty();
      contentEl.createEl('p', { text: errorMessage(error) });
      return;
    }
    contentEl.empty();
    if (plan.files.length === 0) {
      contentEl.createEl('p', { text: t('There are no attachments to move here.') });
      if (plan.skipped.length > 0) this.renderSkipped(plan);
      return;
    }

    const summary = contentEl.createDiv({ cls: 'aktar-summary' });
    this.stat(summary, plural(plan.files.length, '{0} file', '{0} files'), formatBytes(plan.bytes));
    this.stat(summary, plural(plan.notes.length, '{0} note', '{0} notes'), plural(plan.references, '{0} link', '{0} links'));
    this.stat(summary, destination.name, destination.bucket);

    const list = contentEl.createEl('ul', { cls: 'aktar-plan-list' });
    for (const file of plan.files.slice(0, 8)) list.createEl('li', { text: `${file.path} · ${formatBytes(file.stat.size)}` });
    if (plan.files.length > 8) list.createEl('li', { cls: 'aktar-muted', text: t('and {0} more', plan.files.length - 8) });

    contentEl.createEl('p', {
      cls: 'aktar-muted',
      text:
        this.plugin.settings.localCopy === 'trash'
          ? t('Links in your notes will point to the bucket and the files in the vault go to the trash. A file still linked from front matter, code or a canvas stays. You can undo this.')
          : t('Links in your notes will point to the bucket. The files stay in the vault too. You can undo this.'),
    });
    if (plan.skipped.length > 0) this.renderSkipped(plan);

    new Setting(contentEl)
      .addButton((button) => button.setButtonText(t('Cancel')).onClick(() => this.close()))
      .addButton((button) =>
        button
          .setCta()
          .setButtonText(plural(plan.files.length, 'Move {0} file', 'Move {0} files'))
          .onClick(() => void this.run(plan)),
      );
  }

  private stat(parent: HTMLElement, value: string, label: string): void {
    const item = parent.createDiv({ cls: 'aktar-stat' });
    item.createDiv({ cls: 'aktar-stat-value', text: value });
    item.createDiv({ cls: 'aktar-stat-label', text: label });
  }

  private renderSkipped(plan: MovePlan): void {
    const details = this.contentEl.createEl('details', { cls: 'aktar-skipped' });
    details.createEl('summary', { text: plural(plan.skipped.length, '{0} file is left out', '{0} files are left out') });
    for (const { file, reason } of plan.skipped) details.createDiv({ text: `${file.path}: ${reason}` });
  }

  private async run(plan: MovePlan): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    const label = contentEl.createEl('p');
    const bar = contentEl.createEl('progress', { cls: 'aktar-progress' });
    bar.max = plan.files.length;
    bar.value = 0;
    this.controller = new AbortController();
    new Setting(contentEl).addButton((button) =>
      button.setButtonText(t('Stop')).onClick(() => {
        this.controller?.abort();
        button.setDisabled(true);
      }),
    );
    try {
      const result = await executeMove(this.plugin, plan, {
        signal: this.controller.signal,
        onProgress: (done, total, current) => {
          bar.value = done;
          label.setText(t('{0} of {1}: {2}', done, total, current));
        },
      });
      contentEl.empty();
      const summary = contentEl.createDiv({ cls: 'aktar-summary' });
      this.stat(summary, String(result.moved + result.reused), t('in the bucket'));
      this.stat(summary, String(result.notesChanged), t('notes updated'));
      this.stat(summary, String(result.trashed), t('moved to trash'));
      if (result.keptInUse > 0) contentEl.createEl('p', { cls: 'aktar-muted', text: plural(result.keptInUse, '{0} file is still linked from front matter, code or a canvas, so it stayed in the vault.', '{0} files are still linked from front matter, code or a canvas, so they stayed in the vault.') });
      if (result.failed.length > 0) {
        const details = contentEl.createEl('details', { cls: 'aktar-skipped' });
        details.setAttr('open', '');
        details.createEl('summary', { text: plural(result.failed.length, '{0} file couldn’t be moved and is unchanged', '{0} files couldn’t be moved and are unchanged') });
        for (const { file, error } of result.failed) details.createDiv({ text: `${file.path}: ${error}` });
      }
      const buttons = new Setting(contentEl);
      // Undo only reaches back to this move when there was one.
      if (result.moved + result.reused > 0) {
        buttons.addButton((button) =>
          button.setButtonText(t('Undo')).onClick(async () => {
            button.setDisabled(true);
            await undoLastMove(this.plugin);
            this.close();
          }),
        );
      }
      buttons.addButton((button) => button.setCta().setButtonText(t('Done')).onClick(() => this.close()));
    } catch (error) {
      contentEl.empty();
      contentEl.createEl('p', { text: errorMessage(error) });
    } finally {
      this.controller = null;
    }
  }
}
