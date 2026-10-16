import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanRepository } from '../src/scanner.js';
import { compilePattern, matchRules, parseIgnoreFile } from '../src/ignore.js';
import { containsSecret, isSecretFileName } from '../src/secrets.js';
import { makeRepo, removeRepo, FAKE_AWS_KEY, FAKE_PRIVATE_KEY } from './helpers.js';

const repos = [];
const repo = (files) => {
  const root = makeRepo(files);
  repos.push(root);
  return root;
};
after(() => repos.forEach(removeRepo));

const paths = (scan) => scan.files.map((f) => f.path);
const reasonOf = (scan, p) => scan.excluded.find((e) => e.path === p)?.reason;

test('scans files deterministically and skips default excluded directories', () => {
  const root = repo({
    'b.js': 'b',
    'a.js': 'a',
    'src/z.js': 'z',
    'node_modules/pkg/index.js': 'x',
    'dist/out.js': 'x',
    '.git/config': 'x',
    'coverage/lcov.info': 'x',
    '.next/x.js': 'x',
    'build/x.js': 'x',
    'vendor/x.js': 'x',
    '.cache/x': 'x',
  });
  const scan = scanRepository(root);
  assert.deepEqual(paths(scan), ['a.js', 'b.js', 'src/z.js']);
  assert.equal(scan.totalFiles, 3);
  assert.ok(scan.excludedDirs.some((d) => d.path === 'node_modules'));
});

test('respects .gitignore, nested .gitignore and negation', () => {
  const root = repo({
    '.gitignore': '*.log\ntmp/\n!keep.log\n',
    'app.log': 'x',
    'keep.log': 'x',
    'tmp/a.js': 'x',
    'src/.gitignore': 'secret-stuff.js\n',
    'src/secret-stuff.js': 'x',
    'src/ok.js': 'x',
  });
  const scan = scanRepository(root);
  assert.equal(reasonOf(scan, 'app.log'), '.gitignore');
  assert.ok(paths(scan).includes('keep.log'));
  assert.ok(!paths(scan).includes('tmp/a.js'));
  assert.equal(reasonOf(scan, 'src/secret-stuff.js'), '.gitignore');
  assert.ok(paths(scan).includes('src/ok.js'));
});

test('respects .repobriefignore', () => {
  const root = repo({ '.repobriefignore': 'docs/\n*.snap\n', 'docs/a.md': 'x', 'a.snap': 'x', 'a.js': 'x' });
  const scan = scanRepository(root);
  assert.ok(!paths(scan).includes('docs/a.md'));
  assert.equal(reasonOf(scan, 'a.snap'), '.repobriefignore');
  assert.ok(paths(scan).includes('a.js'));
});

test('applies explicit include and exclude patterns', () => {
  const root = repo({ 'src/a.js': 'a', 'src/a.test.js': 't', 'lib/b.js': 'b', 'README.md': 'r' });
  const included = scanRepository(root, { include: ['src/**'] });
  assert.deepEqual(paths(included), ['src/a.js', 'src/a.test.js']);
  assert.equal(reasonOf(included, 'README.md'), 'not matched by --include');

  const excluded = scanRepository(root, { exclude: ['*.test.js', 'lib/'] });
  assert.deepEqual(paths(excluded), ['README.md', 'src/a.js']);
  assert.equal(reasonOf(excluded, 'src/a.test.js'), '--exclude');
});

test('excludes lockfiles unless explicitly included', () => {
  const root = repo({ 'package-lock.json': '{}', 'yarn.lock': 'x', 'a.js': 'a' });
  assert.equal(reasonOf(scanRepository(root), 'package-lock.json'), 'lockfile');
  assert.deepEqual(paths(scanRepository(root, { include: ['package-lock.json'] })), ['package-lock.json']);
});

test('excludes binary files, large files, generated output and the output file', () => {
  const root = repo({
    'logo.png': 'not really png',
    'data.bin2': Buffer.from([1, 2, 0, 3]),
    'big.js': 'x'.repeat(200 * 1024),
    'repobrief.md': '# Repository Brief: old',
    'notes/brief.md': '# Repository Brief: elsewhere',
    'custom-out.md': 'x',
    'a.js': 'a',
  });
  const scan = scanRepository(root, { outputPath: path.join(root, 'custom-out.md') });
  assert.equal(reasonOf(scan, 'logo.png'), 'binary file');
  assert.equal(reasonOf(scan, 'data.bin2'), 'binary file');
  assert.equal(reasonOf(scan, 'big.js'), 'file too large');
  assert.equal(reasonOf(scan, 'repobrief.md'), 'generated output');
  assert.equal(reasonOf(scan, 'notes/brief.md'), 'generated output');
  assert.equal(reasonOf(scan, 'custom-out.md'), 'output file');
  assert.deepEqual(paths(scan), ['a.js']);
});

