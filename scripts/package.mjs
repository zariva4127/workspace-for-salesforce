// Creates release/salesforce-workspace-<version>.zip from dist/ for Chrome Web Store upload.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'release', `salesforce-workspace-${version}.zip`);
await mkdir(path.dirname(out), { recursive: true });
await rm(out, { force: true });
execFileSync('zip', ['-r', '-X', out, '.'], { cwd: path.join(root, 'dist'), stdio: 'inherit' });
console.log(`Created ${path.relative(root, out)}`);
