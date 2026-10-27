import { Notice, TFile } from 'obsidian';

import { plural, t } from '../core/i18n.ts';
import type AktarPlugin from '../main.ts';
import { executeMove, isAttachment, notesLinkingTo, planMove } from './move.ts';

/** How long a new file may wait for a note to link it before it's left alone. */
const WAIT_FOR_LINK_MS = 20_000;
const CHECK_EVERY_MS = 1_000;
/** New files are moved together when they arrive close together (a multi-photo attach). */
const BATCH_DELAY_MS = 1_500;

/**
 * "Move new attachments to the bucket": any file that lands in the vault
 * (attached on a phone, saved by another plugin, pasted with uploading
 * off) is moved as soon as a note embeds it. A file no note links within
 * twenty seconds is left where it is: it was put there on purpose.
 *
 * On a vault synced between devices each one sees the file arrive. The
 * move's keys only depend on the file, so whichever device gets there
 * writes the same object and the same links.
 */
export class AutoMover {
  private readonly plugin: AktarPlugin;
  private waiting = new Map<string, number>();
  private ready = new Set<string>();
  private ignored = new Set<string>();
  private batchTimer: number | null = null;
  private running = false;

  constructor(plugin: AktarPlugin) {
    this.plugin = plugin;
    plugin.autoMover = this;
  }

  start(): void {
    this.plugin.registerEvent(
      this.plugin.app.vault.on('create', (file) => {
        if (file instanceof TFile) this.consider(file);
      }),
    );
    this.plugin.register(() => {
      for (const timer of this.waiting.values()) window.clearInterval(timer);
      if (this.batchTimer !== null) window.clearTimeout(this.batchTimer);
    });
  }

  /** A file the plugin itself is about to write (bringing one back), which mustn't go straight back up. */
  ignore(path: string): void {
    this.ignored.add(path);
    window.setTimeout(() => this.ignored.delete(path), WAIT_FOR_LINK_MS * 2);
  }

  private applies(file: TFile): boolean {
    const settings = this.plugin.settings;
    if (!settings.autoMove || !isAttachment(file) || this.ignored.has(file.path)) return false;
    if (file.path.startsWith(this.plugin.app.vault.configDir + '/')) return false;
    const folder = settings.autoMoveFolder.trim().replace(/^\/+|\/+$/g, '');
    if (folder && !file.path.startsWith(folder + '/')) return false;
    const destination = this.plugin.defaultDestination;
    return Boolean(destination && this.plugin.canUpload(destination));
  }

  private consider(file: TFile): void {
    if (!this.applies(file) || this.waiting.has(file.path)) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const current = this.plugin.app.vault.getFileByPath(file.path);
      const linked = current && notesLinkingTo(this.plugin, current).length > 0;
      if (!current || linked || Date.now() - started > WAIT_FOR_LINK_MS) {
        window.clearInterval(timer);
        this.waiting.delete(file.path);
        if (current && linked) this.queue(current.path);
      }
    }, CHECK_EVERY_MS);
    this.waiting.set(file.path, timer);
  }

  private queue(path: string): void {
    this.ready.add(path);
    if (this.batchTimer !== null) window.clearTimeout(this.batchTimer);
    this.batchTimer = window.setTimeout(() => {
      this.batchTimer = null;
      void this.flush();
    }, BATCH_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.running) {
      this.batchTimer = window.setTimeout(() => {
        this.batchTimer = null;
        void this.flush();
      }, BATCH_DELAY_MS);
      return;
    }
    const files = [...this.ready].map((path) => this.plugin.app.vault.getFileByPath(path)).filter((f): f is TFile => f !== null);
    this.ready.clear();
    if (files.length === 0) return;
    this.running = true;
    try {
      const plan = await planMove(this.plugin, { kind: 'files', files });
      if (plan.files.length === 0) return;
      const result = await executeMove(this.plugin, plan);
      if (result.failed.length > 0) {
        new Notice(t('Couldn’t move {0} to the bucket: {1}', result.failed[0].file.name, result.failed[0].error), 8000);
      } else if (result.moved + result.reused > 0) {
        new Notice(plural(result.moved + result.reused, 'Moved {0} attachment to the bucket.', 'Moved {0} attachments to the bucket.'));
      }
    } catch (error) {
      console.error('Aktar: moving a new attachment failed', error);
    } finally {
      this.running = false;
    }
  }
}