test('excludes secret files by name', () => {
  const root = repo({
    '.env': 'A=1',
    '.env.local': 'A=1',
    '.env.production': 'A=1',
    'certs/server.pem': 'x',
    'id_rsa': 'x',
    'config/credentials.json': '{}',
    '.npmrc': 'x',
    'a.js': 'a',
  });
  const scan = scanRepository(root);
  assert.deepEqual(paths(scan), ['a.js']);
  for (const p of ['.env', '.env.local', '.env.production', 'certs/server.pem', 'id_rsa', 'config/credentials.json', '.npmrc']) {
    assert.equal(reasonOf(scan, p), 'sensitive file name', p);
  }
});

test('excludes files whose content looks like a secret and never reveals the value', () => {
  const root = repo({
    'src/aws.js': `const key = "${FAKE_AWS_KEY}";`,
    'src/key.txt': FAKE_PRIVATE_KEY,
    'src/conf.js': 'export const api_key = "' + 'abcdefghijklmnop1234' + '";',
    'src/clean.js': 'export const x = 1;',
  });
  const scan = scanRepository(root);
  assert.deepEqual(paths(scan), ['src/clean.js']);
  assert.equal(reasonOf(scan, 'src/aws.js'), 'possible secret detected');
  const allText = JSON.stringify(scan.warnings) + JSON.stringify(scan.excluded);
  assert.ok(!allText.includes(FAKE_AWS_KEY));
  assert.ok(!allText.includes('abcdefghijklmnop1234'));
});

test('secret detection patterns', () => {
  assert.ok(containsSecret(FAKE_AWS_KEY));
  assert.ok(containsSecret(FAKE_PRIVATE_KEY));
  assert.ok(containsSecret('gh' + 'p_' + 'a'.repeat(36)));
  assert.ok(containsSecret('PASSWORD: "' + 'hunter2hunter2hunter2' + '"'));
  assert.ok(!containsSecret('const token = getToken();'));
  assert.ok(!containsSecret('password: process.env.PASSWORD'));
  assert.ok(isSecretFileName('a/b/.env.staging'));
  assert.ok(!isSecretFileName('src/env.js'));
});

test('handles symlinks safely', () => {
  const outside = repo({ 'outside.js': 'outside' });
  const root = repo({ 'src/real.js': 'real' });
  fs.symlinkSync(path.join(outside, 'outside.js'), path.join(root, 'escape.js'));
  fs.symlinkSync(path.join(root, 'src/real.js'), path.join(root, 'alias.js'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'src-link'));
  fs.symlinkSync(path.join(root, 'missing.js'), path.join(root, 'broken.js'));
  const scan = scanRepository(root);
  assert.equal(reasonOf(scan, 'escape.js'), 'symlink outside repository');
  assert.equal(reasonOf(scan, 'broken.js'), 'broken symlink');
  assert.ok(paths(scan).includes('alias.js'));
  assert.ok(!paths(scan).some((p) => p.startsWith('src-link/')));
  assert.ok(!scan.files.some((f) => f.content === 'outside'));
});

test('reports unreadable files as errors and continues', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const root = repo({ 'locked.js': 'x', 'ok.js': 'ok' });
  fs.chmodSync(path.join(root, 'locked.js'), 0o000);
  try {
    const scan = scanRepository(root);
    assert.equal(reasonOf(scan, 'locked.js'), 'unreadable');
    assert.equal(scan.errors.length, 1);
    assert.deepEqual(paths(scan), ['ok.js']);
  } finally {
    fs.chmodSync(path.join(root, 'locked.js'), 0o644);
  }
});

test('missing target throws', () => {
  assert.throws(() => scanRepository(path.join(os.tmpdir(), 'repobrief-does-not-exist-xyz')));
});

test('ignore pattern semantics', () => {
  const rules = parseIgnoreFile('# comment\n/root.js\n**/deep/*.js\nbuild-*/\n');
  assert.equal(matchRules(rules, 'root.js', false), true);
  assert.equal(matchRules(rules, 'sub/root.js', false), undefined);
  assert.equal(matchRules(rules, 'a/b/deep/x.js', false), true);
  assert.equal(matchRules(rules, 'build-1', true), true);
  assert.equal(matchRules(rules, 'build-1', false), undefined);
  assert.ok(compilePattern('*.js').regex.test('a/b/c.js'));
  assert.equal(compilePattern('# x'), null);
});
