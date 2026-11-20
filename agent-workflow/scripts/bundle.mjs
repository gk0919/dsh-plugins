import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.resolve(root, '..', '..', 'agent-workflow');
const metadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
if (!npmCli || !/npm-cli\.js$/.test(npmCli)) throw new Error('Run with npm run bundle after building and checking both packages');
const outputRoot = path.join(root, 'build');
mkdirSync(outputRoot, { recursive: true });
const destination = mkdtempSync(path.join(outputRoot, `agent-workflow-${metadata.version}-`));
const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: core, encoding: 'utf8', windowsHide: true }));
renameSync(path.join(destination, packed[0].filename), path.join(destination, 'core.tgz'));
cpSync(path.join(root, 'dist', 'src'), path.join(destination, 'dist', 'src'), { recursive: true });
cpSync(path.join(root, 'dist', 'client.js'), path.join(destination, 'dist', 'client.js'));
for (const file of ['cordis.patch.yml', 'README.md']) cpSync(path.join(root, file), path.join(destination, file));
cpSync(path.join(root, 'deploy'), path.join(destination, 'deploy'), { recursive: true });
cpSync(path.join(root, 'client'), path.join(destination, 'client'), { recursive: true });
// Core keeps MCP optional for generic consumers; this bundle advertises source lookup.
const mcpVersion = JSON.parse(readFileSync(path.join(core, 'node_modules', '@modelcontextprotocol', 'client', 'package.json'), 'utf8')).version;
const bundle = { ...metadata, dependencies: { '@gk0919/agent-workflow': 'file:./core.tgz', '@modelcontextprotocol/client': mcpVersion } };
delete bundle.devDependencies; delete bundle.scripts;
writeFileSync(path.join(destination, 'package.json'), JSON.stringify(bundle, null, 2) + '\n');
writeFileSync(path.join(destination, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\n');
const files = readdirSync(destination, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
  .map((entry) => path.relative(destination, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
writeFileSync(path.join(destination, 'SHA256SUMS'), files.map((file) => createHash('sha256').update(readFileSync(path.join(destination, file))).digest('hex') + '  ' + file).join('\n') + '\n');
process.stdout.write(destination + '\n');
