import path from 'node:path';

const LANGUAGES = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript (JSX)',
  '.ts': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript', '.tsx': 'TypeScript (TSX)',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin',
  '.swift': 'Swift', '.php': 'PHP', '.cs': 'C#', '.c': 'C', '.h': 'C/C++ Header', '.cpp': 'C++',
  '.vue': 'Vue', '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML',
  '.sh': 'Shell', '.sql': 'SQL', '.md': 'Markdown', '.json': 'JSON', '.yml': 'YAML', '.yaml': 'YAML',
};

export const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.php', '.cs', '.c', '.cpp', '.vue', '.svelte', '.sh',
]);

const FRAMEWORKS = {
  next: 'Next.js', react: 'React', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit',
  '@angular/core': 'Angular', express: 'Express', fastify: 'Fastify', koa: 'Koa', '@nestjs/core': 'NestJS',
  hono: 'Hono', electron: 'Electron', 'react-native': 'React Native', astro: 'Astro', '@remix-run/react': 'Remix',
};

const BUILD_TOOLS = {
  vite: 'Vite', webpack: 'webpack', rollup: 'Rollup', esbuild: 'esbuild', typescript: 'TypeScript compiler',
  '@babel/core': 'Babel', tsup: 'tsup', parcel: 'Parcel', turbo: 'Turborepo',
};

const TEST_TOOLS = {
  jest: 'Jest', vitest: 'Vitest', mocha: 'Mocha', ava: 'AVA', '@playwright/test': 'Playwright', cypress: 'Cypress',
};

const PYTHON_FRAMEWORKS = { django: 'Django', flask: 'Flask', fastapi: 'FastAPI' };

