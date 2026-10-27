import { Component, MarkdownRenderer, Modal, Notice, Setting, TFile, type App } from 'obsidian';

import { t } from '../core/i18n.ts';
import { applyReplacements, findLocalReferences, isEmbeddable, matchRemoteURL, remoteMarkup } from '../core/links.ts';
import { makeShortCode } from '../core/shortKeys.ts';
import { errorMessage, type DestinationConfig } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import type { Storage } from '../storage.ts';
import { pageHTML } from './publishTemplate.ts';

/** The note property that remembers where a note was published, so publishing again updates the same page. */
export const PUBLISHED_PROPERTY = 'aktar-published';
const TEMPORARY_SECONDS = 604_800;

function slug(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'note';
}

/**
 * Publishing goes straight to the bucket with this device's keys: the page
 * has to be served to be read, and the Aktar app (rightly) serves HTML only
 * as a download.
 */
function publishingStorage(plugin: AktarPlugin, destination: DestinationConfig): Storage | null {
  return plugin.directStorage(destination);
}

/** Where the note is published, if it is: its key in the default destination. */
function publishedKey(plugin: AktarPlugin, note: TFile): { destinationId: string; key: string } | null {
  const value: unknown = plugin.app.metadataCache.getFileCache(note)?.frontmatter?.[PUBLISHED_PROPERTY];
  return typeof value === 'string' ? matchRemoteURL(value, plugin.matchers()) : null;
}

/**
 * The note as a page: its attachments uploaded (moved copies, the note
 * itself isn't changed), rendered the way Obsidian renders it, cleaned of
 * anything that only works inside Obsidian, and wrapped in a page that can
 * run no script.
 */
async function renderPage(plugin: AktarPlugin, note: TFile, storage: Storage, destination: DestinationConfig, signed: boolean): Promise<string> {
  const vault = plugin.app.vault;
  let markdown = await vault.read(note);
  markdown = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');

  // Attachments that are still local go up first, under the same stable keys a move would use.
  const replacements = [];
  for (const reference of findLocalReferences(markdown)) {
    const file = plugin.app.metadataCache.getFirstLinkpathDest(reference.linkpath, note.path);
    if (!file || file.extension === 'md' || !isEmbeddable(file.name)) continue;
    const outcome = await plugin.upload({
      data: await vault.readBinary(file),
      filename: file.name,
      destination,
      client: storage,
      notePath: note.path,
      stable: true,
      date: new Date(file.stat.ctime),
    });
    replacements.push({ start: reference.start, end: reference.end, text: remoteMarkup(outcome.url, outcome.filename, reference) });
  }
  markdown = applyReplacements(markdown, replacements);

  const container = createDiv();
  const component = new Component();
  component.load();
  try {
    await MarkdownRenderer.render(plugin.app, markdown, container, note.path, component);
  } finally {
    component.unload();
  }
  await clean(plugin, container, signed);
  return pageHTML({ title: note.basename, body: container.innerHTML, date: new Date(), lang: document.documentElement.lang || 'en' });
}

async function clean(plugin: AktarPlugin, root: HTMLElement, signed: boolean): Promise<void> {
  root.querySelectorAll('script, iframe, object, embed, form, input, button, .frontmatter-container, .metadata-container, .copy-code-button, .edit-block-button, .collapse-indicator').forEach((el) => el.remove());
  // Links to other notes only work inside the vault.
  root.querySelectorAll('a.internal-link').forEach((a) => a.replaceWith(createSpan({ text: a.textContent ?? '' })));
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    for (const attribute of Array.from(el.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || name === 'contenteditable' || name === 'draggable') el.removeAttribute(attribute.name);
      if ((name === 'href' || name === 'src') && /^\s*(javascript|app|capacitor|file):/i.test(attribute.value)) el.removeAttribute(attribute.name);
    }
  }
  // What the plugin showed from its cache or signed for the screen goes back to the file's own address.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-aktar-src]'))) {
    el.setAttribute('src', el.getAttribute('data-aktar-src') ?? '');
    el.removeAttribute('data-aktar-src');
  }
  // Local files that weren't uploaded (not an image or media) can't be shown outside the vault.
  root.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    if (!/^https?:/i.test(src)) img.remove();
  });
  if (!signed) return;
  // A private bucket: every file on the page gets a link valid as long as the page's.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('img[src], video[src], audio[src], source[src]'))) {
    const src = el.getAttribute('src') ?? '';
    const hit = matchRemoteURL(src, plugin.matchers());
    const destination = hit ? plugin.destination(hit.destinationId) : null;
    if (!hit || !destination) continue;
    try {
      el.setAttribute('src', await plugin.storage(destination).temporaryLink(hit.key, TEMPORARY_SECONDS));
    } catch {
      el.remove();
    }
  }
}

