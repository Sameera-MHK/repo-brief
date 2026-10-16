import fs from 'node:fs';
import path from 'node:path';
import { parseIgnoreFile, matchRules, matchesAny, compilePattern } from './ignore.js';
import { isSecretFileName, containsSecret } from './secrets.js';

export const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  '.cache',
  '.svn',
  '.hg',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
  '.parcel-cache',
  '.output',
  'out',
  'target',
]);

export const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'composer.lock',
  'Gemfile.lock',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
]);

export const GENERATED_OUTPUT_NAMES = new Set(['repobrief.md', 'repobrief.json']);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff', '.psd',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm', '.flac',
  '.zip', '.gz', '.tgz', '.tar', '.rar', '.7z', '.bz2', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.class', '.jar', '.wasm', '.pyc',
  '.sqlite', '.db', '.lockb',
]);

export const MAX_FILE_BYTES = 100 * 1024;

const toPosix = (p) => p.split(path.sep).join('/');

function isBinaryBuffer(buffer) {
  const len = Math.min(buffer.length, 8000);
  for (let i = 0; i < len; i++) if (buffer[i] === 0) return true;
  return false;
}

function readIgnoreFile(absPath, base, errors) {
  try {
    return parseIgnoreFile(fs.readFileSync(absPath, 'utf8'), base);
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`Could not read ${toPosix(absPath)}: ${err.code || err.message}`);
    return [];
  }
}

/**
 * Walks a repository with Node.js filesystem APIs and classifies every file as
 * either a candidate (readable, safe text file) or excluded (with a reason).
 * Files are only read, never modified.
 */
export function scanRepository(root, options = {}) {
  const rootAbs = fs.realpathSync(path.resolve(root));
  const include = (options.include || []).map((p) => compilePattern(p)).filter(Boolean);
  const exclude = (options.exclude || []).map((p) => compilePattern(p)).filter(Boolean);
  const outputRel = options.outputPath ? toPosix(path.relative(rootAbs, path.resolve(options.outputPath))) : null;

  const result = { root: rootAbs, totalFiles: 0, files: [], excluded: [], excludedDirs: [], warnings: [], errors: [] };
  const repobriefRules = readIgnoreFile(path.join(rootAbs, '.repobriefignore'), '', result.errors);

  const exclude_ = (relPath, reason) => result.excluded.push({ path: relPath, reason });

  function classifyFile(relPath, absPath, gitRules) {
    result.totalFiles++;
    const name = relPath.split('/').pop();
    const ext = path.extname(name).toLowerCase();
    const explicitlyIncluded = include.length > 0 && matchesAny(include, relPath);

    if (relPath === outputRel) return exclude_(relPath, 'output file');
    if (GENERATED_OUTPUT_NAMES.has(name)) return exclude_(relPath, 'generated output');
    if (isSecretFileName(relPath)) return exclude_(relPath, 'sensitive file name');
    if (matchRules(gitRules, relPath, false)) return exclude_(relPath, '.gitignore');
    if (matchRules(repobriefRules, relPath, false)) return exclude_(relPath, '.repobriefignore');
    if (matchesAny(exclude, relPath)) return exclude_(relPath, '--exclude');
    if (include.length > 0 && !explicitlyIncluded) return exclude_(relPath, 'not matched by --include');
    if (LOCKFILES.has(name) && !explicitlyIncluded) return exclude_(relPath, 'lockfile');
    if (BINARY_EXTENSIONS.has(ext)) return exclude_(relPath, 'binary file');

    let buffer;
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > MAX_FILE_BYTES) return exclude_(relPath, 'file too large');
      buffer = fs.readFileSync(absPath);
    } catch (err) {
      result.errors.push(`Could not read ${relPath}: ${err.code || err.message}`);
      return exclude_(relPath, 'unreadable');
    }
    if (isBinaryBuffer(buffer)) return exclude_(relPath, 'binary file');

    const content = buffer.toString('utf8');
    if (content.startsWith('# Repository Brief:')) return exclude_(relPath, 'generated output');
    if (containsSecret(content)) {
      result.warnings.push(`Excluded ${relPath}: possible secret detected (value not shown).`);
      return exclude_(relPath, 'possible secret detected');
    }
    result.files.push({ path: relPath, size: buffer.length, content });
  }

  function walk(dirRel, parentRules) {
    const dirAbs = dirRel ? path.join(rootAbs, dirRel) : rootAbs;
    const gitRules = parentRules.concat(readIgnoreFile(path.join(dirAbs, '.gitignore'), dirRel, result.errors));

    let entries;
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      result.errors.push(`Could not read directory ${dirRel || '.'}: ${err.code || err.message}`);
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      const relPath = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      const absPath = path.join(dirAbs, entry.name);

      if (entry.isSymbolicLink()) {
        let real;
        let stat;
        try {
          real = fs.realpathSync(absPath);
          stat = fs.statSync(real);
        } catch {
          result.totalFiles++;
          exclude_(relPath, 'broken symlink');
          continue;
        }
        const inside = real === rootAbs || real.startsWith(rootAbs + path.sep);
        if (stat.isDirectory()) {
          result.excludedDirs.push({ path: relPath, reason: 'symlinked directory not followed' });
        } else if (!inside) {
          result.totalFiles++;
          exclude_(relPath, 'symlink outside repository');
        } else {
          classifyFile(relPath, real, gitRules);
        }
        continue;
      }

      if (entry.isDirectory()) {
        let reason = null;
        if (DEFAULT_EXCLUDED_DIRS.has(entry.name)) reason = 'default exclusion';
        else if (matchRules(gitRules, relPath, true)) reason = '.gitignore';
        else if (matchRules(repobriefRules, relPath, true)) reason = '.repobriefignore';
        else if (matchesAny(exclude, relPath)) reason = '--exclude';
        if (reason) result.excludedDirs.push({ path: relPath, reason });
        else walk(relPath, gitRules);
      } else if (entry.isFile()) {
        classifyFile(relPath, absPath, gitRules);
      }
    }
  }

  walk('', []);
  return result;
}
