import { Modal, Setting, type App } from 'obsidian';

import { t } from '../core/i18n.ts';
import { DEFAULT_KEY_TEMPLATE } from '../core/objectKey.ts';
import {
  deriveR2Endpoint,
  errorMessage,
  PROVIDER_PRESETS,
  presetDefaultForcePathStyle,
  presetDefaultRegion,
  presetDisplayName,
  type DestinationConfig,
  type ProviderPreset,
  type StorageCredentials,
} from '../core/types.ts';
import type AktarPlugin from '../main.ts';

const ENDPOINT_HINTS: Partial<Record<ProviderPreset, string>> = {
  amazonS3: 'https://s3.us-east-1.amazonaws.com',
  backblazeB2: 'https://s3.us-west-004.backblazeb2.com',
  digitalOceanSpaces: 'https://fra1.digitaloceanspaces.com',
  minIO: 'http://192.168.1.10:9000',
  customS3: 'https://s3.example.com',
};

/** Adding a destination by hand, or changing one. The keys are only shown as "saved" once they're in. */
export class DestinationModal extends Modal {
  private readonly plugin: AktarPlugin;
  private readonly onSaved: () => void;
  private draft: DestinationConfig;
  private accessKeyId = '';
  private secretAccessKey = '';
  private readonly hasKeys: boolean;
  private readonly isNew: boolean;

