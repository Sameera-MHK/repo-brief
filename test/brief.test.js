import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBrief, writeBrief, checkOutputPath, UsageError } from '../src/index.js';
import { makeRepo, removeRepo, runCli, snapshot, FAKE_AWS_KEY } from './helpers.js';

const repos = [];
const repo = (files) => {
  const root = makeRepo(files);
  repos.push(root);
  return root;
};
after(() => repos.forEach(removeRepo));

const sampleProject = () => ({
  'package.json': JSON.stringify({
    name: 'sample-app',
    version: '1.2.3',
    description: 'A sample Express app',
    type: 'module',
    main: 'src/server.js',
    scripts: { start: 'node src/server.js', test: 'node --test' },
    dependencies: { express: '^4.0.0' },
    devDependencies: { vitest: '^1.0.0' },
  }, null, 2),
  'README.md': '# Sample\n\nSample app that serves a small API.\n',
  'src/server.js': "import express from 'express';\nconst app = express();\n  app.listen(3000);\n",
  'src/routes/users.js': 'export function users() {\n  return [];\n}\n',
  'src/utils/format.js': 'export const format = (x) => {\n  return String(x);\n};\n',
  'src/other.js': 'export const other = () => {\n  return 1;\n};\n',
  'scripts/tool.sh': 'echo hi\n',
  '.env': 'SECRET=1',
  'src/leak.js': `export const k = "${FAKE_AWS_KEY}";\n`,
});

test('orders files by priority: config, docs, entry points, routes, shared, rest', () => {
  const root = repo(sampleProject());
  const result = buildBrief(root);
  assert.deepEqual(result.selected.map((f) => f.path), [
    'package.json',
    'README.md',
    'src/server.js',
    'src/routes/users.js',
    'src/utils/format.js',
    'scripts/tool.sh',
    'src/other.js',
  ]);
  assert.equal(result.selected[2].reason, 'Entry point');
});

test('analysis is evidence-based', () => {
  const root = repo(sampleProject());
  const { analysis } = buildBrief(root);
  assert.equal(analysis.name, 'sample-app');
  assert.deepEqual(analysis.frameworks.map((f) => f.name), ['Express']);
  assert.ok(analysis.testTools.some((t) => t.name === 'Vitest'));
  assert.deepEqual(analysis.entryPoints.confirmed.map((e) => e.path), ['src/server.js']);
  assert.deepEqual(analysis.routes, ['src/routes/users.js']);
  assert.ok(analysis.conventions.some((c) => c.includes('ES modules')));

  const bare = buildBrief(repo({ 'a.py': 'print(1)\n' })).analysis;
  assert.deepEqual(bare.frameworks, []);
  assert.deepEqual(bare.entryPoints.confirmed, []);
});

test('generates Markdown with all sections and no secrets', () => {
  const root = repo(sampleProject());
  const { output } = buildBrief(root);
  for (const heading of [
    '# Repository Brief: sample-app',
    '## Project Overview',
    '## Technology Stack',
    '## Directory Structure',
    '## Architecture and Entry Points',
    '## Development Commands',
    '## Important Files',
    '## Coding Conventions',
    '## Source Context',
    '## AI Assistant Instructions',
  ]) {
    assert.ok(output.includes(heading), heading);
  }
  assert.ok(output.includes('### src/server.js'));
  assert.ok(output.includes('`npm run start`'));
  assert.ok(output.includes('Ask before destructive operations.'));
  assert.ok(!output.includes(FAKE_AWS_KEY));
  assert.ok(!output.includes('SECRET=1'));
  assert.ok(!output.includes('node_modules'));
});

test('uses a longer fence when a file contains backticks', () => {
  const root = repo({ 'doc.md': 'text\n```js\ncode\n```\n' });
  assert.ok(buildBrief(root).output.includes('````markdown'));
});

test('produces valid JSON output without secrets', () => {
  const root = repo(sampleProject());
  const result = buildBrief(root, { json: true });
  const data = JSON.parse(result.output);
  assert.equal(data.generator, 'repobrief');
  assert.equal(data.project.name, 'sample-app');
  assert.equal(data.files[0].path, 'package.json');
  assert.ok(data.stats.excludedFiles >= 2);
  assert.ok(!result.output.includes(FAKE_AWS_KEY));
  assert.ok(result.outputPath.endsWith('repobrief.json'));
});

test('respects --max-files and lists omitted files', () => {
  const root = repo(sampleProject());
  const result = buildBrief(root, { maxFiles: 2 });
  assert.equal(result.selected.length, 2);
  assert.equal(result.omitted.length, 5);
  assert.ok(result.output.includes('### Omitted Files'));
  assert.ok(result.output.includes('`src/other.js` (max-files limit)'));
});

