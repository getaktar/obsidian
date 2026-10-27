import { getLanguage, MarkdownView, Notice, Platform, Plugin, requestUrl, TFile, type Editor } from 'obsidian';

import { plural, setLanguage, t } from './core/i18n.ts';
import { findPlaceholder, linkMatcher, type LinkMatcher } from './core/links.ts';
import type { VaultContext } from './core/objectKey.ts';
import { StorageError, type DestinationConfig, type StorageCredentials } from './core/types.ts';
import { registerEditorMenus } from './editor/menu.ts';
import { registerPasteAndDrop, uploadIntoEditor } from './editor/paste.ts';
import { RemoteMediaRenderer } from './editor/render.ts';
import { AutoMover } from './features/autoMove.ts';
import type { MoveRecord } from './features/move.ts';
import { MoveModal } from './features/moveModal.ts';
import { bringBackNote, undoLastMove } from './features/restore.ts';
import { UsageIndex } from './features/usage.ts';
import { VaultBackup } from './features/backup.ts';
import { PublishModal, unpublishNote, isPublished } from './features/publish.ts';
import { processImage } from './upload/imageProcessing.ts';
import { resolveContentType } from './core/contentType.ts';
import { formatBytes } from './ui/format.ts';
import { AppBridge } from './bridge/bridge.ts';
import { S3Client, type HttpClient } from './s3/client.ts';
import type { Storage } from './storage.ts';
import { DEFAULT_SETTINGS, normalizeSettings, type AktarSettings } from './settings.ts';
import { CredentialStore } from './store/credentials.ts';
import { ImportDestinationModal } from './ui/importModal.ts';
import { AktarSettingTab } from './ui/settingTab.ts';
import { UploadQueue } from './upload/queue.ts';
import { RESUME_EVERY_MS } from './upload/retryPolicy.ts';
import { uploadFile, type UploadOutcome } from './upload/uploader.ts';
import { LIBRARY_VIEW, LibraryView } from './views/library.ts';

/** Obsidian's requestUrl as the S3 client's HTTP call: not bound by CORS, the same on desktop and mobile. */
const obsidianHttp: HttpClient = async (request) => {
  const response = await requestUrl({ url: request.url, method: request.method, headers: request.headers, body: request.body, throw: false });
  let text = '';
  try {
    text = request.method === 'HEAD' ? '' : response.text;
  } catch {
    text = '';
  }
  let arrayBuffer = new ArrayBuffer(0);
  try {
    arrayBuffer = response.arrayBuffer;
  } catch {
    // No body (HEAD, 204).
  }
  return { status: response.status, headers: response.headers ?? {}, text, arrayBuffer };
};

export default class AktarPlugin extends Plugin {
  settings: AktarSettings = { ...DEFAULT_SETTINGS };
  credentials!: CredentialStore;
  queue!: UploadQueue;
  renderer!: RemoteMediaRenderer;
  usage!: UsageIndex;
  bridge!: AppBridge;
  backup!: VaultBackup;
  autoMover: AutoMover | null = null;
  deviceId = '';
  private statusBar: HTMLElement | null = null;

