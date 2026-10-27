# Changelog

## 0.2.3

### Changed

- **Settings in Obsidian's search:** from Obsidian 1.13 on, Aktar's settings are found by settings search. Older versions keep the same settings tab, so the plugin still works from 1.11.4.
- Buttons that remove something use Obsidian 1.13's destructive style.
- Destinations added from the command palette show up in an open settings tab right away.

## 0.2.2

### Changed

- **Signed release files:** `main.js`, `manifest.json` and `styles.css` come with a GitHub artifact attestation, so anyone can check they were built from this repository: `gh attestation verify main.js -R getaktar/obsidian`.
- The README says why the plugin lists the vault's files and when it uses the clipboard.

### Fixed

- The backup setting names the vault's own configuration folder, not always `.obsidian`.
- Changes from the Obsidian directory's review: element checks that hold across Obsidian's windows (`instanceOf`), window timers, typed values from storage and front matter, and no control characters or needless escapes in regular expressions.

## 0.2.1

### Fixed

- **Uploads that lost the connection go up on their own:** once the quick retries run out, they're tried again when Obsidian starts and every 15 minutes, not only when the device comes back online. A Wi-Fi without internet or a provider that was down no longer leaves a placeholder until you retry by hand. Uploads stopped by keys or permissions still wait for you.
- When an upload that failed goes up later, a notice says so, and the failure is only reported once.

## 0.2.0

### Added

- **Aktar app on desktop:** connect to Aktar for Mac or Windows in one click (or with the CLI's connection, or a pasted token). Uploads then go through the app: its destinations and keys (Obsidian never sees them), its history, hooks and image settings. When the app isn't running, destinations with keys on the device go straight to the bucket. The app proves it has the token before anything is sent.
- **Offline images:** images from the bucket are kept on each device (IndexedDB, size limit, least recently used go first), so notes show them without a connection.
- **Smaller photos:** convert to WebP and scale down to a longest side before upload. Devices that can't encode WebP (iPhone, iPad) make JPEG; PNGs stay PNG. Moved files keep keys made from the original, so devices that encode differently still agree.
- **Players in live preview:** audio and video embedded from the bucket play in live preview and hover previews too, not only in reading view.
- **Publish a note:** turns a note into a web page in the bucket and copies the link; permanent, or 7 days for private buckets. The page can run no script (Content Security Policy) and asks not to be indexed. Publishing again updates the same page; it can be taken down.
- **Vault backup:** a daily or weekly zip of the vault into the bucket from the devices it's turned on for, under names nobody can guess, keeping the newest few. The settings folder is left out unless chosen.
- `obsidian://aktar-import?link=…` opens the import with the link filled in (Aktar for iOS and Android's Open in Obsidian).
- Release workflow, CI with a real MinIO server, and a check that the code shared with the other Aktar apps hasn't drifted.

## 0.1.0

First version: paste and drop uploads with a persistent queue, moving attachments with undo, bringing files back, automatic moves, private buckets, the library, link menus, removing photo locations, setup with an Aktar transfer code, English and Turkish.
