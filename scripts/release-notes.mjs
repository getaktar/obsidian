// The CHANGELOG.md section for one version, as the release's notes.
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const start = changelog.indexOf(`## ${version}`);
if (start === -1) {
  console.log(`Aktar for Obsidian ${version}`);
} else {
  const rest = changelog.slice(start).split('\n').slice(1).join('\n');
  const end = rest.search(/^## /m);
  console.log((end === -1 ? rest : rest.slice(0, end)).trim());
}
