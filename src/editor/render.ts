import { requestUrl } from 'obsidian';

import { isImageFilename, mimeTypeForExtension, pathExtension } from '../core/contentType.ts';
import { matchRemoteURL, type LinkMatcher } from '../core/links.ts';
import type AktarPlugin from '../main.ts';
import { MediaCache } from './cache.ts';

const SIGNED_FOR_SECONDS = 3600;
/** A signed URL is renewed when less than this is left of it. */
const RENEW_BEFORE_MS = 10 * 60_000;
const ORIGINAL = 'data-aktar-src';
const MAX_PARALLEL_FETCHES = 3;

/**
 * How files from the bucket show up in notes, in reading view, live
 * preview, hover previews and the library alike:
 *
 * - Images already kept on this device are shown from there (offline too);
 *   others are fetched once in the background and kept.
 * - A private destination's files go through short-lived signed URLs. The
 *   note keeps the plain link, so the signature never ends up in it.
 * - Audio and video embedded with `![](url)` get a player instead of a
 *   broken image.
 *
 * Every `src` that appears in the window is checked, so this follows
 * whatever Obsidian renders, wherever.
 */
export class RemoteMediaRenderer {
  private readonly plugin: AktarPlugin;
  private matchers: LinkMatcher[] = [];
  private observer: MutationObserver | null = null;
  private signed = new Map<string, { url: string; expires: number }>();
  private signing = new Map<string, Promise<string | null>>();
  /** Every URL handed out (signed or blob), to tell them from a new `src` set by Obsidian. */
  private produced = new Set<string>();
  private blobs = new Map<string, string>();
  private fetching = new Set<string>();
  private fetchQueue: { id: string; url: string; key: string }[] = [];
  readonly cache: MediaCache;

  constructor(plugin: AktarPlugin) {
    this.plugin = plugin;
    this.cache = new MediaCache(plugin.app.vault.getName());
  }

