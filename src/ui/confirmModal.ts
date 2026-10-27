import { Modal, Setting, type App } from 'obsidian';

import { t } from '../core/i18n.ts';

export interface ConfirmOptions {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export class ConfirmModal extends Modal {
  private readonly options: ConfirmOptions;

  constructor(app: App, options: ConfirmOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    this.modalEl.addClass('aktar-modal');
    this.setTitle(this.options.title);
    this.contentEl.createEl('p', { text: this.options.body });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t('Cancel')).onClick(() => this.close()))
      .addButton((button) => {
        button.setButtonText(this.options.confirm).onClick(async () => {
          button.setDisabled(true);
          await this.options.onConfirm();
          this.close();
        });
        if (this.options.danger) button.setWarning();
        else button.setCta();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
