import { normalizePath, Notice, TFile } from 'obsidian';

import { t } from '../core/i18n.ts';
import { remoteMarkup } from '../core/links.ts';
import { errorMessage, StorageError } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import { afterFailure } from './retryPolicy.ts';

/**
 * A pasted or dropped file waiting for (or in) its upload. The bytes are in
 * the plugin's folder until the upload is done, so closing Obsidian, going
 * offline or a phone dropping the app loses nothing: the queue picks up
 * where it was on the next start.
 */
export interface UploadJob {
  id: string;
  /** Only the device that queued a job sends it, even if the plugin folder syncs. */
  deviceId: string;
  notePath: string;
  filename: string;
  destinationId: string;
  byteSize: number;
  createdAt: number;
  embed: boolean;
  size: string | null;
  attempts: number;
  state: 'waiting' | 'uploading' | 'failed';
  error?: string;
  /** Failed for a reason that can pass, so it goes again on its own. */
  resumable?: boolean;
  /** The user was told it failed, so they're told once it's up. */
  failureShown?: boolean;
}

const MAX_PARALLEL = 3;

export class UploadQueue {
  private readonly plugin: AktarPlugin;
  private jobs: UploadJob[] = [];
  private running = new Set<string>();
  private retryTimer: number | null = null;
  private listeners = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();

  constructor(plugin: AktarPlugin) {
    this.plugin = plugin;
  }

  private get folder(): string {
    return normalizePath(`${this.plugin.manifest.dir}/queue`);
  }

  private get indexPath(): string {
    return `${this.folder}/index.json`;
  }

  private dataPath(id: string): string {
    return `${this.folder}/${id}.bin`;
  }

  private get adapter() {
    return this.plugin.app.vault.adapter;
  }

  /** This device's jobs, for the status bar and library. */
  get mine(): UploadJob[] {
    return this.jobs.filter((job) => job.deviceId === this.plugin.deviceId);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  async load(): Promise<void> {
    try {
      if (await this.adapter.exists(this.indexPath)) {
        const parsed = JSON.parse(await this.adapter.read(this.indexPath)) as UploadJob[];
        this.jobs = Array.isArray(parsed) ? parsed.map((job) => ({ ...job, state: job.state === 'uploading' ? 'waiting' : job.state })) : [];
      }
    } catch (error) {
      console.error('Aktar: the upload queue could not be read', error);
      this.jobs = [];
    }
    this.changed();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.jobs, null, 1);
    this.saving = this.saving.then(async () => {
      if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
      await this.adapter.write(this.indexPath, snapshot);
    });
    return this.saving;
  }

  /** Keeps the bytes and the job on disk before anything is sent. */
  async add(job: Omit<UploadJob, 'deviceId' | 'attempts' | 'state' | 'createdAt' | 'byteSize'>, data: ArrayBuffer): Promise<void> {
    if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
    await this.adapter.writeBinary(this.dataPath(job.id), data);
    this.jobs.push({ ...job, deviceId: this.plugin.deviceId, attempts: 0, state: 'waiting', createdAt: Date.now(), byteSize: data.byteLength });
    await this.save();
    this.changed();
    this.pump();
  }

  /** Starts what can start: up to three at a time, in the order they came. */
  pump(): void {
    for (const job of this.mine) {
      if (this.running.size >= MAX_PARALLEL) break;
      if (job.state !== 'waiting' || this.running.has(job.id)) continue;
      void this.run(job);
    }
  }

  private async run(job: UploadJob): Promise<void> {
    this.running.add(job.id);
    job.state = 'uploading';
    job.attempts += 1;
    this.changed();
    try {
      const destination = this.plugin.destination(job.destinationId);
      if (!destination) throw new Error(t('The destination for this upload was removed.'));
      const client = this.plugin.storage(destination);
      const data = await this.adapter.readBinary(this.dataPath(job.id));
      const outcome = await this.plugin.upload({ data, filename: job.filename, destination, client, notePath: job.notePath });
      const markup = remoteMarkup(outcome.url, outcome.filename, { embed: job.embed, size: job.size });
      const placed = await this.plugin.replacePlaceholder(job.notePath, job.id, markup);
      if (!placed) {
        await navigator.clipboard.writeText(markup).catch(() => undefined);
        new Notice(t('{0} is uploaded, but its placeholder was gone from the note. The link is on the clipboard.', job.filename));
      } else if (job.failureShown) {
        new Notice(t('{0} is uploaded.', job.filename));
      }
      await this.finish(job);
    } catch (error) {
      this.fail(job, error);
    } finally {
      this.running.delete(job.id);
      this.changed();
      this.pump();
    }
  }

  private async finish(job: UploadJob): Promise<void> {
    this.jobs = this.jobs.filter((j) => j.id !== job.id);
    await this.adapter.remove(this.dataPath(job.id)).catch(() => undefined);
    await this.save();
  }

  /** Tries again soon, later (see retryPolicy.ts) or only when asked, and says why once. */
  private fail(job: UploadJob, error: unknown): void {
    const transient = error instanceof StorageError ? error.isTransient : !(error instanceof Error && /destination/.test(error.message));
    job.error = errorMessage(error);
    const next = afterFailure(job.attempts, transient);
    if ('retryIn' in next) {
      job.state = 'waiting';
      this.scheduleRetry(next.retryIn);
    } else {
      job.state = 'failed';
      job.resumable = next.resumable;
      if (!job.failureShown) new Notice(t('Couldn’t upload {0}: {1}', job.filename, job.error), 10_000);
      job.failureShown = true;
    }
    void this.save();
  }

  private scheduleRetry(delay: number): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    // Jobs that are waiting all go on the next try, whatever their own delay was.
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, delay);
  }

  /** Back online, or asked to: every waiting and failed job of this device goes again. */
  retryAll(): void {
    this.restart(() => true);
  }

  /** On start and every so often: failed jobs that only lost the connection go again. */
  resume(): void {
    this.restart((job) => job.resumable === true);
  }

  private restart(which: (job: UploadJob) => boolean): void {
    for (const job of this.mine) {
      if (job.state === 'failed' && which(job)) {
        job.state = 'waiting';
        job.attempts = 0;
      }
    }
    void this.save();
    this.changed();
    this.pump();
  }

  /**
   * Gives up on the bucket for the failed uploads: each file is saved into
   * the vault like a normal attachment and its placeholder becomes a local
   * embed, so nothing that was pasted is lost.
   */
  async keepFailedLocally(): Promise<number> {
    let kept = 0;
    for (const job of this.mine.filter((j) => j.state === 'failed')) {
      try {
        const data = await this.adapter.readBinary(this.dataPath(job.id));
        const path = await this.plugin.app.fileManager.getAvailablePathForAttachment(job.filename, job.notePath);
        const file = await this.plugin.app.vault.createBinary(path, data);
        const link = this.plugin.app.fileManager.generateMarkdownLink(file, job.notePath, undefined, job.size ?? undefined);
        await this.plugin.replacePlaceholder(job.notePath, job.id, job.embed ? `!${link}` : link);
        await this.finish(job);
        kept++;
      } catch (error) {
        console.error('Aktar: could not keep a failed upload in the vault', error);
      }
    }
    this.changed();
    return kept;
  }

  /** A note was renamed: its jobs follow, so the placeholder is found at the new path. */
  renameNote(oldPath: string, file: TFile): void {
    let touched = false;
    for (const job of this.jobs) {
      if (job.notePath === oldPath) {
        job.notePath = file.path;
        touched = true;
      }
    }
    if (touched) void this.save();
  }
}
