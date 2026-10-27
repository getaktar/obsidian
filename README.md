# Aktar for Obsidian

Keep your attachments in your own S3, Cloudflare R2, Backblaze B2, DigitalOcean Spaces or MinIO bucket, on desktop and mobile. Notes stay small and keep syncing the way they do now; files live in your bucket and every link is a plain `https://` URL, so notes work without the plugin too.

## Features

- **Paste and drop:** files go into the note as placeholders at once and become links when uploaded. The queue survives going offline and restarting Obsidian. Uploads that keep failing can be saved into the vault instead, so nothing is lost.
- **Move existing attachments:** a dry run shows what would change first. Every link in every note is rewritten, with size and caption kept (`![[a.png|300]]` becomes `![300](https://…)`), and the local copies go to the trash. Links in front matter, code and canvases are left alone, and their files stay. Every move can be undone.
- **Bring files back:** downloads files into the vault and turns links back into ordinary attachment links, written the way your link settings say.
- **Move new attachments automatically:** photos attached on a phone, or files saved by other plugins, move once a note embeds them.
- **Private buckets:** notes keep plain links, and the plugin shows the files through URLs signed on the device, valid for an hour.
- **Library:** see what your notes use from the bucket, browse the bucket, find files no note uses any more, and watch the upload queue.
- **Link actions:** right-click a link to copy it, copy a link valid for 1 hour, 1 day or 7 days, open it, bring the file into the vault, or delete it from the bucket (it tells you which notes link the file first).
- **Privacy:** the location is removed from photos before they leave the device.
- **Smaller photos:** convert to WebP and scale down before upload.
- **Offline:** images you've seen are kept on the device, so notes show them without a connection.
- **Aktar app on desktop:** pair with Aktar for Mac or Windows and uploads go through it, with its keys, history and hooks. Obsidian never sees the keys.
- **Publish a note:** a note becomes a web page in your bucket, and the link is copied. The page can't run scripts.
- **Vault backup:** a daily or weekly zip of the vault into your bucket, keeping the newest few.
- **Same rules as the Aktar apps:** path templates, `{short}` codes that never replace another file, and destinations moved over with a transfer code.

## Setup

1. In Aktar on your Mac, PC or phone, open a destination and choose **Share**. Copy the transfer link.
2. In Obsidian, open **Settings > Aktar > Add from Aktar app**, paste the link and type the 12-character code.

Or choose **Add manually** and enter the endpoint, bucket, public URL and keys.

On a Mac or PC with Aktar, **Settings > Aktar > Aktar app > Connect** pairs the plugin with the app instead (Aktar for Mac 0.19 or Windows 0.12 and later; with older versions, paste the token from Aktar's Settings > Integrations, or use the CLI's `aktar login`). Its destinations show up in the plugin; on a phone, add the same destination's keys with a transfer code and it's the same destination there.

## Keys and sync

Destinations are kept in the plugin's `data.json`, which syncs with the vault. Keys never go there. They're stored in Obsidian's secret storage on each device, and secret storage doesn't sync. A device that has a destination but not its keys says so and asks for a transfer code.

## Paths

The default path is `obsidian/{vault}/{year}/{month}/{short}.{ext}`, so each vault has a folder of its own in the bucket, and files that no note uses can be found there. Variables: `{vault}` `{note}` `{noteFolder}` `{year}` `{month}` `{day}` `{date}` `{time}` `{short}` `{filename}` `{ext}` `{uuid}` `{random}` `{sha256}`.

Moved attachments get keys that only depend on the file, so two synced devices moving the same file write the same object and the same links.

## Network use

The plugin connects only to the storage endpoints and public URLs of the destinations you add, and on desktop to the Aktar app on `127.0.0.1` when you pair with it. It collects no data and sends no telemetry.

## Vault and clipboard access

- **Listing the vault's files:** moving attachments has to know which notes link which file, the library shows which bucket files your notes use, and a backup zips the vault. Paths and notes never leave the device; only the files you move, upload or back up go to your bucket.
- **Clipboard:** the plugin writes a link to it when you copy one, publish a note or copy a backup's link, and when an upload finishes after its placeholder was deleted. It reads it once when you open **Add from Aktar app**, to fill in a transfer link if there is one; anything else there is ignored. Pasted files come through Obsidian's paste event, like any paste.

The release files are built by GitHub Actions from the tagged commit and signed with an [artifact attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations): `gh attestation verify main.js -R getaktar/obsidian`.

## Development

```bash
pnpm install
pnpm dev     # watch build into main.js
pnpm check   # typecheck, production build, tests, shared-code check
```

To try it, copy or symlink `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/aktar/` of a test vault. The S3 tests start a throwaway MinIO server when the `minio` binary is installed, and are skipped otherwise.

Some code (`src/s3/sigv4.ts`, `xml.ts`, `endpoint.ts`, and parts of `src/core`) is shared with the other Aktar apps and has to stay the same as theirs. `pnpm check:ported` compares it with their source when it's available, and is skipped otherwise. `test/transferVectors.ts` holds the transfer test vectors shared by all the apps.

Releases: `pnpm version <x.y.z>` updates `manifest.json` and `versions.json`, then pushing the tag builds and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`.

See [ROADMAP.md](ROADMAP.md) for what comes next.