  async onload(): Promise<void> {
    setLanguage(getLanguage());
    this.credentials = new CredentialStore(this.app);
    this.deviceId = this.loadDeviceId();
    await this.loadSettings();

    this.queue = new UploadQueue(this);
    this.renderer = new RemoteMediaRenderer(this);
    this.usage = new UsageIndex(this);
    this.bridge = new AppBridge(this);
    this.backup = new VaultBackup(this);

    this.registerView(LIBRARY_VIEW, (leaf) => new LibraryView(leaf, this));
    this.addSettingTab(new AktarSettingTab(this.app, this));
    this.addRibbonIcon('cloud-upload', t('Aktar library'), () => void this.openLibrary());

    registerPasteAndDrop(this);
    registerEditorMenus(this);
    this.registerCommands();
    this.registerMarkdownPostProcessor((element) => this.renderer.process(element));

    this.registerObsidianProtocolHandler('aktar-import', (params) => {
      new ImportDestinationModal(this.app, this, typeof params.link === 'string' ? params.link : '').open();
    });

    if (Platform.isDesktop) {
      this.statusBar = this.addStatusBarItem();
      this.statusBar.addClass('aktar-status');
      this.statusBar.onClickEvent(() => void this.openLibrary('queue'));
    }

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') this.queue.renameNote(oldPath, file);
      }),
    );
    this.registerDomEvent(window, 'online', () => this.queue.retryAll());

    this.app.workspace.onLayoutReady(async () => {
      this.bridge.start();
      this.renderer.start();
      await this.queue.load();
      this.register(this.queue.onChange(() => this.updateStatusBar()));
      this.updateStatusBar();
      this.queue.resume();
      this.registerInterval(window.setInterval(() => this.queue.resume(), RESUME_EVERY_MS));
      new AutoMover(this).start();
      this.backup.start();
      if (!this.settings.welcomed && this.settings.destinations.length === 0) {
        this.settings.welcomed = true;
        await this.saveSettings();
        new Notice(t('Aktar is ready. Add your bucket in Settings > Aktar, or import it from an Aktar app with a transfer code.'), 12_000);
      }
    });
  }

  onunload(): void {
    this.renderer?.stop();
  }

  // MARK: Settings and destinations

  async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.renderer?.refresh();
    this.usage?.invalidate();
  }

  private loadDeviceId(): string {
    const stored = this.app.loadLocalStorage('aktar-device-id');
    if (typeof stored === 'string' && stored) return stored;
    const id = globalThis.crypto.randomUUID();
    this.app.saveLocalStorage('aktar-device-id', id);
    return id;
  }

  destination(id: string | null | undefined): DestinationConfig | null {
    return this.settings.destinations.find((d) => d.id === id) ?? null;
  }

  get defaultDestination(): DestinationConfig | null {
    return this.destination(this.settings.defaultDestinationId) ?? this.settings.destinations[0] ?? null;
  }

  /**
   * How to reach the destination from this device: through the Aktar app
   * when it's connected and has it, otherwise straight to the bucket with
   * this device's keys. Throws `credentialsMissing` when neither works, or
   * a network error when the destination comes from the app and the app
   * isn't running (uploads then wait for it).
   */
  storage(destination: DestinationConfig): Storage {
    const viaApp = this.bridge.storageFor(destination);
    if (viaApp) return viaApp;
    const credentials = this.credentials.get(destination.id);
    if (credentials) return new S3Client(destination, credentials, obsidianHttp);
    if (destination.fromApp && this.bridge.configured) {
      throw new StorageError({ kind: 'network', message: t('Aktar isn’t running, or its local API is off.') });
    }
    throw new StorageError({ kind: 'credentialsMissing', destination: destination.name });
  }

  /** Straight to the bucket with this device's keys, or null without them. */
  directStorage(destination: DestinationConfig): S3Client | null {
    const credentials = this.credentials.get(destination.id);
    return credentials ? new S3Client(destination, credentials, obsidianHttp) : null;
  }

  clientWith(destination: DestinationConfig, credentials: StorageCredentials): S3Client {
    return new S3Client(destination, credentials, obsidianHttp);
  }

  /** Files can go to this destination from this device, now or once the app is running. */
  canUpload(destination: DestinationConfig): boolean {
    return this.credentials.has(destination.id) || this.bridge.knows(destination.id) || Boolean(destination.fromApp && this.bridge.configured);
  }

  /** How links to every destination are recognized in notes. */
  matchers(): LinkMatcher[] {
    return this.settings.destinations.map((d) => linkMatcher(d.id, d.publicBaseURL)).filter((m): m is LinkMatcher => m !== null);
  }

  async saveDestination(destination: DestinationConfig, credentials: StorageCredentials | null): Promise<void> {
    const index = this.settings.destinations.findIndex((d) => d.id === destination.id);
    if (index === -1) this.settings.destinations.push(destination);
    else this.settings.destinations[index] = destination;
    if (!this.destination(this.settings.defaultDestinationId)) this.settings.defaultDestinationId = destination.id;
    if (credentials) this.credentials.set(destination.id, credentials);
    await this.saveSettings();
  }

  async removeDestination(id: string): Promise<void> {
    this.settings.destinations = this.settings.destinations.filter((d) => d.id !== id);
    this.credentials.remove(id);
    if (this.settings.defaultDestinationId === id) this.settings.defaultDestinationId = this.settings.destinations[0]?.id ?? null;
    await this.saveSettings();
  }

  // MARK: Uploading

  vaultContext(notePath: string): VaultContext {
    const slash = notePath.lastIndexOf('/');
    const name = notePath.slice(slash + 1).replace(/\.md$/i, '');
    return { vault: this.app.vault.getName(), note: name, noteFolder: slash === -1 ? '' : notePath.slice(0, slash) };
  }

  templateFor(destination: DestinationConfig): string {
    return this.settings.keyTemplate.trim() || destination.objectPathTemplate;
  }

  upload(request: {
    data: ArrayBuffer;
    filename: string;
    destination: DestinationConfig;
    client: Storage;
    notePath: string;
    stable?: boolean;
    date?: Date;
    onProgress?: (fraction: number) => void;
  }): Promise<UploadOutcome> {
    const settings = this.settings;
    const processing = { format: settings.imageFormat, maxEdge: settings.imageMaxEdge, quality: settings.imageQuality };
    return uploadFile({
      ...request,
      template: this.templateFor(request.destination),
      vault: this.vaultContext(request.notePath),
      removeLocation: settings.removeLocation,
      // Through the app, its own image settings for the destination apply instead.
      processImage: request.client.kind === 's3' ? (data, filename) => processImage(data, filename, resolveContentType(filename), processing) : undefined,
    });
  }

  /**
   * Puts `markup` where the upload's placeholder is: through the editor
   * when the note is open (the cursor stays and undo works), otherwise in
   * the file. False when the placeholder is gone.
   */
  async replacePlaceholder(notePath: string, id: string, markup: string): Promise<boolean> {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || view.file?.path !== notePath) continue;
      const editor = view.editor;
      const range = findPlaceholder(editor.getValue(), id);
      if (!range) continue;
      editor.replaceRange(markup, editor.offsetToPos(range.start), editor.offsetToPos(range.end), 'aktar');
      return true;
    }
    const file = this.app.vault.getFileByPath(notePath);
    if (!file) return false;
    let placed = false;
    await this.app.vault.process(file, (text) => {
      const range = findPlaceholder(text, id);
      if (!range) return text;
      placed = true;
      return text.slice(0, range.start) + markup + text.slice(range.end);
    });
    return placed;
  }

  // MARK: Move journal

  /**
   * Every move, newest last, so it can be undone: where each file was in
   * the vault and where it went. Kept in the plugin folder (per device),
   * the last 20 moves.
   */
  private get movesPath(): string {
    return `${this.manifest.dir}/moves.json`;
  }

  private async readMoves(): Promise<MoveRecord[][]> {
    try {
      if (!(await this.app.vault.adapter.exists(this.movesPath))) return [];
      const parsed = JSON.parse(await this.app.vault.adapter.read(this.movesPath));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async recordMove(records: MoveRecord[]): Promise<void> {
    const moves = await this.readMoves();
    moves.push(records);
    await this.app.vault.adapter.write(this.movesPath, JSON.stringify(moves.slice(-20)));
  }

  async lastMove(): Promise<MoveRecord[] | null> {
    const moves = await this.readMoves();
    return moves[moves.length - 1] ?? null;
  }

  async forgetLastMove(): Promise<void> {
    const moves = await this.readMoves();
    moves.pop();
    await this.app.vault.adapter.write(this.movesPath, JSON.stringify(moves));
  }

  // MARK: Commands and views

  private registerCommands(): void {
    this.addCommand({
      id: 'upload-file',
      name: t('Upload a file into this note'),
      icon: 'upload',
      editorCallback: (editor: Editor, info) => {
        if (info.file) this.pickAndUpload(editor, info.file.path);
      },
    });
    this.addCommand({
      id: 'move-note-attachments',
      name: t('Move this note’s attachments to the bucket'),
      icon: 'cloud-upload',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) new MoveModal(this.app, this, { kind: 'notes', notes: [file] }).open();
        return true;
      },
    });
    this.addCommand({
      id: 'move-all-attachments',
      name: t('Move attachments to the bucket…'),
      icon: 'cloud-upload',
      callback: () => new MoveModal(this.app, this, { kind: 'vault' }).open(),
    });
    this.addCommand({
      id: 'bring-back-note',
      name: t('Bring this note’s files back into the vault'),
      icon: 'cloud-download',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void bringBackNote(this, file);
        return true;
      },
    });
    this.addCommand({
      id: 'undo-last-move',
      name: t('Undo the last move to the bucket'),
      icon: 'undo-2',
      callback: () => void undoLastMove(this),
    });
    this.addCommand({
      id: 'publish-note',
      name: t('Publish this note as a web page'),
      icon: 'globe',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md' || !this.defaultDestination) return false;
        if (!checking) new PublishModal(this.app, this, file).open();
        return true;
      },
    });
    this.addCommand({
      id: 'unpublish-note',
      name: t('Take down this note’s web page'),
      icon: 'globe-lock',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md' || !isPublished(this, file)) return false;
        if (!checking) void unpublishNote(this, file);
        return true;
      },
    });
    this.addCommand({
      id: 'backup-now',
      name: t('Back up the vault now'),
      icon: 'archive',
      callback: async () => {
        const notice = new Notice(t('Backing up the vault…'), 0);
        try {
          const result = await this.backup.run((text) => notice.setMessage(text));
          notice.setMessage(t('The vault is backed up: {0} files, {1}.', result.files, formatBytes(result.bytes)));
        } catch (error) {
          notice.setMessage(t('The vault backup failed: {0}', error instanceof Error ? error.message : String(error)));
        }
        window.setTimeout(() => notice.hide(), 8000);
      },
    });
    this.addCommand({ id: 'open-library', name: t('Open the library'), icon: 'library', callback: () => void this.openLibrary() });
    this.addCommand({
      id: 'retry-uploads',
      name: t('Retry uploads'),
      icon: 'refresh-cw',
      callback: () => {
        this.queue.retryAll();
        new Notice(t('Trying the uploads again.'));
      },
    });
    this.addCommand({
      id: 'keep-failed-locally',
      name: t('Save failed uploads into the vault instead'),
      icon: 'hard-drive-download',
      callback: async () => {
        const kept = await this.queue.keepFailedLocally();
        new Notice(plural(kept, 'Saved {0} file into the vault.', 'Saved {0} files into the vault.'));
      },
    });
    this.addCommand({
      id: 'import-destination',
      name: t('Add a destination from an Aktar app'),
      icon: 'qr-code',
      callback: () => new ImportDestinationModal(this.app, this).open(),
    });
  }

  /** The system file picker (Files on iOS, the document picker on Android), then the usual upload. */
  pickAndUpload(editor: Editor, notePath: string): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      if (files.length > 0) void uploadIntoEditor(this, files, editor, notePath);
    });
    input.click();
  }

  async openLibrary(tab?: 'vault' | 'bucket' | 'queue'): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(LIBRARY_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: LIBRARY_VIEW, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (tab && leaf.view instanceof LibraryView) leaf.view.show(tab);
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;
    const jobs = this.queue.mine;
    const failed = jobs.filter((job) => job.state === 'failed').length;
    const active = jobs.length - failed;
    this.statusBar.empty();
    if (jobs.length === 0) return;
    const text = [active > 0 ? t('Aktar: {0} uploading', active) : '', failed > 0 ? t('{0} failed', failed) : ''].filter(Boolean).join(' · ');
    this.statusBar.setText(text);
    this.statusBar.toggleClass('aktar-status-failed', failed > 0);
  }
}