  constructor(app: App, plugin: AktarPlugin, existing: DestinationConfig | null, onSaved: () => void) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
    this.isNew = existing === null;
    this.draft = existing
      ? { ...existing }
      : {
          id: globalThis.crypto.randomUUID().toUpperCase(),
          name: '',
          preset: 'cloudflareR2',
          accountID: '',
          endpoint: '',
          region: presetDefaultRegion('cloudflareR2'),
          bucket: '',
          publicBaseURL: '',
          objectPathTemplate: DEFAULT_KEY_TEMPLATE,
          forcePathStyle: false,
          private: false,
        };
    this.hasKeys = existing !== null && plugin.credentials.has(existing.id);
  }

  onOpen(): void {
    this.modalEl.addClass('aktar-modal');
    this.setTitle(this.isNew ? t('Add a destination') : t('Edit “{0}”', this.draft.name));
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const d = this.draft;

    new Setting(contentEl).setName(t('Name')).addText((text) =>
      text.setPlaceholder(t('Notes')).setValue(d.name).onChange((value) => (d.name = value)),
    );
    new Setting(contentEl).setName(t('Provider')).addDropdown((dropdown) => {
      for (const preset of PROVIDER_PRESETS) dropdown.addOption(preset, presetDisplayName(preset));
      dropdown.setValue(d.preset).onChange((value) => {
        d.preset = value as ProviderPreset;
        d.region = presetDefaultRegion(d.preset);
        d.forcePathStyle = presetDefaultForcePathStyle(d.preset);
        this.render();
      });
    });
    if (d.preset === 'cloudflareR2') {
      new Setting(contentEl)
        .setName(t('Account ID'))
        .setDesc(t('In the Cloudflare dashboard, on the R2 overview page.'))
        .addText((text) =>
          text.setValue(d.accountID ?? '').onChange((value) => {
            d.accountID = value.trim();
            d.endpoint = value.trim() ? deriveR2Endpoint(value) : '';
          }),
        );
    } else {
      new Setting(contentEl).setName(t('Endpoint')).addText((text) =>
        text.setPlaceholder(ENDPOINT_HINTS[d.preset] ?? '').setValue(d.endpoint).onChange((value) => (d.endpoint = value.trim())),
      );
      new Setting(contentEl).setName(t('Region')).addText((text) => text.setValue(d.region).onChange((value) => (d.region = value.trim() || 'auto')));
    }
    new Setting(contentEl).setName(t('Bucket')).addText((text) => text.setValue(d.bucket).onChange((value) => (d.bucket = value.trim())));
    new Setting(contentEl)
      .setName(t('Public URL'))
      .setDesc(t('Where the bucket’s files can be opened, such as https://files.example.com or an r2.dev address. Links in notes start with it.'))
      .addText((text) => text.setPlaceholder('https://files.example.com').setValue(d.publicBaseURL).onChange((value) => (d.publicBaseURL = value.trim())));
    new Setting(contentEl)
      .setName(t('Private bucket'))
      .setDesc(t('The bucket isn’t open to the public. Notes keep plain links and the plugin shows the files through links signed on this device, valid for an hour.'))
      .addToggle((toggle) => toggle.setValue(Boolean(d.private)).onChange((value) => (d.private = value)));
    if (d.preset !== 'cloudflareR2') {
      new Setting(contentEl)
        .setName(t('Path-style addresses'))
        .setDesc(t('host/bucket/key instead of bucket.host/key. MinIO and some self-hosted servers need it.'))
        .addToggle((toggle) => toggle.setValue(d.forcePathStyle).onChange((value) => (d.forcePathStyle = value)));
    }

    new Setting(contentEl).setHeading().setName(t('Keys'));
    new Setting(contentEl).setName(t('Access Key ID')).addText((text) => {
      text.setPlaceholder(this.hasKeys ? t('Saved on this device') : '').setValue(this.accessKeyId).onChange((value) => (this.accessKeyId = value.trim()));
      text.inputEl.spellcheck = false;
    });
    new Setting(contentEl)
      .setName(t('Secret Access Key'))
      .setDesc(t('Kept in Obsidian’s secret storage on this device, never in the vault or its settings.'))
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder(this.hasKeys ? t('Saved on this device') : '').setValue(this.secretAccessKey).onChange((value) => (this.secretAccessKey = value.trim()));
      });

    const status = contentEl.createDiv({ cls: 'aktar-error' });
    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText(t('Test connection')).onClick(async () => {
          const problem = this.problem();
          if (problem) return status.setText(problem);
          button.setDisabled(true);
          status.removeClass('aktar-ok');
          status.setText(t('Checking…'));
          status.setText(await this.test());
          button.setDisabled(false);
        }),
      )
      .addButton((button) =>
        button
          .setCta()
          .setButtonText(t('Save'))
          .onClick(async () => {
            const problem = this.problem();
            if (problem) return status.setText(problem);
            const credentials = this.credentials();
            const name = d.name.trim() || d.bucket;
            await this.plugin.saveDestination({ ...d, name }, this.accessKeyId && this.secretAccessKey ? credentials : null);
            this.onSaved();
            this.close();
          }),
      );
  }

  private credentials(): StorageCredentials | null {
    if (this.accessKeyId && this.secretAccessKey) return { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey };
    return this.plugin.credentials.get(this.draft.id);
  }

  private problem(): string | null {
    const d = this.draft;
    if (!d.endpoint) return d.preset === 'cloudflareR2' ? t('Enter the account ID.') : t('Enter the endpoint.');
    if (!d.bucket) return t('Enter the bucket.');
    if (!d.publicBaseURL) return t('Enter the public URL.');
    if (!this.credentials()) return t('Enter both keys.');
    if (Boolean(this.accessKeyId) !== Boolean(this.secretAccessKey)) return t('Enter both keys.');
    return null;
  }

  private async test(): Promise<string> {
    const credentials = this.credentials();
    if (!credentials) return t('Enter both keys.');
    try {
      const result = await this.plugin.clientWith(this.draft, credentials).testConnection();
      if (!result.writable) return t('Connected, but this key cannot upload files.');
      if (result.publicLink && result.publicLink.kind !== 'reachable') {
        return result.publicLink.kind === 'status'
          ? t('Uploads work, but the public URL answered {0}. If the bucket is private, turn on Private bucket.', result.publicLink.status)
          : t('Uploads work, but the public URL didn’t answer. Check the address.');
      }
      this.contentEl.querySelector('.aktar-error')?.addClass('aktar-ok');
      return t('Everything works.');
    } catch (error) {
      return errorMessage(error);
    }
  }
}