export const ROUTE_PATTERN = /(^|\/)(routes?|api|controllers?|handlers?|endpoints?)\/|(^|\/)app\/(.*\/)?route\.[jt]sx?$/;
const ENTRY_NAMES = new Set(['index', 'main', 'app', 'server', 'cli']);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readmeSummary(content) {
  const paragraphs = content.split(/\r?\n\s*\r?\n/);
  for (const p of paragraphs) {
    const text = p.trim();
    if (!text || /^(#|!\[|\[!\[|<|```|---|\|)/.test(text)) continue;
    const flat = text.replace(/\s+/g, ' ');
    return flat.length > 500 ? flat.slice(0, 497) + '...' : flat;
  }
  return null;
}

function detectIndentation(files) {
  const counts = { tabs: 0, '2 spaces': 0, '4 spaces': 0 };
  let sampled = 0;
  for (const file of files) {
    if (!CODE_EXTENSIONS.has(path.extname(file.path))) continue;
    const line = file.content.split('\n').find((l) => /^(\t|  )\S|^ {4}\S/.test(l));
    if (!line) continue;
    sampled++;
    if (line.startsWith('\t')) counts.tabs++;
    else if (/^ {4}\S/.test(line)) counts['4 spaces']++;
    else counts['2 spaces']++;
  }
  if (sampled < 3) return null;
  const [style, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return `Indentation appears to be ${style} (first indented line in ${count} of ${sampled} code files).`;
}

/**
 * Derives facts about the repository from its scanned files. Everything returned
 * here is backed by a file in the repository; inferred items are labelled as such.
 */
export function analyzeRepository(scan) {
  const byPath = new Map(scan.files.map((f) => [f.path, f]));
  const allPaths = new Set([...scan.files.map((f) => f.path), ...scan.excluded.map((f) => f.path)]);
  const pkgFile = byPath.get('package.json');
  const pkg = pkgFile ? parseJson(pkgFile.content) : null;

  const languageCounts = {};
  for (const file of scan.files) {
    const lang = LANGUAGES[path.extname(file.path).toLowerCase()];
    if (lang) languageCounts[lang] = (languageCounts[lang] || 0) + 1;
  }
  const languages = Object.entries(languageCounts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, files]) => ({ name, files }));

  const deps = { ...(pkg?.dependencies || {}) };
  const devDeps = { ...(pkg?.devDependencies || {}) };
  const allDeps = { ...devDeps, ...deps };
  const pick = (table) =>
    Object.keys(table)
      .filter((name) => name in allDeps)
      .map((name) => ({ name: table[name], package: name, evidence: name in deps ? 'package.json dependencies' : 'package.json devDependencies' }));

  const frameworks = pick(FRAMEWORKS);
  const requirements = byPath.get('requirements.txt')?.content || byPath.get('pyproject.toml')?.content || '';
  for (const [name, label] of Object.entries(PYTHON_FRAMEWORKS)) {
    if (new RegExp(`^\\s*["']?${name}\\b`, 'im').test(requirements)) {
      frameworks.push({ name: label, package: name, evidence: byPath.has('requirements.txt') ? 'requirements.txt' : 'pyproject.toml' });
    }
  }

  const buildTools = pick(BUILD_TOOLS);
  const testTools = pick(TEST_TOOLS);
  if (pkg?.scripts?.test && /\bnode\s+--test\b/.test(pkg.scripts.test)) {
    testTools.push({ name: 'Node.js test runner', package: 'node:test', evidence: 'package.json scripts.test' });
  }
  for (const [file, label] of [['go.mod', 'Go modules'], ['Cargo.toml', 'Cargo'], ['pyproject.toml', 'pyproject.toml'], ['Makefile', 'Make'], ['Dockerfile', 'Docker']]) {
    if (byPath.has(file)) buildTools.push({ name: label, package: null, evidence: file });
  }

  const dependencies = Object.keys(deps).sort();
  const devDependencies = Object.keys(devDeps).sort();

  // Entry points: confirmed from package.json fields, inferred from file names.
  const confirmed = [];
  const addConfirmed = (p, evidence) => {
    if (typeof p !== 'string') return;
    const rel = p.replace(/^\.\//, '');
    if (allPaths.has(rel) && !confirmed.some((e) => e.path === rel)) confirmed.push({ path: rel, evidence });
  };
  if (pkg) {
    addConfirmed(pkg.main, 'package.json "main"');
    addConfirmed(pkg.module, 'package.json "module"');
    if (typeof pkg.bin === 'string') addConfirmed(pkg.bin, 'package.json "bin"');
    else for (const [name, p] of Object.entries(pkg.bin || {})) addConfirmed(p, `package.json "bin" (${name})`);
    if (typeof pkg.exports === 'string') addConfirmed(pkg.exports, 'package.json "exports"');
    else if (pkg.exports && typeof pkg.exports['.'] === 'string') addConfirmed(pkg.exports['.'], 'package.json "exports"');
    for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
      const match = /\b(?:node|tsx|ts-node|nodemon|bun)\s+(\S+\.[cm]?[jt]s)\b/.exec(cmd);
      if (match) addConfirmed(match[1], `package.json scripts.${name}`);
    }
  }
  const inferred = scan.files
    .filter((f) => {
      const parts = f.path.split('/');
      const base = path.basename(f.path, path.extname(f.path));
      return CODE_EXTENSIONS.has(path.extname(f.path)) && ENTRY_NAMES.has(base) && parts.length <= 2 &&
        !confirmed.some((e) => e.path === f.path);
    })
    .map((f) => ({ path: f.path, evidence: 'conventional entry file name' }));

  const routes = scan.files.filter((f) => CODE_EXTENSIONS.has(path.extname(f.path)) && ROUTE_PATTERN.test(f.path)).map((f) => f.path);

  // Conventions backed by configuration or observed source files.
  const conventions = [];
  if (pkg?.type === 'module') conventions.push('ES modules ("type": "module" in package.json).');
  if (pkg?.type === 'commonjs') conventions.push('CommonJS modules ("type": "commonjs" in package.json).');
  if (pkg?.engines?.node) conventions.push(`Node.js version requirement: ${pkg.engines.node} (package.json "engines").`);
  const tsconfig = byPath.get('tsconfig.json');
  if (tsconfig) {
    conventions.push(/"strict"\s*:\s*true/.test(tsconfig.content) ? 'TypeScript strict mode enabled (tsconfig.json).' : 'TypeScript configured (tsconfig.json).');
  }
  for (const file of scan.files) {
    const name = file.path.split('/').pop();
    if (file.path.includes('/')) continue;
    if (/^(\.eslintrc(\..+)?|eslint\.config\.[cm]?[jt]s)$/.test(name)) conventions.push(`ESLint configured (${name}).`);
    if (/^(\.prettierrc(\..+)?|prettier\.config\.[cm]?js)$/.test(name)) conventions.push(`Prettier configured (${name}).`);
    if (name === '.editorconfig') {
      const settings = file.content.split('\n').filter((l) => /^\s*(indent_style|indent_size|end_of_line|charset)\s*=/.test(l)).map((l) => l.trim());
      conventions.push(`EditorConfig present${settings.length ? `: ${[...new Set(settings)].join(', ')}` : ''}.`);
    }
  }
  if (pkg?.prettier) conventions.push('Prettier configured ("prettier" key in package.json).');
  const indentation = detectIndentation(scan.files);
  if (indentation) conventions.push(indentation);
  const testFiles = scan.files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f.path));
  if (testFiles.length) {
    const spec = testFiles.filter((f) => /\.spec\./.test(f.path)).length;
    const style = spec > testFiles.length / 2 ? '*.spec.*' : '*.test.*';
    conventions.push(`Test files use the ${style} naming pattern (${testFiles.length} test files found).`);
  }
  for (const tool of testTools) conventions.push(`Tests run with ${tool.name} (${tool.evidence}).`);

  const readmeFile = scan.files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f.path));
  const docs = scan.files
    .filter((f) => /\.(md|markdown|rst|txt)$/i.test(f.path) && (/^docs?\//i.test(f.path) || /^(architecture|contributing|design)/i.test(f.path)))
    .map((f) => f.path);

  return {
    name: pkg?.name || path.basename(scan.root),
    version: pkg?.version || null,
    description: pkg?.description || null,
    license: pkg?.license || null,
    readmePath: readmeFile?.path || null,
    readmeSummary: readmeFile ? readmeSummary(readmeFile.content) : null,
    docs,
    languages,
    frameworks,
    buildTools,
    testTools,
    dependencies,
    devDependencies,
    scripts: pkg?.scripts || {},
    entryPoints: { confirmed, inferred },
    routes,
    conventions,
  };
}
