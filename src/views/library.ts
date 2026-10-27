import { ItemView, MarkdownView, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';

import { fileKind, isImageFilename } from '../core/contentType.ts';
import { plural, t } from '../core/i18n.ts';
import { remoteMarkup } from '../core/links.ts';
import { templatePrefix } from '../core/objectKey.ts';
import { errorMessage, objectName, type BucketObject, type DestinationConfig } from '../core/types.ts';
import { addRemoteFileItems, type RemoteFile } from '../features/remoteActions.ts';
import { usageId, type RemoteFileUsage } from '../features/usage.ts';
import type AktarPlugin from '../main.ts';
import { ConfirmModal } from '../ui/confirmModal.ts';
import { formatBytes, formatDate } from '../ui/format.ts';

export const LIBRARY_VIEW = 'aktar-library';

type Tab = 'vault' | 'bucket' | 'queue';

const KIND_ICONS: Record<string, string> = {
  image: 'image',
  pdf: 'file-text',
  archive: 'file-archive',
  movie: 'film',
  audio: 'music',
  text: 'file-code',
  generic: 'file',
};

/**
 * The sidebar library: what the vault's notes use from the bucket, the
 * bucket itself (with the files no note uses), and the upload queue.
 */
export class LibraryView extends ItemView {
  private readonly plugin: AktarPlugin;
  private tab: Tab = 'vault';
  private filter = '';
  private destinationId: string | null = null;
  private prefix: string | null = null;
  private body!: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: AktarPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return LIBRARY_VIEW;
  }

  getDisplayText(): string {
    return t('Aktar library');
  }

  getIcon(): string {
    return 'cloud';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('aktar-library');
    this.unsubscribe = this.plugin.queue.onChange(() => {
      if (this.tab === 'queue') this.render();
      else this.renderTabs();
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.render();
  }

  private tabsEl: HTMLElement | null = null;

  private renderTabs(): void {
    if (!this.tabsEl) return;
    this.tabsEl.empty();
    const failed = this.plugin.queue.mine.filter((job) => job.state === 'failed').length;
    const pending = this.plugin.queue.mine.length;
    const tabs: [Tab, string][] = [
      ['vault', t('In notes')],
      ['bucket', t('Bucket')],
      ['queue', pending > 0 ? t('Uploads ({0})', pending) : t('Uploads')],
    ];
    for (const [tab, label] of tabs) {
      const button = this.tabsEl.createEl('button', { cls: 'aktar-tab', text: label });
      if (tab === this.tab) button.addClass('is-active');
      if (tab === 'queue' && failed > 0) button.addClass('aktar-tab-failed');
      button.onClickEvent(() => this.show(tab));
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.plugin.settings.destinations.length === 0) {
      const empty = contentEl.createDiv({ cls: 'aktar-empty' });
      setIcon(empty.createDiv({ cls: 'aktar-empty-icon' }), 'cloud');
      empty.createEl('p', { text: t('Add a destination in Settings > Aktar to start.') });
      return;
    }
    this.tabsEl = contentEl.createDiv({ cls: 'aktar-tabs' });
    this.renderTabs();
    this.body = contentEl.createDiv({ cls: 'aktar-library-body' });
    if (this.tab === 'vault') void this.renderVault();
    else if (this.tab === 'bucket') void this.renderBucket();
    else this.renderQueue();
  }

  // MARK: Rows

  private thumbnail(parent: HTMLElement, url: string, key: string): void {
    const box = parent.createDiv({ cls: 'aktar-thumb' });
    if (isImageFilename(key)) {
      const img = box.createEl('img', { attr: { loading: 'lazy', alt: '' } });
      // The renderer swaps in the kept copy or a signed URL as soon as it's in the window.
      img.src = url;
      img.onerror = () => {
        img.remove();
        setIcon(box, 'image-off');
      };
    } else {
      setIcon(box, KIND_ICONS[fileKind(key)] ?? 'file');
    }
  }

  private row(file: RemoteFile, detail: string, extra?: (row: HTMLElement) => void): HTMLElement {
    const row = this.body.createDiv({ cls: 'aktar-row' });
    this.thumbnail(row, file.url, file.key);
    const text = row.createDiv({ cls: 'aktar-row-text' });
    text.createDiv({ cls: 'aktar-row-name', text: objectName(file.key) });
    text.createDiv({ cls: 'aktar-row-detail', text: detail });
    extra?.(row);
    const more = row.createDiv({ cls: 'clickable-icon aktar-row-more', attr: { 'aria-label': t('More') } });
    setIcon(more, 'more-horizontal');
    const openMenu = (event: MouseEvent) => {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle(t('Insert into note'))
          .setIcon('plus')
          .onClick(() => this.insert(file)),
      );
      addRemoteFileItems(this.plugin, menu, file, null);
      menu.showAtMouseEvent(event);
    };
    more.onClickEvent(openMenu);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMenu(event);
    });
    // Dragged into a note, the file is its embed markup.
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', remoteMarkup(file.url, objectName(file.key)));
    });
    return row;
  }

  /** Into the note last edited, at its cursor. */
  private insert(file: RemoteFile): void {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view;
    if (!(view instanceof MarkdownView)) {
      new Notice(t('Open a note first.'));
      return;
    }
    view.editor.replaceSelection(remoteMarkup(file.url, objectName(file.key)));
    this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
  }

  private search(placeholder: string): void {
    const input = this.body.createEl('input', { cls: 'aktar-search', attr: { type: 'search', placeholder } });
    input.value = this.filter;
    input.addEventListener('input', () => {
      this.filter = input.value;
      this.body.querySelectorAll<HTMLElement>('.aktar-row').forEach((row) => {
        const name = row.querySelector('.aktar-row-name')?.textContent?.toLowerCase() ?? '';
        const detail = row.querySelector('.aktar-row-detail')?.textContent?.toLowerCase() ?? '';
        const query = this.filter.toLowerCase();
        row.toggleClass('aktar-hidden', Boolean(query) && !name.includes(query) && !detail.includes(query));
      });
    });
  }

  // MARK: In notes

  private async renderVault(): Promise<void> {
    const loading = this.body.createDiv({ cls: 'aktar-muted', text: t('Reading notes…') });
    const usage = await this.plugin.usage.get();
    loading.remove();
    if (usage.size === 0) {
      const empty = this.body.createDiv({ cls: 'aktar-empty' });
      setIcon(empty.createDiv({ cls: 'aktar-empty-icon' }), 'image-plus');
      empty.createEl('p', { text: t('No note links a file from your bucket yet. Paste or drop a file into a note, or move existing attachments.') });
      return;
    }
    this.search(t('Search files and notes'));
    const entries = [...usage.values()].sort((a, b) => objectName(a.key).localeCompare(objectName(b.key)));
    this.body.createDiv({ cls: 'aktar-muted aktar-count', text: plural(entries.length, '{0} file', '{0} files') });
    for (const entry of entries) this.vaultRow(entry);
  }

  private vaultRow(entry: RemoteFileUsage): void {
    const notes = [...entry.notes];
    const detail = notes.length === 1 ? notes[0].replace(/\.md$/, '') : t('{0} notes', notes.length);
    const row = this.row(entry, detail);
    row.addClass('is-clickable');
    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.aktar-row-more')) return;
      if (notes.length === 1) {
        void this.app.workspace.openLinkText(notes[0], '', false);
        return;
      }
      const menu = new Menu();
      for (const path of notes) {
        menu.addItem((item) =>
          item
            .setTitle(path.replace(/\.md$/, ''))
            .setIcon('file-text')
            .onClick(() => void this.app.workspace.openLinkText(path, '', false)),
        );
      }
      menu.showAtMouseEvent(event);
    });
  }

  // MARK: Bucket

  private currentDestination(): DestinationConfig | null {
    return this.plugin.destination(this.destinationId) ?? this.plugin.defaultDestination;
  }

  /** This vault's own folder in the bucket, from the path template. "" when uploads have none. */
  private vaultFolder(destination: DestinationConfig): string {
    return templatePrefix(this.plugin.templateFor(destination), this.plugin.vaultContext(''));
  }

  private async renderBucket(): Promise<void> {
    const destination = this.currentDestination();
    if (!destination) return;
    if (this.prefix === null) this.prefix = this.vaultFolder(destination);
    const prefix = this.prefix;

    const header = this.body.createDiv({ cls: 'aktar-bucket-header' });
    if (this.plugin.settings.destinations.length > 1) {
      const select = header.createEl('select', { cls: 'dropdown' });
      for (const d of this.plugin.settings.destinations) select.createEl('option', { value: d.id, text: d.name });
      select.value = destination.id;
      select.addEventListener('change', () => {
        this.destinationId = select.value;
        this.prefix = null;
        this.render();
      });
    }
    const crumbs = header.createDiv({ cls: 'aktar-crumbs' });
    const parts = prefix.split('/').filter(Boolean);
    const crumb = (label: string, target: string) => {
      const el = crumbs.createSpan({ cls: 'aktar-crumb', text: label });
      el.onClickEvent(() => {
        this.prefix = target;
        this.render();
      });
    };
    crumb(destination.bucket, '');
    parts.forEach((part, index) => {
      crumbs.createSpan({ cls: 'aktar-muted', text: ' / ' });
      crumb(part, parts.slice(0, index + 1).join('/') + '/');
    });

    let client;
    try {
      client = this.plugin.storage(destination);
    } catch (error) {
      this.body.createDiv({ cls: 'aktar-error', text: errorMessage(error) });
      return;
    }

    const folder = this.vaultFolder(destination);
    const tools = this.body.createDiv({ cls: 'aktar-tools' });
    const unusedButton = tools.createEl('button', { text: t('Find unused files') });
    if (!folder) {
      unusedButton.disabled = true;
      unusedButton.title = t('Unused files can only be found when this vault’s uploads have a folder of their own. Set one in Path in the bucket.');
    }
    unusedButton.onClickEvent(() => void this.findUnused(destination, folder));

    const list = this.body.createDiv();
    const loading = list.createDiv({ cls: 'aktar-muted', text: t('Loading…') });
    try {
      const [listing, usage] = await Promise.all([client.list(prefix), this.plugin.usage.get()]);
      loading.remove();
      this.search(t('Search this folder'));
      for (const sub of listing.folders) {
        const row = this.body.createDiv({ cls: 'aktar-row is-clickable' });
        setIcon(row.createDiv({ cls: 'aktar-thumb' }), 'folder');
        row.createDiv({ cls: 'aktar-row-text' }).createDiv({ cls: 'aktar-row-name', text: objectName(sub) });
        row.onClickEvent(() => {
          this.prefix = sub;
          this.render();
        });
      }
      this.objectRows(destination, listing.objects, usage);
      let token = listing.nextContinuationToken;
      if (token) {
        const more = this.body.createEl('button', { cls: 'aktar-load-more', text: t('Load more') });
        more.onClickEvent(async () => {
          more.setText(t('Loading…'));
          const page = await client.list(prefix, token);
          more.remove();
          this.objectRows(destination, page.objects, usage);
          token = page.nextContinuationToken;
        });
      }
      if (listing.folders.length === 0 && listing.objects.length === 0) this.body.createDiv({ cls: 'aktar-muted', text: t('This folder is empty.') });
    } catch (error) {
      loading.setText(errorMessage(error));
      loading.addClass('aktar-error');
    }
  }

  private objectRows(destination: DestinationConfig, objects: BucketObject[], usage: Map<string, RemoteFileUsage>): void {
    const client = this.plugin.storage(destination);
    for (const object of objects) {
      const used = usage.get(usageId(destination.id, object.key));
      const detail = [formatBytes(object.size), formatDate(object.lastModified)].filter(Boolean).join(' · ');
      this.row({ destinationId: destination.id, key: object.key, url: client.publicURL(object.key) }, detail, (row) => {
        if (!used) row.createSpan({ cls: 'aktar-badge aktar-badge-muted', text: t('Unused') });
      });
    }
  }

  private async findUnused(destination: DestinationConfig, folder: string): Promise<void> {
    this.body.empty();
    const status = this.body.createDiv({ cls: 'aktar-muted', text: t('Listing {0}…', folder) });
    try {
      const client = this.plugin.storage(destination);
      this.plugin.usage.invalidate();
      const [objects, usage] = await Promise.all([
        client.listAll(folder, (count) => status.setText(t('Listing {0}… {1} files', folder, count))),
        this.plugin.usage.get(),
      ]);
      const unused = objects.filter((o) => !usage.has(usageId(destination.id, o.key)));
      status.remove();
      const back = this.body.createEl('button', { text: t('Back') });
      back.onClickEvent(() => this.render());
      if (unused.length === 0) {
        this.body.createDiv({ cls: 'aktar-empty', text: t('Every file in {0} is used by a note.', folder) });
        return;
      }
      const total = unused.reduce((sum, o) => sum + o.size, 0);
      this.body.createEl('p', {
        text: t('{0} in {1} aren’t linked from any note in this vault ({2}). Notes in other vaults or apps may still use them.', plural(unused.length, '{0} file', '{0} files'), folder, formatBytes(total)),
      });
      const remove = this.body.createEl('button', { cls: 'mod-warning', text: t('Delete all unused…') });
      remove.onClickEvent(() =>
        new ConfirmModal(this.app, {
          title: t('Delete {0} from the bucket?', plural(unused.length, '{0} file', '{0} files')),
          body: t('No note in this vault links them. This can’t be undone.'),
          confirm: t('Delete'),
          danger: true,
          onConfirm: async () => {
            let deleted = 0;
            for (const object of unused) {
              try {
                await client.delete(object.key);
                deleted++;
              } catch (error) {
                new Notice(errorMessage(error));
                break;
              }
            }
            new Notice(plural(deleted, 'Deleted {0} file.', 'Deleted {0} files.'));
            this.render();
          },
        }).open(),
      );
      for (const object of unused) {
        const file = { destinationId: destination.id, key: object.key, url: client.publicURL(object.key) };
        this.row(file, `${object.key.slice(folder.length)} · ${formatBytes(object.size)}`);
      }
    } catch (error) {
      status.setText(errorMessage(error));
      status.addClass('aktar-error');
    }
  }

  // MARK: Uploads

  private renderQueue(): void {
    const jobs = this.plugin.queue.mine;
    if (jobs.length === 0) {
      const empty = this.body.createDiv({ cls: 'aktar-empty' });
      setIcon(empty.createDiv({ cls: 'aktar-empty-icon' }), 'check-circle');
      empty.createEl('p', { text: t('Nothing waiting to upload.') });
      return;
    }
    const tools = this.body.createDiv({ cls: 'aktar-tools' });
    tools.createEl('button', { text: t('Retry all') }).onClickEvent(() => this.plugin.queue.retryAll());
    if (jobs.some((job) => job.state === 'failed')) {
      tools.createEl('button', { text: t('Keep failed ones in the vault') }).onClickEvent(async () => {
        const kept = await this.plugin.queue.keepFailedLocally();
        new Notice(plural(kept, 'Saved {0} file into the vault.', 'Saved {0} files into the vault.'));
      });
    }
    for (const job of jobs) {
      const row = this.body.createDiv({ cls: 'aktar-row' });
      setIcon(row.createDiv({ cls: 'aktar-thumb' }), job.state === 'failed' ? 'alert-triangle' : job.state === 'uploading' ? 'loader' : 'clock');
      const text = row.createDiv({ cls: 'aktar-row-text' });
      text.createDiv({ cls: 'aktar-row-name', text: job.filename });
      const state = job.state === 'failed' ? (job.error ?? t('Failed')) : job.state === 'uploading' ? t('Uploading') : job.error ? t('Waiting to try again: {0}', job.error) : t('Waiting');
      text.createDiv({ cls: 'aktar-row-detail', text: `${formatBytes(job.byteSize)} · ${state}` });
      row.addClass('is-clickable');
      row.onClickEvent(() => void this.app.workspace.openLinkText(job.notePath, '', false));
    }
  }
}