test('respects --max-chars, never truncates files and stops selecting', () => {
  const big = 'x'.repeat(5000) + '\nEND_OF_FILE\n';
  const root = repo({ 'README.md': 'readme\n', 'a.js': big, 'b.js': 'small\n' });
  const result = buildBrief(root, { maxChars: 4000 });
  assert.ok(result.chars <= 4000, `chars=${result.chars}`);
  assert.deepEqual(result.selected.map((f) => f.path), ['README.md']);
  assert.deepEqual(result.omitted.map((f) => f.path), ['a.js', 'b.js']);
  assert.ok(!result.output.includes('xxxxxxxxxx'));
  assert.ok(result.output.includes('`a.js` (max-chars limit)'));

  const roomy = buildBrief(root, { maxChars: 100_000 });
  assert.ok(roomy.output.includes('END_OF_FILE'));
});

test('warns when the limit is too small for the brief itself', () => {
  const root = repo({ 'a.js': 'a\n' });
  const result = buildBrief(root, { maxChars: 10 });
  assert.equal(result.selected.length, 0);
  assert.ok(result.warnings.some((w) => w.includes('--max-chars')));
});

test('output path safety', () => {
  const root = repo({ 'src/a.js': 'a\n', 'repobrief.md': '# Repository Brief: old\n' });
  assert.throws(() => checkOutputPath(path.join(root, 'src/a.js'), root, true), UsageError);
  assert.throws(() => checkOutputPath(path.join(root, 'repobrief.md'), root, false), /--force/);
  assert.doesNotThrow(() => checkOutputPath(path.join(root, 'repobrief.md'), root, true));
  assert.throws(() => checkOutputPath(path.join(root, 'src'), root, true), /directory/);
  assert.throws(() => checkOutputPath(path.join(root, 'nope/out.md'), root, false), /does not exist/);
  assert.doesNotThrow(() => checkOutputPath(path.join(root, 'new.md'), root, false));

  const result = buildBrief(root, { output: path.join(root, 'src/a.js') });
  assert.throws(() => writeBrief(result, { force: true }), UsageError);
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'a\n');
});

test('never modifies scanned source files', () => {
  const root = repo(sampleProject());
  const before = snapshot(root);
  const result = buildBrief(root);
  writeBrief(result);
  const afterSnap = snapshot(root);
  delete afterSnap['repobrief.md'];
  assert.deepEqual(afterSnap, before);
});

test('CLI: generate writes the brief and exits 0', () => {
  const root = repo(sampleProject());
  const res = runCli(['generate', '.'], root);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.readFileSync(path.join(root, 'repobrief.md'), 'utf8').startsWith('# Repository Brief: sample-app'));
  assert.ok(res.stderr.includes('warning:'));
  assert.ok(!res.stderr.includes(FAKE_AWS_KEY));

  const again = runCli(['generate', '.'], root);
  assert.equal(again.code, 2);
  assert.ok(again.stderr.includes('--force'));
  assert.equal(runCli(['generate', '.', '--force'], root).code, 0);
});

test('CLI: --output, --json and --dry-run', () => {
  const root = repo(sampleProject());
  const out = path.join(root, 'out', 'brief.json');
  fs.mkdirSync(path.dirname(out));
  assert.equal(runCli(['generate', '.', '--json', '--output', out], root).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).generator, 'repobrief');

  const dry = runCli(['generate', '.', '--dry-run'], root);
  assert.equal(dry.code, 0);
  assert.ok(dry.stdout.includes('Dry run'));
  assert.ok(!fs.existsSync(path.join(root, 'repobrief.md')));

  const dryJson = runCli(['generate', '.', '--dry-run', '--json'], root);
  assert.equal(JSON.parse(dryJson.stdout).dryRun, true);
});

test('CLI: analyze prints a summary', () => {
  const root = repo(sampleProject());
  const res = runCli(['analyze', '.'], root);
  assert.equal(res.code, 0);
  assert.ok(res.stdout.includes('RepoBrief analysis: sample-app'));
  assert.ok(res.stdout.includes('Express'));
  assert.ok(res.stdout.includes('src/server.js'));
  assert.equal(JSON.parse(runCli(['analyze', '.', '--json'], root).stdout).project.name, 'sample-app');
});

test('CLI: exit codes for invalid input', () => {
  const root = repo({ 'a.js': 'a' });
  assert.equal(runCli(['--version'], root).code, 0);
  assert.equal(runCli(['--help'], root).code, 0);
  assert.equal(runCli([], root).code, 2);
  assert.equal(runCli(['explode', '.'], root).code, 2);
  assert.equal(runCli(['generate', '.', '--bogus'], root).code, 2);
  assert.equal(runCli(['generate', '.', '--max-files', 'abc'], root).code, 2);
  assert.equal(runCli(['generate', '.', '--max-chars', '0'], root).code, 2);
  assert.equal(runCli(['generate', 'does-not-exist'], root).code, 2);
  assert.equal(runCli(['generate', 'a.js'], root).code, 2);
});

test('CLI: exits 1 when files could not be read', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const root = repo({ 'locked.js': 'x', 'ok.js': 'ok\n' });
  fs.chmodSync(path.join(root, 'locked.js'), 0o000);
  try {
    const res = runCli(['generate', '.'], root);
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('error: Could not read locked.js'));
    assert.ok(fs.existsSync(path.join(root, 'repobrief.md')));
  } finally {
    fs.chmodSync(path.join(root, 'locked.js'), 0o644);
  }
});
