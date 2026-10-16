#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildBrief, writeBrief, checkOutputPath, resolveTarget, defaultOutputPath, UsageError } from '../src/index.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const HELP = `RepoBrief ${version} — Give your AI the context it needs.

Usage:
  repobrief generate [path] [options]   Write a Markdown brief (default: <path>/repobrief.md)
  repobrief analyze [path] [options]    Print a concise summary of the repository

Options:
  -o, --output <path>      Output file location
      --max-files <n>      Maximum number of source files to include (default 50)
      --max-chars <n>      Maximum total generated characters (default 200000)
      --include <glob>     Only include matching files (repeatable)
      --exclude <glob>     Exclude matching files (repeatable)
      --dry-run            Show the planned analysis without writing output
      --json               Output structured JSON instead of Markdown
      --force              Overwrite an existing RepoBrief output file
  -h, --help               Show this help
  -v, --version            Show the version

Exit codes: 0 success, 1 completed with errors, 2 invalid arguments or target.`;

const OPTIONS = {
  output: { type: 'string', short: 'o' },
  'max-files': { type: 'string' },
  'max-chars': { type: 'string' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function positiveInt(value, flag) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new UsageError(`${flag} must be a positive integer, got "${value}".`);
  return Number(value);
}

const fmt = (n) => n.toLocaleString('en-US');
const listOr = (items, fallback = 'none detected') => (items.length ? items.join(', ') : fallback);

function printSummary(result) {
  const { analysis: a, scan } = result;
  const entries = [...a.entryPoints.confirmed.map((e) => `${e.path} (${e.evidence})`), ...a.entryPoints.inferred.map((e) => `${e.path} (inferred)`)];
  const lines = [
    `RepoBrief analysis: ${a.name}`,
    `  Languages:        ${listOr(a.languages.map((l) => `${l.name} (${l.files})`))}`,
    `  Frameworks:       ${listOr(a.frameworks.map((f) => `${f.name} (${f.evidence})`))}`,
    `  Build/test:       ${listOr([...a.buildTools, ...a.testTools].map((t) => t.name))}`,
    `  Dependencies:     ${listOr(a.dependencies, 'none')}`,
    `  Repository files: ${fmt(scan.totalFiles)}`,
    `  Selected files:   ${fmt(result.selected.length)} of ${fmt(scan.files.length)} eligible`,
    `  Excluded files:   ${fmt(scan.excluded.length)}`,
    `  Approx. output:   ${fmt(result.chars)} characters (~${fmt(result.approxTokens)} tokens, estimated at 4 chars/token)`,
    `  Entry points:     ${listOr(entries)}`,
  ];
  console.log(lines.join('\n'));
}

function printDiagnostics(result) {
  for (const w of result.warnings) console.error(`warning: ${w}`);
  for (const e of result.errors) console.error(`error: ${e}`);
}

function run(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    console.error(`error: ${err.message}\nRun "repobrief --help" for usage.`);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(version);
    return EXIT_OK;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }

  const [command, target = '.', ...extra] = positionals;
  if (!['generate', 'analyze'].includes(command)) {
    console.error(`error: Unknown command "${command}". Use "generate" or "analyze".\nRun "repobrief --help" for usage.`);
    return EXIT_USAGE;
  }
  if (extra.length) {
    console.error(`error: Unexpected arguments: ${extra.join(' ')}. Pass a single repository path.`);
    return EXIT_USAGE;
  }

  try {
    const options = {
      output: values.output,
      maxFiles: positiveInt(values['max-files'], '--max-files'),
      maxChars: positiveInt(values['max-chars'], '--max-chars'),
      include: values.include,
      exclude: values.exclude,
      json: values.json,
    };

    if (command === 'analyze') {
      const result = buildBrief(target, { ...options, json: false });
      if (values.json) {
        const { analysis, scan, selected, chars, approxTokens } = result;
        console.log(JSON.stringify({
          project: analysis,
          stats: { totalFiles: scan.totalFiles, eligibleFiles: scan.files.length, excludedFiles: scan.excluded.length, selectedFiles: selected.length, approxChars: chars, approxTokens },
        }, null, 2));
      } else {
        printSummary(result);
      }
      printDiagnostics(result);
      return result.errors.length ? EXIT_ERROR : EXIT_OK;
    }

    // generate: validate the output location before doing any work.
    if (!values['dry-run']) {
      const root = resolveTarget(target);
      const outputPath = values.output ? path.resolve(values.output) : defaultOutputPath(root, values.json);
      checkOutputPath(outputPath, root, values.force);
    }

    const result = buildBrief(target, options);

    if (values['dry-run']) {
      if (values.json) {
        console.log(JSON.stringify({
          dryRun: true,
          output: result.outputPath,
          format: result.format,
          approxChars: result.chars,
          approxTokens: result.approxTokens,
          selected: result.selected.map((f) => ({ path: f.path, reason: f.reason })),
          omitted: result.omitted,
          excludedFiles: result.scan.excluded.length,
        }, null, 2));
      } else {
        printSummary(result);
        console.log(`\nDry run: would write ${result.format} to ${result.outputPath}`);
        console.log('Files that would be included:');
        for (const f of result.selected) console.log(`  ${f.path} — ${f.reason}`);
        if (result.omitted.length) {
          console.log('Files omitted by size limits:');
          for (const f of result.omitted) console.log(`  ${f.path} (${f.reason})`);
        }
      }
      printDiagnostics(result);
      return result.errors.length ? EXIT_ERROR : EXIT_OK;
    }

    try {
      writeBrief(result, { force: values.force });
    } catch (err) {
      if (err instanceof UsageError) throw err;
      console.error(`error: Could not write ${result.outputPath}: ${err.code || err.message}. Check the path and permissions.`);
      return EXIT_ERROR;
    }
    console.log(`Wrote ${result.outputPath}`);
    console.log(`  ${result.selected.length} files included, ${result.omitted.length} omitted by size limits, ${result.scan.excluded.length} excluded`);
    console.log(`  ${fmt(result.chars)} characters (~${fmt(result.approxTokens)} tokens, estimated at 4 chars/token)`);
    printDiagnostics(result);
    return result.errors.length ? EXIT_ERROR : EXIT_OK;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}`);
      return EXIT_USAGE;
    }
    console.error(`error: ${err.message}`);
    return EXIT_ERROR;
  }
}

process.exitCode = run(process.argv.slice(2));
