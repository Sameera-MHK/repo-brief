import fs from 'node:fs';
import path from 'node:path';
import { scanRepository } from './scanner.js';
import { analyzeRepository } from './analyze.js';
import { orderFiles, selectFiles } from './select.js';
import { renderMarkdown, renderJson, estimateTokens } from './render.js';

export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_MAX_CHARS = 200_000;

/** Invalid arguments, invalid target or configuration problems (exit code 2). */
export class UsageError extends Error {}

export function resolveTarget(target) {
  const abs = path.resolve(target || '.');
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new UsageError(`Target "${target}" does not exist. Pass the path to a repository directory, e.g. "repobrief generate ."`);
  }
  if (!stat.isDirectory()) throw new UsageError(`Target "${target}" is not a directory. Pass the repository folder, not a file.`);
  return fs.realpathSync(abs);
}

export function defaultOutputPath(root, json) {
  return path.join(root, json ? 'repobrief.json' : 'repobrief.md');
}

function isRepoBriefOutput(filePath) {
  const head = fs.readFileSync(filePath, 'utf8').slice(0, 300);
  return head.startsWith('# Repository Brief:') || /"generator":\s*"repobrief"/.test(head);
}

/** Throws UsageError if writing to outputPath would be unsafe. */
export function checkOutputPath(outputPath, root, force) {
  const parent = path.dirname(outputPath);
  if (!fs.existsSync(parent)) throw new UsageError(`Output directory "${parent}" does not exist. Create it first or choose another --output path.`);
  if (!fs.existsSync(outputPath)) return;

  if (fs.statSync(outputPath).isDirectory()) throw new UsageError(`Output path "${outputPath}" is a directory. Pass a file path to --output.`);
  const realParent = fs.realpathSync(parent);
  const insideRepo = realParent === root || realParent.startsWith(root + path.sep);
  const isBrief = isRepoBriefOutput(outputPath);
  if (insideRepo && !isBrief) {
    throw new UsageError(`Refusing to overwrite "${outputPath}": it is a repository file, not a RepoBrief output. Choose another --output path.`);
  }
  if (!force) throw new UsageError(`Output file "${outputPath}" already exists. Re-run with --force to overwrite it.`);
}

/** Scans, analyzes and renders a brief. Never writes to disk. */
export function buildBrief(target, options = {}) {
  const root = resolveTarget(target);
  const json = Boolean(options.json);
  const outputPath = options.output ? path.resolve(options.output) : defaultOutputPath(root, json);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  const scan = scanRepository(root, { include: options.include, exclude: options.exclude, outputPath });
  const analysis = analyzeRepository(scan);
  const ordered = orderFiles(scan.files, analysis);
  const renderer = json ? renderJson : renderMarkdown;
  const render = (selected, omitted) => renderer({ analysis, scan, selected, omitted });
  const { selected, omitted, output } = selectFiles(ordered, { maxFiles, maxChars, render });

  const warnings = [...scan.warnings];
  if (output.length > maxChars) {
    warnings.push(`The brief without source files is already ${output.length} characters, above --max-chars ${maxChars}. Increase --max-chars.`);
  }

  return {
    root,
    outputPath,
    format: json ? 'json' : 'markdown',
    scan,
    analysis,
    selected,
    omitted,
    output,
    chars: output.length,
    approxTokens: estimateTokens(output.length),
    warnings,
    errors: [...scan.errors],
  };
}

export function writeBrief(result, { force } = {}) {
  checkOutputPath(result.outputPath, result.root, force);
  fs.writeFileSync(result.outputPath, result.output, 'utf8');
}
