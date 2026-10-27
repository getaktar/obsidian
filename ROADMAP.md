# Roadmap

Done so far: see [CHANGELOG.md](CHANGELOG.md).

## Next

- **Shared core package:** the plugin shares SigV4, key generation and the transfer format with the other Aktar apps by copy, checked by `pnpm check:ported`. One shared package would take that check away.
- **Community plugin listing:** the repository has to be public, then a PR to `obsidianmd/obsidian-releases` adds `aktar` to `community-plugins.json`. The release workflow already produces what Obsidian installs from.
- **Restoring from a backup** inside Obsidian (today: download the zip from Settings and unzip it).
