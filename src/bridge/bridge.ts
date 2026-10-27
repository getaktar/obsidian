import { Platform } from 'obsidian';

import { t } from '../core/i18n.ts';
import { DEFAULT_KEY_TEMPLATE } from '../core/objectKey.ts';
import { PROVIDER_PRESETS, type DestinationConfig, type ProviderPreset } from '../core/types.ts';
import type AktarPlugin from '../main.ts';
import { AppClient, AppError, DEFAULT_PORT, nodeHttp, type AppDestination } from './appClient.ts';
import { AppStorage } from './appStorage.ts';

const TOKEN_SECRET = 'aktar-app-token';
const PORT_KEY = 'aktar-app-port';
const ENABLED_KEY = 'aktar-app-enabled';
const REFRESH_MS = 60_000;

export type BridgeState =
  | { kind: 'unavailable' }
  | { kind: 'off' }
  | { kind: 'checking' }
  | { kind: 'connected'; version: string; destinations: AppDestination[] }
  | { kind: 'notRunning' }
  | { kind: 'error'; message: string };

/**
 * The connection to the Aktar app on this computer. When it's there, its
 * destinations are used through it, so this device needs no keys of its
 * own, and uploads show up in Aktar's history and run its hooks. When the
 * app isn't running, a destination that also has keys on this device goes
 * straight to the bucket instead.
 *
 * Pairing is the same as Raycast's: `aktar://connect` with a callback,
 * Aktar asks the user, and opens `obsidian://aktar-connect` with the port
 * and token. Pasting the token from Settings > Integrations, or reusing the
 * CLI's `aktar login`, works too.
 */
export class AppBridge {
  private readonly plugin: AktarPlugin;
  state: BridgeState = { kind: 'off' };
  private client: AppClient | null = null;
  private listeners = new Set<() => void>();

  constructor(plugin: AktarPlugin) {
    this.plugin = plugin;
    if (!Platform.isDesktopApp || !nodeHttp()) this.state = { kind: 'unavailable' };
  }

  get available(): boolean {
    return this.state.kind !== 'unavailable';
  }

  /** A token is saved and the bridge isn't switched off on this device. */
  get configured(): boolean {
    return this.available && this.enabled && Boolean(this.token);
  }

  get enabled(): boolean {
    return this.plugin.app.loadLocalStorage(ENABLED_KEY) !== 'off';
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.plugin.app.saveLocalStorage(ENABLED_KEY, enabled ? 'on' : 'off');
    await this.refresh();
  }

  private get token(): string | null {
    return this.plugin.app.secretStorage.getSecret(TOKEN_SECRET) || null;
  }