  start(): void {
    this.refresh();
    this.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target.instanceOf(HTMLElement)) this.handle(mutation.target);
        for (const node of Array.from(mutation.addedNodes)) {
          if (!node.instanceOf(HTMLElement)) continue;
          this.handle(node);
          node.querySelectorAll<HTMLElement>('img, video, audio, source').forEach((element) => this.handle(element));
        }
      }
    });
    this.observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
    document.body.querySelectorAll<HTMLElement>('img, video, audio, source').forEach((element) => this.handle(element));
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const url of this.blobs.values()) URL.revokeObjectURL(url);
    this.blobs.clear();
  }

  /** Settings changed: destinations, or which of them are private. */
  refresh(): void {
    this.matchers = this.plugin.matchers();
    this.signed.clear();
  }

  /** Reading view and exports, where the observer may not reach. */
  process(element: HTMLElement): void {
    element.querySelectorAll<HTMLElement>('img, video, audio, source').forEach((el) => this.handle(el));
  }

  /** A URL the person can open now: signed for a private destination, as it is otherwise. */
  async openableURL(url: string): Promise<string> {
    const hit = matchRemoteURL(url, this.matchers);
    if (!hit || !this.plugin.destination(hit.destinationId)?.private) return url;
    return (await this.sign(hit.destinationId, hit.key)) ?? url;
  }

  private sign(destinationId: string, key: string): Promise<string | null> {
    const id = `${destinationId}/${key}`;
    const cached = this.signed.get(id);
    if (cached && cached.expires - Date.now() > RENEW_BEFORE_MS) return Promise.resolve(cached.url);
    const pending = this.signing.get(id);
    if (pending) return pending;
    const destination = this.plugin.destination(destinationId);
    if (!destination) return Promise.resolve(null);
    const work = (async () => {
      try {
        const url = await this.plugin.storage(destination).temporaryLink(key, SIGNED_FOR_SECONDS);
        this.signed.set(id, { url, expires: Date.now() + SIGNED_FOR_SECONDS * 1000 });
        this.produced.add(url);
        return url;
      } catch {
        // No keys here and no app: the plain link is all there is.
        return null;
      } finally {
        this.signing.delete(id);
      }
    })();
    this.signing.set(id, work);
    return work;
  }

  private handle(element: HTMLElement): void {
    if (!(element.instanceOf(HTMLImageElement) || element.instanceOf(HTMLMediaElement) || element.instanceOf(HTMLSourceElement))) return;
    const src = element.getAttribute('src');
    if (!src || src.startsWith('data:') || src.startsWith('app:')) return;
    if (this.produced.has(src)) {
      // Ours: only a signed URL about to run out needs anything.
      const original = element.getAttribute(ORIGINAL);
      if (original && !src.startsWith('blob:')) void this.show(element, original);
      return;
    }
    if (src.startsWith('blob:')) return;
    const hit = matchRemoteURL(src, this.matchers);
    if (!hit) return;
    if (element instanceof HTMLImageElement && this.isMedia(hit.key)) {
      this.upgradeToPlayer(element, src, hit.key);
      return;
    }
    element.setAttribute(ORIGINAL, src);
    void this.show(element, src);
  }

  private isMedia(key: string): boolean {
    const mime = mimeTypeForExtension(pathExtension(key)) ?? '';
    return (mime.startsWith('video/') && pathExtension(key).toLowerCase() !== 'ts') || mime.startsWith('audio/');
  }

  private upgradeToPlayer(img: HTMLImageElement, src: string, key: string): void {
    const video = (mimeTypeForExtension(pathExtension(key)) ?? '').startsWith('video/');
    const player = createEl(video ? 'video' : 'audio', { cls: 'aktar-player' });
    player.controls = true;
    player.preload = 'metadata';
    const width = img.getAttribute('width');
    if (width && video) player.setAttribute('width', width);
    player.setAttribute(ORIGINAL, src);
    img.replaceWith(player);
    void this.show(player, src);
  }

  /** Puts the best `src` for `original` on the element: kept copy, signed URL or the plain one. */
  private async show(element: HTMLElement, original: string): Promise<void> {
    const hit = matchRemoteURL(original, this.matchers);
    if (!hit) return;
    const id = `${hit.destinationId}/${hit.key}`;
    const destination = this.plugin.destination(hit.destinationId);
    const caching = this.plugin.settings.offlineCache && isImageFilename(hit.key);
    const apply = (url: string) => {
      if (element.getAttribute(ORIGINAL) !== original) return;
      if (element.getAttribute('src') !== url) element.setAttribute('src', url);
    };

    if (caching) {
      const blobURL = this.blobs.get(id) ?? (await this.fromCache(id));
      if (blobURL) return apply(blobURL);
    }
    let url = original;
    if (destination?.private) url = (await this.sign(hit.destinationId, hit.key)) ?? original;
    apply(url);
    if (caching && navigator.onLine) this.enqueueFetch(id, url, hit.key);
  }

  private async fromCache(id: string): Promise<string | null> {
    const blob = await this.cache.get(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.blobs.set(id, url);
    this.produced.add(url);
    return url;
  }

  private enqueueFetch(id: string, url: string, key: string): void {
    if (this.fetching.has(id) || this.fetchQueue.some((item) => item.id === id)) return;
    this.fetchQueue.push({ id, url, key });
    this.pumpFetches();
  }

  private pumpFetches(): void {
    while (this.fetching.size < MAX_PARALLEL_FETCHES && this.fetchQueue.length > 0) {
      const item = this.fetchQueue.shift();
      if (!item) break;
      this.fetching.add(item.id);
      void this.fetchIntoCache(item).finally(() => {
        this.fetching.delete(item.id);
        this.pumpFetches();
      });
    }
  }

  /** One background download, kept, then shown from the copy wherever the file is on screen. */
  private async fetchIntoCache(item: { id: string; url: string; key: string }): Promise<void> {
    try {
      const response = await requestUrl({ url: item.url, method: 'GET', throw: false });
      if (response.status < 200 || response.status >= 300) return;
      const type = mimeTypeForExtension(pathExtension(item.key)) ?? 'application/octet-stream';
      const blob = new Blob([response.arrayBuffer], { type });
      await this.cache.put(item.id, blob, this.plugin.settings.cacheLimitMB * 1024 * 1024);
      const blobURL = URL.createObjectURL(blob);
      this.blobs.set(item.id, blobURL);
      this.produced.add(blobURL);
      document.querySelectorAll<HTMLElement>(`[${ORIGINAL}]`).forEach((element) => {
        const original = element.getAttribute(ORIGINAL) ?? '';
        const hit = matchRemoteURL(original, this.matchers);
        if (hit && `${hit.destinationId}/${hit.key}` === item.id && element.instanceOf(HTMLImageElement)) element.setAttribute('src', blobURL);
      });
    } catch {
      // Offline or refused: it's fetched again next time it's shown.
    }
  }

  /** Forgets a file (deleted from the bucket, or replaced). */
  async forget(destinationId: string, key: string): Promise<void> {
    const id = `${destinationId}/${key}`;
    const blobURL = this.blobs.get(id);
    if (blobURL) URL.revokeObjectURL(blobURL);
    this.blobs.delete(id);
    await this.cache.delete(id);
  }

  async clearCache(): Promise<void> {
    for (const url of this.blobs.values()) URL.revokeObjectURL(url);
    this.blobs.clear();
    await this.cache.clear();
  }
}
