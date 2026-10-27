# Roadmap

Done so far: see [CHANGELOG.md](CHANGELOG.md).

## Next

- **Shared core package:** the plugin shares SigV4, key generation and the transfer format with the other Aktar apps by copy, checked by `pnpm check:ported`. One shared package would take that check away.
- **Settings in Obsidian's search:** move the settings tab to `getSettingDefinitions()` (Obsidian 1.13), which also means raising the minimum Obsidian version.
- **Restoring from a backup** inside Obsidian (today: download the zip from Settings and unzip it).
