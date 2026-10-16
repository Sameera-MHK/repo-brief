import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'repobrief.js');

// Fake secrets are assembled at runtime so this file itself does not look like it contains one.
export const FAKE_AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
export const FAKE_PRIVATE_KEY = '-----BEGIN ' + 'RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

/** Creates a temporary repository from a { relativePath: content } map. */
export function makeRepo(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repobrief-test-')));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

export function removeRepo(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

export function runCli(args, cwd) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Snapshot of every file's content, used to prove nothing was modified. */
export function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out[path.relative(root, abs)] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}
