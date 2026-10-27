import { TFile } from 'obsidian';

import { findRemoteLinks } from '../core/links.ts';
import type AktarPlugin from '../main.ts';

export interface RemoteFileUsage {
  destinationId: string;
  key: string;
  url: string;
  /** Paths of the notes that link it. */
  notes: Set<string>;
  embedded: boolean;
}

export const usageId = (destinationId: string, key: string) => `${destinationId}/${key}`;

/**
 * Which bucket files the vault's notes point to, and from where. Built by
 * reading every note (cached reads, so it's quick after the first time) and
 * kept until a note changes.
 */
export class UsageIndex {
  private readonly plugin: AktarPlugin;
  private cache: Map<string, RemoteFileUsage> | null = null;
  private building: Promise<Map<string, RemoteFileUsage>> | null = null;

  constructor(plugin: AktarPlugin) {
    this.plugin = plugin;
    const invalidate = (file: unknown) => {
      if (file instanceof TFile && file.extension === 'md') this.invalidate();
    };
    plugin.registerEvent(plugin.app.vault.on('modify', invalidate));
    plugin.registerEvent(plugin.app.vault.on('delete', invalidate));
    plugin.registerEvent(plugin.app.vault.on('rename', invalidate));
  }

  invalidate(): void {
    this.cache = null;
  }

  async get(): Promise<Map<string, RemoteFileUsage>> {
    if (this.cache) return this.cache;
    if (!this.building) {
      this.building = this.build().finally(() => (this.building = null));
    }
    return this.building;
  }

  private async build(): Promise<Map<string, RemoteFileUsage>> {
    const matchers = this.plugin.matchers();
    const usage = new Map<string, RemoteFileUsage>();
    if (matchers.length > 0) {
      for (const note of this.plugin.app.vault.getMarkdownFiles()) {
        const text = await this.plugin.app.vault.cachedRead(note);
        for (const link of findRemoteLinks(text, matchers, { includeCode: true })) {
          const id = usageId(link.destinationId, link.key);
          const entry = usage.get(id) ?? { destinationId: link.destinationId, key: link.key, url: link.url, notes: new Set<string>(), embedded: false };
          entry.notes.add(note.path);
          entry.embedded ||= link.embed;
          usage.set(id, entry);
        }
      }
    }
    this.cache = usage;
    return usage;
  }
}
