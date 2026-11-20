import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

// Trusted fixed checker: parse changed JavaScript without importing or executing it.
const git = (...args) => execFileSync('git', ['--no-optional-locks', ...args], { encoding: 'utf8', windowsHide: true });
const root = realpathSync(git('rev-parse', '--show-toplevel').trim());
if (realpathSync(process.cwd()) !== root) throw new Error('Run this checker from the task Git repository root');
const files = [...new Set([
  ...git('diff', '--name-only', '--diff-filter=ACMRT', '-z', 'HEAD', '--').split('\0'),
  ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
])].filter((file) => /\.(?:js|mjs|cjs)$/.test(file));
let failed = false;
for (const file of files) {
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep) || realpathSync(target) !== target || !lstatSync(target).isFile()) throw new Error(`Expected an unredirected file: ${file}`);
  const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error || result.status !== 0) {
    failed = true;
    process.stderr.write(`${file}: ${result.error?.message ?? result.stderr}\n`);
  }
}
process.stdout.write(JSON.stringify({ check: 'changed-js-syntax', files, coverage: 'Syntax only; no behavior, browser, type or business acceptance coverage' }) + '\n');
process.exitCode = failed ? 1 : 0;
