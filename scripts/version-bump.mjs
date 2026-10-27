// `pnpm version 0.2.0` runs this: manifest.json and versions.json follow
// package.json, so the three never disagree about the version.
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.env.npm_package_version;
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifest.version = version;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[version] = manifest.minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');
