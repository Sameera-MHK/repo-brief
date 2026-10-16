import path from 'node:path';
import { CODE_EXTENSIONS, ROUTE_PATTERN } from './analyze.js';

const CONFIG_FILES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'Makefile',
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.editorconfig',
]);
const CONFIG_PATTERN = /^(\.eslintrc(\..+)?|eslint\.config\.[cm]?[jt]s|\.prettierrc(\..+)?|prettier\.config\.[cm]?js|(vite|vitest|next|nuxt|svelte|astro|webpack|rollup|jest|babel|tailwind|postcss)\.config\.[cm]?[jt]s)$/;
const SHARED_PATTERN = /(^|\/)(lib|libs|utils?|shared|common|core|services?|models?|helpers?|hooks|store)\//;

export const GROUPS = [
  'Project configuration',
  'Documentation',
  'Entry point',
  'Route or API handler',
  'Shared module',
  'Source file',
];

/** Returns the priority group (0 = highest) used to order files. */
export function priorityOf(filePath, entryPaths) {
  const name = filePath.split('/').pop();
  const ext = path.extname(name).toLowerCase();
  const isRoot = !filePath.includes('/');
  if (isRoot && (CONFIG_FILES.has(name) || CONFIG_PATTERN.test(name))) return 0;
  if (/^(readme|architecture|contributing|design)(\.[a-z]+)?$/i.test(name) && (isRoot || /^docs?\//i.test(filePath))) return 1;
  if (/^docs?\//i.test(filePath) && /\.(md|markdown|rst)$/i.test(name)) return 1;
  if (entryPaths.has(filePath)) return 2;
  if (CODE_EXTENSIONS.has(ext) && ROUTE_PATTERN.test(filePath)) return 3;
  if (CODE_EXTENSIONS.has(ext) && SHARED_PATTERN.test(filePath)) return 4;
  return 5;
}

/** Deterministic order: priority group, then directory depth, then path. */
export function orderFiles(files, analysis) {
  const entryPaths = new Set([...analysis.entryPoints.confirmed, ...analysis.entryPoints.inferred].map((e) => e.path));
  return files
    .map((file) => ({ ...file, priority: priorityOf(file.path, entryPaths) }))
    .map((file) => ({ ...file, reason: GROUPS[file.priority] }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const depth = a.path.split('/').length - b.path.split('/').length;
      if (depth !== 0) return depth;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
}

/**
 * Adds whole files in priority order until either limit is reached, then stops.
 * `render` produces the full output for a given selection so the character limit
 * is checked against the real generated size. Files are never truncated.
 */
export function selectFiles(ordered, { maxFiles, maxChars, render }) {
  const selected = [];
  let output = render(selected, ordered.map((f) => ({ path: f.path, reason: 'size limit' })));
  let stopReason = null;

  for (let i = 0; i < ordered.length; i++) {
    if (selected.length >= maxFiles) {
      stopReason = 'max-files';
      break;
    }
    const rest = ordered.slice(i + 1).map((f) => ({ path: f.path, reason: 'max-chars limit' }));
    const trial = render([...selected, ordered[i]], rest);
    if (trial.length > maxChars) {
      stopReason = 'max-chars';
      break;
    }
    selected.push(ordered[i]);
    output = trial;
  }

  const reason = stopReason === 'max-files' ? 'max-files limit' : 'max-chars limit';
  const omitted = ordered.slice(selected.length).map((f) => ({ path: f.path, reason }));
  if (stopReason) output = render(selected, omitted);
  return { selected, omitted, output, stopReason };
}
