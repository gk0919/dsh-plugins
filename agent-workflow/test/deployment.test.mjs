import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../deploy/check-changed-js.mjs', import.meta.url));
test('deployment checker parses changed JS without running it and reports syntax failure', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-checker-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  try {
    git('init', '--quiet');
    writeFileSync(path.join(root, 'base.txt'), 'baseline'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture');
    writeFileSync(path.join(root, 'new.js'), 'throw new Error("Must not execute");\n');
    let result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).files, ['new.js']);
    writeFileSync(path.join(root, 'new.js'), 'const = ;\n');
    result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1); assert.match(result.stderr, /SyntaxError/);
    writeFileSync(path.join(root, 'new.js'), 'const valid = 1;\n');
    git('add', 'new.js'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture js');
    result = spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.deepEqual(JSON.parse(result.stdout).files, []);
    assert.match(JSON.parse(result.stdout).coverage, /Syntax only/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
import { WorkflowController } from '@gk0919/agent-workflow/control';
import { mkdirSync, symlinkSync } from 'node:fs';
test('bounded literal search skips generated, binary and linked content and reports truncation', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workflow-search-'));
  const outside = mkdtempSync(path.join(os.tmpdir(), 'workflow-search-outside-'));
  try {
    writeFileSync(path.join(root, 'code.js'), 'literal .*\n' + 'x'.repeat(700) + 'literal .*\n');
    writeFileSync(path.join(root, 'binary.js'), Buffer.from([0xff, 0, 0xfe]));
    mkdirSync(path.join(root, 'node_modules'));
    writeFileSync(path.join(root, 'node_modules', 'hidden.js'), 'literal .*');
    writeFileSync(path.join(outside, 'outside.js'), 'literal .*');
    symlinkSync(outside, path.join(root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = new WorkflowController(root).files;
    let result = files.search({ query: 'literal .*', extensions: ['js'] });
    assert.equal(result.matches.length, 2);
    assert.ok(result.matches.every((match) => match.path === 'code.js' && match.text.includes('literal .*')));
    result = files.search({ query: 'literal .*', maxResults: 1 });
    assert.equal(result.matches.length, 1); assert.equal(result.truncated, true);
    assert.throws(() => files.search({ query: 'literal', path: 'redirect' }), /Links|redirected/);
    assert.throws(() => files.search({ query: 'literal', maxResults: 201 }), /1–200/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