export async function publishNote(plugin: AktarPlugin, note: TFile, mode: 'permanent' | 'temporary'): Promise<string> {
  const destination = plugin.defaultDestination;
  if (!destination) throw new Error(t('Add a destination first.'));
  const storage = publishingStorage(plugin, destination);
  if (!storage) throw new Error(t('Publishing needs this device’s keys for “{0}”. Add them in Settings > Aktar.', destination.name));
  const signed = mode === 'temporary' || Boolean(destination.private);
  const existing = publishedKey(plugin, note);
  const key =
    existing && existing.destinationId === destination.id
      ? existing.key
      : `published/${slug(plugin.app.vault.getName())}/${slug(note.basename)}-${makeShortCode()}.html`;
  const html = await renderPage(plugin, note, storage, destination, signed);
  const bytes = new TextEncoder().encode(html);
  await storage.upload(key, bytes.buffer, { contentType: 'text/html; charset=utf-8', inline: true });
  const publicURL = storage.publicURL(key);
  await plugin.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
    frontmatter[PUBLISHED_PROPERTY] = publicURL;
  });
  plugin.usage.invalidate();
  return signed ? storage.temporaryLink(key, TEMPORARY_SECONDS) : publicURL;
}

export async function unpublishNote(plugin: AktarPlugin, note: TFile): Promise<void> {
  const published = publishedKey(plugin, note);
  const destination = published ? plugin.destination(published.destinationId) : null;
  if (!published || !destination) {
    new Notice(t('This note isn’t published.'));
    return;
  }
  try {
    await plugin.storage(destination).delete(published.key);
    await plugin.app.fileManager.processFrontMatter(note, (frontmatter: Record<string, unknown>) => {
      delete frontmatter[PUBLISHED_PROPERTY];
    });
    new Notice(t('The page is taken down.'));
  } catch (error) {
    new Notice(errorMessage(error));
  }
}

export function isPublished(plugin: AktarPlugin, note: TFile): boolean {
  return publishedKey(plugin, note) !== null;
}

/** Asks how the page should be shared, then publishes and copies the link. */
export class PublishModal extends Modal {
  private readonly plugin: AktarPlugin;
  private readonly note: TFile;

  constructor(app: App, plugin: AktarPlugin, note: TFile) {
    super(app);
    this.plugin = plugin;
    this.note = note;
  }

  onOpen(): void {
    this.modalEl.addClass('aktar-modal');
    this.setTitle(t('Publish “{0}”', this.note.basename));
    const { contentEl } = this;
    const destination = this.plugin.defaultDestination;
    const privateBucket = Boolean(destination?.private);
    const again = isPublished(this.plugin, this.note);
    contentEl.createEl('p', {
      cls: 'aktar-muted',
      text: again
        ? t('The note is published already. Publishing again updates the same page.')
        : t('The note becomes a web page in your bucket. Its images and media go along; links to other notes become plain text. Nothing in the note changes except a property with the page’s address.'),
    });
    let mode: 'permanent' | 'temporary' = privateBucket ? 'temporary' : 'permanent';
    new Setting(contentEl)
      .setName(t('Link'))
      .setDesc(privateBucket ? t('The bucket is private, so the link works for 7 days.') : '')
      .addDropdown((dropdown) => {
        if (!privateBucket) dropdown.addOption('permanent', t('Permanent'));
        dropdown.addOption('temporary', t('Works for 7 days'));
        dropdown.setValue(mode).onChange((value) => (mode = value === 'temporary' ? 'temporary' : 'permanent'));
      });
    const status = contentEl.createDiv({ cls: 'aktar-error' });
    const buttons = new Setting(contentEl);
    if (again) {
      buttons.addButton((button) =>
        button
          .setWarning()
          .setButtonText(t('Take down'))
          .onClick(async () => {
            await unpublishNote(this.plugin, this.note);
            this.close();
          }),
      );
    }
    buttons.addButton((button) =>
      button
        .setCta()
        .setButtonText(again ? t('Update page') : t('Publish'))
        .onClick(async () => {
          button.setDisabled(true);
          status.removeClass('aktar-ok');
          status.setText(t('Publishing…'));
          try {
            const url = await publishNote(this.plugin, this.note, mode);
            await navigator.clipboard.writeText(url);
            this.close();
            new Notice(mode === 'temporary' ? t('Published. The link is copied and works for 7 days.') : t('Published. The link is copied.'));
          } catch (error) {
            status.setText(errorMessage(error));
            button.setDisabled(false);
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