  private get port(): number {
    const stored = Number(this.plugin.app.loadLocalStorage(PORT_KEY));
    return Number.isInteger(stored) && stored > 0 && stored < 65536 ? stored : DEFAULT_PORT;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Listeners hear about changes only: a check that finds the same answer says nothing. */
  private set(state: BridgeState): void {
    const changed = JSON.stringify(state) !== JSON.stringify(this.state);
    this.state = state;
    if (changed) for (const listener of this.listeners) listener();
  }

  start(): void {
    if (!this.available) return;
    this.plugin.registerObsidianProtocolHandler('aktar-connect', (params) => void this.paired(params.launchContext));
    this.plugin.registerInterval(window.setInterval(() => void this.refresh(), REFRESH_MS));
    this.plugin.registerDomEvent(window, 'focus', () => {
      if (this.state.kind !== 'connected') void this.refresh();
    });
    void this.refresh();
  }

  /** Asks the Aktar app to pair, which answers on obsidian://aktar-connect. */
  pair(): void {
    window.open(`aktar://connect?callback=${encodeURIComponent('obsidian://aktar-connect')}`);
  }

  private async paired(launchContext: unknown): Promise<void> {
    try {
      const context = JSON.parse(String(launchContext)) as { aktar?: { port?: number; token?: string } };
      const token = context.aktar?.token;
      if (typeof token !== 'string' || !/^[0-9a-f]{32,128}$/i.test(token)) return;
      await this.save(token, context.aktar?.port ?? DEFAULT_PORT);
    } catch {
      // Not a pairing answer.
    }
  }

  /** Saves a connection (pairing, a pasted token or the CLI's) and checks it. */
  async save(token: string, port: number = DEFAULT_PORT): Promise<BridgeState> {
    this.plugin.app.secretStorage.setSecret(TOKEN_SECRET, token.trim());
    this.plugin.app.saveLocalStorage(PORT_KEY, String(port));
    this.plugin.app.saveLocalStorage(ENABLED_KEY, 'on');
    return this.refresh();
  }

  async disconnect(): Promise<void> {
    this.plugin.app.secretStorage.setSecret(TOKEN_SECRET, '');
    this.client = null;
    this.set({ kind: 'off' });
  }

  /** The connection `aktar login` saved for the CLI, if there is one on this computer. */
  async cliConnection(): Promise<{ token: string; port: number } | null> {
    const load = (window as unknown as { require?: (name: string) => unknown }).require;
    try {
      const fs = load?.('fs') as { promises: { readFile(path: string, encoding: string): Promise<string> } };
      const os = load?.('os') as { homedir(): string };
      const path = load?.('path') as { join(...parts: string[]): string };
      const process = (window as unknown as { process?: { platform: string; env: Record<string, string | undefined> } }).process;
      if (!fs || !os || !path || !process) return null;
      const file =
        process.platform === 'win32'
          ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'aktar', 'cli.json')
          : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'aktar', 'cli.json');
      const saved = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { token?: string; port?: number };
      return saved.token ? { token: saved.token, port: saved.port ?? DEFAULT_PORT } : null;
    } catch {
      return null;
    }
  }

  async refresh(): Promise<BridgeState> {
    if (!this.available) return this.state;
    const http = nodeHttp();
    const token = this.token;
    if (!this.enabled || !token || !http) {
      this.client = null;
      this.set({ kind: 'off' });
      return this.state;
    }
    if (!this.client || this.client.connection.token !== token || this.client.connection.port !== this.port) {
      this.client = new AppClient({ token, port: this.port }, http);
    }
    if (this.state.kind !== 'connected') this.set({ kind: 'checking' });
    try {
      const [status, destinations] = await Promise.all([this.client.status(), this.client.destinations()]);
      this.set({ kind: 'connected', version: status.version, destinations });
      await this.adopt(destinations, status.defaultDestinationId);
    } catch (error) {
      if (error instanceof AppError && error.kind === 'notRunning') this.set({ kind: 'notRunning' });
      else this.set({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
    return this.state;
  }

  /**
   * The app's destinations become the plugin's (same IDs as a transfer
   * would give), so the same bucket is one destination on every device:
   * through the app here, with keys on a phone.
   */
  private async adopt(destinations: AppDestination[], defaultId: string | null): Promise<void> {
    const settings = this.plugin.settings;
    let changed = false;
    for (const app of destinations) {
      const id = app.id.toUpperCase();
      const existing = settings.destinations.find((d) => d.id.toUpperCase() === id);
      if (existing) {
        if (existing.name !== app.name || existing.bucket !== app.bucket || existing.publicBaseURL !== app.publicBaseURL || !existing.fromApp) {
          Object.assign(existing, { name: app.name, bucket: app.bucket, publicBaseURL: app.publicBaseURL, fromApp: true });
          changed = true;
        }
        continue;
      }
      const preset: ProviderPreset = (PROVIDER_PRESETS as readonly string[]).includes(app.provider) ? (app.provider as ProviderPreset) : 'customS3';
      const destination: DestinationConfig = {
        id,
        name: app.name,
        preset,
        endpoint: '',
        region: 'auto',
        bucket: app.bucket,
        publicBaseURL: app.publicBaseURL,
        objectPathTemplate: DEFAULT_KEY_TEMPLATE,
        forcePathStyle: false,
        fromApp: true,
      };
      settings.destinations.push(destination);
      changed = true;
    }
    if (!settings.destinations.some((d) => d.id === settings.defaultDestinationId) || (changed && settings.destinations.every((d) => d.fromApp))) {
      const preferred = defaultId?.toUpperCase();
      settings.defaultDestinationId = settings.destinations.find((d) => d.id.toUpperCase() === preferred)?.id ?? settings.destinations[0]?.id ?? null;
      changed = true;
    }
    if (changed) await this.plugin.saveSettings();
  }

  /** The app is connected and has this destination. */
  knows(destinationId: string): boolean {
    return this.state.kind === 'connected' && this.state.destinations.some((d) => d.id.toUpperCase() === destinationId.toUpperCase());
  }

  storageFor(destination: DestinationConfig): AppStorage | null {
    if (!this.client || !this.knows(destination.id)) return null;
    const app = this.state.kind === 'connected' ? this.state.destinations.find((d) => d.id.toUpperCase() === destination.id.toUpperCase()) : undefined;
    return new AppStorage({ ...destination, id: app?.id ?? destination.id }, this.client);
  }

  describe(): string {
    switch (this.state.kind) {
      case 'unavailable':
        return t('Only on desktop.');
      case 'off':
        return t('Not connected.');
      case 'checking':
        return t('Checking…');
      case 'connected':
        return t('Connected to Aktar {0}.', this.state.version);
      case 'notRunning':
        return t('Aktar isn’t running, or its local API is off.');
      case 'error':
        return this.state.message;
    }
  }
}
