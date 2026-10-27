import { Notice, PluginSettingTab, Setting, setIcon, type App } from 'obsidian';

import { t } from '../core/i18n.ts';
import { DEFAULT_KEY_TEMPLATE, generateObjectKey } from '../core/objectKey.ts';
import { presetDisplayName } from '../core/types.ts';
import { undoLastMove } from '../features/restore.ts';
import { MoveModal } from '../features/moveModal.ts';
import type AktarPlugin from '../main.ts';
import type { UploadTrigger } from '../settings.ts';
import { IMAGE_MAX_EDGES, IMAGE_QUALITIES } from '../upload/imageProcessing.ts';
import { errorMessage } from '../core/types.ts';
import { formatBytes } from './format.ts';
import { ConfirmModal } from './confirmModal.ts';
import { DestinationModal } from './destinationModal.ts';
import { ImportDestinationModal } from './importModal.ts';

export class AktarSettingTab extends PluginSettingTab {
  private readonly plugin: AktarPlugin;

  constructor(app: App, plugin: AktarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private unsubscribe: (() => void) | null = null;

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('aktar-settings');
    this.unsubscribe?.();
    this.unsubscribe = this.plugin.bridge.onChange(() => this.display());
    this.renderApp(containerEl);
    this.renderDestinations(containerEl);
    this.renderUploads(containerEl);
    this.renderAttachments(containerEl);
    this.renderOffline(containerEl);
    this.renderBackups(containerEl);
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The Aktar app on this computer: desktop only. */
  private renderApp(containerEl: HTMLElement): void {
    const bridge = this.plugin.bridge;
    if (!bridge.available) return;
    new Setting(containerEl).setHeading().setName(t('Aktar app'));
    const state = bridge.state.kind;
    const connection = new Setting(containerEl)
      .setName(t('Use the Aktar app on this computer'))
      .setDesc(
        state === 'off'
          ? t('Uploads go through Aktar for Mac or Windows: its destinations, its keys (Obsidian never sees them), its history and hooks. When Aktar isn’t running, destinations with keys on this device go straight to the bucket.')
          : bridge.describe(),
      );
    if (state === 'off') {
      connection.addButton((button) => button.setCta().setButtonText(t('Connect')).onClick(() => bridge.pair()));
      void bridge.cliConnection().then((cli) => {
        if (!cli) return;
        connection.addButton((button) =>
          button.setButtonText(t('Use the CLI’s connection')).onClick(async () => {
            await bridge.save(cli.token, cli.port);
          }),
        );
      });
      new Setting(containerEl)
        .setName(t('Or paste the token'))
        .setDesc(t('From Aktar’s Settings > Integrations, with the local API turned on.'))
        .addText((text) => {
          text.inputEl.type = 'password';
          text.setPlaceholder(t('Token'));
          text.inputEl.addEventListener('change', async () => {
            const token = text.getValue().trim();
            if (!/^[0-9a-f]{32,128}$/i.test(token)) {
              new Notice(t('That doesn’t look like an Aktar token.'));
              return;
            }
            const result = await bridge.save(token);
            if (result.kind !== 'connected') new Notice(bridge.describe());
          });
        });
    } else {
      connection.addExtraButton((button) => button.setIcon('refresh-cw').setTooltip(t('Check again')).onClick(() => void bridge.refresh()));
      connection.addButton((button) => button.setButtonText(t('Disconnect')).onClick(() => void bridge.disconnect()));
    }
  }

  private save(): Promise<void> {
    return this.plugin.saveSettings();
  }

  private renderDestinations(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setHeading().setName(t('Destinations'));
    if (settings.destinations.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: t('A destination is the bucket your files go to. If you use Aktar on your Mac, PC or phone, share a destination from there; it brings the keys along, encrypted.'),
      });
    }
    for (const destination of settings.destinations) {
      const viaApp = this.plugin.bridge.knows(destination.id);
      const hasKeys = this.plugin.credentials.has(destination.id) || viaApp || Boolean(destination.fromApp && this.plugin.bridge.configured);
      const isDefault = destination.id === settings.defaultDestinationId;
      const row = new Setting(containerEl).setName(destination.name);
      row.nameEl.addClass('aktar-destination-name');
      if (isDefault && settings.destinations.length > 1) row.nameEl.createSpan({ cls: 'aktar-badge', text: t('Default') });
      if (destination.private) row.nameEl.createSpan({ cls: 'aktar-badge', text: t('Private') });
      if (viaApp) row.nameEl.createSpan({ cls: 'aktar-badge aktar-badge-muted', text: t('Through Aktar') });
      const description = row.descEl.createDiv();
      description.setText(`${presetDisplayName(destination.preset)} · ${destination.bucket}`);
      if (!hasKeys) {
        const warning = row.descEl.createDiv({ cls: 'aktar-warning' });
        setIcon(warning.createSpan(), 'key-round');
        warning.createSpan({ text: t('The keys aren’t on this device yet.') });
        row.addButton((button) =>
          button
            .setCta()
            .setButtonText(t('Add keys'))
            .onClick(() => new ImportDestinationModal(this.app, this.plugin).open()),
        );
      }
      if (!isDefault) {
        row.addButton((button) =>
          button.setButtonText(t('Make default')).onClick(async () => {
            settings.defaultDestinationId = destination.id;
            await this.save();
            this.display();
          }),
        );
      }
      row.addExtraButton((button) =>
        button
          .setIcon('pencil')
          .setTooltip(t('Edit'))
          .onClick(() => new DestinationModal(this.app, this.plugin, destination, () => this.display()).open()),
      );
      row.addExtraButton((button) =>
        button
          .setIcon('trash-2')
          .setTooltip(t('Remove'))
          .onClick(() =>
            new ConfirmModal(this.app, {
              title: t('Remove “{0}”?', destination.name),
              body: t('Files already in the bucket and links in your notes stay as they are. Its keys are removed from this device.'),
              confirm: t('Remove'),
              danger: true,
              onConfirm: async () => {
                await this.plugin.removeDestination(destination.id);
                this.display();
              },
            }).open(),
          ),
      );
    }
    new Setting(containerEl)
      .addButton((button) =>
        button
          .setCta()
          .setButtonText(t('Add from Aktar app'))
          .onClick(() => new ImportDestinationModal(this.app, this.plugin).open()),
      )
      .addButton((button) =>
        button.setButtonText(t('Add manually')).onClick(() => new DestinationModal(this.app, this.plugin, null, () => this.display()).open()),
      );
  }

  private renderUploads(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setHeading().setName(t('Uploads'));
    const triggers: Record<UploadTrigger, string> = { images: t('Images'), all: t('All files'), off: t('Nothing (keep in the vault)') };
    new Setting(containerEl)
      .setName(t('Upload when pasting'))
      .setDesc(t('What goes to the bucket when you paste into a note.'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(triggers)
          .setValue(settings.pasteUpload)
          .onChange(async (value) => {
            settings.pasteUpload = value as UploadTrigger;
            await this.save();
          }),
      );
    new Setting(containerEl)
      .setName(t('Upload when dropping'))
      .setDesc(t('What goes to the bucket when you drop files onto a note.'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions(triggers)
          .setValue(settings.dropUpload)
          .onChange(async (value) => {
            settings.dropUpload = value as UploadTrigger;
            await this.save();
          }),
      );

    const preview = () => {
      const destination = this.plugin.defaultDestination;
      const template = settings.keyTemplate.trim() || destination?.objectPathTemplate || DEFAULT_KEY_TEMPLATE;
      const key = generateObjectKey(template, 'photo.jpg', { vault: this.plugin.vaultContext('Journal/Today.md'), shortCode: () => 'aB3xK9q' });
      return t('Example: {0}', key);
    };
    const pathSetting = new Setting(containerEl)
      .setName(t('Path in the bucket'))
      .setDesc(preview())
      .addText((text) => {
        text
          .setPlaceholder(t('The destination’s own path'))
          .setValue(settings.keyTemplate)
          .onChange(async (value) => {
            settings.keyTemplate = value.trim();
            pathSetting.setDesc(preview());
            await this.save();
          });
        text.inputEl.addClass('aktar-wide-input');
      });
    const variables = containerEl.createEl('details', { cls: 'aktar-variables' });
    variables.createEl('summary', { text: t('Variables') });
    const table: [string, string][] = [
      ['{vault}', t('this vault’s name')],
      ['{note} {noteFolder}', t('the note’s name and folder')],
      ['{year} {month} {day} {date} {time}', t('when it’s uploaded')],
      ['{short}', t('7 random letters and digits, never reused')],
      ['{filename} {ext}', t('the file’s name and extension')],
      ['{uuid} {random} {sha256}', t('unique or content-based names')],
    ];
    for (const [token, meaning] of table) {
      const row = variables.createDiv({ cls: 'aktar-variable' });
      row.createEl('code', { text: token });
      row.createSpan({ text: meaning });
    }

    new Setting(containerEl)
      .setName(t('Photo format'))
      .setDesc(t('WebP is about a third the size of JPEG at the same quality. Where a device can’t make WebP (iPhone, iPad), photos become JPEG.'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ original: t('Keep the original'), webp: 'WebP' })
          .setValue(settings.imageFormat)
          .onChange(async (value) => {
            settings.imageFormat = value === 'webp' ? 'webp' : 'original';
            await this.save();
          }),
      );
    new Setting(containerEl)
      .setName(t('Scale photos down'))
      .setDesc(t('Photos larger than this are made smaller before they’re uploaded. GIFs and SVGs aren’t touched.'))
      .addDropdown((dropdown) => {
        for (const edge of IMAGE_MAX_EDGES) dropdown.addOption(String(edge), edge === 0 ? t('Keep the size') : t('Longest side {0} px', edge));
        dropdown.setValue(String(settings.imageMaxEdge)).onChange(async (value) => {
          settings.imageMaxEdge = Number(value);
          await this.save();
        });
      })
      .addDropdown((dropdown) => {
        for (const quality of IMAGE_QUALITIES) dropdown.addOption(String(quality), t('Quality {0}%', quality));
        dropdown.setValue(String(settings.imageQuality)).onChange(async (value) => {
          settings.imageQuality = Number(value);
          await this.save();
        });
      });
    new Setting(containerEl)
      .setName(t('Remove location from photos'))
      .setDesc(t('Takes where a photo was taken out of it before it leaves the device. The picture itself isn’t touched.'))
      .addToggle((toggle) =>
        toggle.setValue(settings.removeLocation).onChange(async (value) => {
          settings.removeLocation = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName(t('Image width'))
      .setDesc(t('Width for new image embeds, like 600. Leave empty for full size.'))
      .addText((text) =>
        text
          .setPlaceholder('600')
          .setValue(settings.imageWidth)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!/^(\d+(x\d+)?)?$/.test(trimmed)) return;
            settings.imageWidth = trimmed;
            await this.save();
          }),
      );
  }

  private renderAttachments(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setHeading().setName(t('Attachments in the vault'));
    new Setting(containerEl)
      .setName(t('Move new attachments automatically'))
      .setDesc(t('A file that lands in the vault and is embedded in a note goes to the bucket, such as photos attached on your phone. Files no note links stay.'))
      .addToggle((toggle) =>
        toggle.setValue(settings.autoMove).onChange(async (value) => {
          settings.autoMove = value;
          await this.save();
          this.display();
        }),
      );
    if (settings.autoMove) {
      new Setting(containerEl)
        .setName(t('Only from this folder'))
        .setDesc(t('Leave empty for any folder.'))
        .addText((text) =>
          text
            .setPlaceholder(t('Attachments'))
            .setValue(settings.autoMoveFolder)
            .onChange(async (value) => {
              settings.autoMoveFolder = value.trim();
              await this.save();
            }),
        );
    }
    new Setting(containerEl)
      .setName(t('After a file is moved'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ trash: t('Move it to the trash'), keep: t('Keep it in the vault too') })
          .setValue(settings.localCopy)
          .onChange(async (value) => {
            settings.localCopy = value === 'keep' ? 'keep' : 'trash';
            await this.save();
          }),
      );
    new Setting(containerEl)
      .setName(t('Move existing attachments'))
      .setDesc(t('Shows what would move before anything changes.'))
      .addButton((button) => button.setButtonText(t('Review…')).onClick(() => new MoveModal(this.app, this.plugin, { kind: 'vault' }).open()))
      .addButton((button) => button.setButtonText(t('Undo last move')).onClick(() => void undoLastMove(this.plugin)));
  }

  private renderOffline(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    new Setting(containerEl).setHeading().setName(t('Offline'));
    const cache = new Setting(containerEl)
      .setName(t('Keep images on this device'))
      .setDesc(t('Images from the bucket you’ve seen are kept, so notes show them without a connection, and sooner with one.'))
      .addToggle((toggle) =>
        toggle.setValue(settings.offlineCache).onChange(async (value) => {
          settings.offlineCache = value;
          await this.save();
        }),
      )
      .addDropdown((dropdown) => {
        for (const mb of [100, 250, 500, 1000, 2000, 5000]) dropdown.addOption(String(mb), t('Up to {0}', formatBytes(mb * 1024 * 1024)));
        dropdown.setValue(String(settings.cacheLimitMB)).onChange(async (value) => {
          settings.cacheLimitMB = Number(value);
          await this.save();
        });
      })
      .addExtraButton((button) =>
        button
          .setIcon('trash')
          .setTooltip(t('Clear'))
          .onClick(async () => {
            await this.plugin.renderer.clearCache();
            this.display();
          }),
      );
    void this.plugin.renderer.cache.usage().then(({ bytes, count }) => {
      cache.descEl.createDiv({ cls: 'aktar-muted', text: t('{0} kept, {1}.', count, formatBytes(bytes)) });
    });
  }

  private renderBackups(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    const backup = this.plugin.backup;
    new Setting(containerEl).setHeading().setName(t('Vault backup'));
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('A zip of the whole vault goes to the bucket on a schedule, under a name nobody can guess. It’s one way: nothing is ever restored on its own.'),
    });
    new Setting(containerEl)
      .setName(t('Back up'))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ off: t('Never'), daily: t('Every day'), weekly: t('Every week') })
          .setValue(settings.backupInterval ?? 'off')
          .onChange(async (value) => {
            settings.backupInterval = value === 'daily' || value === 'weekly' ? value : null;
            await this.save();
            this.display();
          }),
      );
    if (settings.backupInterval) {
      new Setting(containerEl)
        .setName(t('From this device'))
        .setDesc(t('Turn it on for one device, the one that’s on most, so the vault isn’t backed up from each.'))
        .addToggle((toggle) => toggle.setValue(backup.onThisDevice).onChange((value) => backup.setOnThisDevice(value)));
      new Setting(containerEl)
        .setName(t('Keep'))
        .addDropdown((dropdown) => {
          for (const keep of [3, 7, 14, 30]) dropdown.addOption(String(keep), t('The newest {0}', keep));
          dropdown.setValue(String(settings.backupKeep)).onChange(async (value) => {
            settings.backupKeep = Number(value);
            await this.save();
          });
        });
      new Setting(containerEl)
        .setName(t('Include settings and plugins'))
        .setDesc(t('The .obsidian folder. Other plugins may keep passwords or keys in their settings, so this is off unless you turn it on.'))
        .addToggle((toggle) =>
          toggle.setValue(settings.backupIncludeConfig).onChange(async (value) => {
            settings.backupIncludeConfig = value;
            await this.save();
          }),
        );
    }
    const last = backup.lastBackup;
    const now = new Setting(containerEl)
      .setName(t('Back up now'))
      .setDesc(last ? t('Last backup from this device: {0}, {1}.', new Date(last.at).toLocaleString(), formatBytes(last.bytes)) : t('No backup from this device yet.'))
      .addButton((button) =>
        button.setButtonText(t('Back up now')).onClick(async () => {
          button.setDisabled(true);
          try {
            const result = await backup.run((text) => now.setDesc(text));
            new Notice(t('The vault is backed up: {0} files, {1}.', result.files, formatBytes(result.bytes)));
          } catch (error) {
            new Notice(t('The vault backup failed: {0}', errorMessage(error)), 10_000);
          }
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t('Copy download link')).onClick(async () => {
          try {
            const link = await backup.latestLink();
            if (!link) return new Notice(t('There’s no backup yet.'));
            await navigator.clipboard.writeText(link);
            new Notice(t('A link to the newest backup is copied. It works for an hour.'));
          } catch (error) {
            new Notice(errorMessage(error));
          }
        }),
      );
  }
}
