import { Modal, Notice, Setting, type App } from 'obsidian';

import { t } from '../core/i18n.ts';
import { formatTransferCodeInput, looksLikeTransferLink, openTransfer, parseTransferLink, TransferError } from '../core/transfer.ts';
import { errorMessage } from '../core/types.ts';
import type AktarPlugin from '../main.ts';

function transferMessage(error: unknown): string {
  if (!(error instanceof TransferError)) return errorMessage(error);
  switch (error.kind) {
    case 'notAktar':
      return t('This isn’t an Aktar transfer link.');
    case 'newerVersion':
      return t('This link is from a newer Aktar. Update the plugin and try again.');
    case 'wrongCode':
      return t('That code doesn’t open this link. Check it on the other device.');
    case 'expired':
      return t('This link has expired. Share the destination again on the other device.');
  }
}

/**
 * Adding a destination from an Aktar app: "Share destination" there shows
 * a link (or QR code) and a 12-character code. The keys travel encrypted
 * under that code and land in this device's secret storage.
 */
export class ImportDestinationModal extends Modal {
  private readonly plugin: AktarPlugin;
  private link: string;
  private code = '';

  constructor(app: App, plugin: AktarPlugin, link = '') {
    super(app);
    this.plugin = plugin;
    this.link = link;
  }

  async onOpen(): Promise<void> {
    this.modalEl.addClass('aktar-modal');
    this.setTitle(t('Add a destination from Aktar'));
    if (!this.link) {
      const clipboard = await navigator.clipboard.readText().catch(() => '');
      if (looksLikeTransferLink(clipboard)) this.link = clipboard.trim();
    }
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const steps = contentEl.createEl('ol', { cls: 'aktar-steps' });
    steps.createEl('li', { text: t('In Aktar on your Mac, PC or phone, open the destination and choose Share.') });
    steps.createEl('li', { text: t('Copy the transfer link and paste it here, then type the code shown next to it.') });

    const error = contentEl.createDiv({ cls: 'aktar-error' });
    const show = (message: string) => error.setText(message);

    new Setting(contentEl).setName(t('Transfer link')).addTextArea((area) => {
      area.setPlaceholder('aktar://import#…').setValue(this.link).onChange((value) => {
        this.link = value.trim();
        show('');
      });
      area.inputEl.rows = 3;
      area.inputEl.addClass('aktar-link-input');
    });

    new Setting(contentEl).setName(t('Transfer code')).addText((text) => {
      text.setPlaceholder('XXXX-XXXX-XXXX').onChange((value) => {
        const formatted = formatTransferCodeInput(value);
        if (formatted !== value) text.setValue(formatted);
        this.code = formatted;
        show('');
      });
      text.inputEl.addClass('aktar-code-input');
      text.inputEl.autocapitalize = 'characters';
      text.inputEl.spellcheck = false;
      text.inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void this.submit(show);
      });
      if (this.link) window.setTimeout(() => text.inputEl.focus(), 50);
    });

    new Setting(contentEl).addButton((button) =>
      button
        .setCta()
        .setButtonText(t('Add destination'))
        .onClick(() => void this.submit(show)),
    );
  }

  private async submit(show: (message: string) => void): Promise<void> {
    try {
      parseTransferLink(this.link);
    } catch (error) {
      show(transferMessage(error));
      return;
    }
    let payload;
    try {
      payload = await openTransfer(this.link, this.code);
    } catch (error) {
      show(transferMessage(error));
      return;
    }
    const existing = this.plugin.destination(payload.destination.id);
    const destination = { ...payload.destination, private: existing?.private ?? false };
    await this.plugin.saveDestination(destination, payload.credentials);
    this.close();
    const notice = new Notice(t('Added “{0}”. Checking the connection…', destination.name), 0);
    try {
      const result = await this.plugin.storage(destination).testConnection();
      notice.setMessage(
        result.writable
          ? t('“{0}” is ready. Paste or drop a file into a note to try it.', destination.name)
          : t('“{0}” was added, but this key can’t upload to the bucket.', destination.name),
      );
    } catch (error) {
      notice.setMessage(t('“{0}” was added, but the connection test failed: {1}', destination.name, errorMessage(error)));
    }
    window.setTimeout(() => notice.hide(), 8000);
  }
}
