// Minimal gitignore-style pattern matching. Supports `*`, `**`, `?`, `[...]`,
// negation (`!`), directory-only patterns (trailing `/`) and anchoring (`/`).

export function globToRegexSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
      } else {
        let cls = glob.slice(i + 1, end).replace(/\\/g, '\\\\');
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += `[${cls}]`;
        i = end;
      }
    } else if ('\\^$.|+(){}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return out;
}

export function compilePattern(line, base = '') {
  let pattern = line.replace(/\s+$/, '');
  if (!pattern || pattern.startsWith('#')) return null;

  let negate = false;
  if (pattern.startsWith('!')) {
    negate = true;
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith('\\')) pattern = pattern.slice(1);

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.replace(/\/+$/, '');
  }

  const anchored = pattern.includes('/');
  pattern = pattern.replace(/^\/+/, '');
  if (!pattern) return null;

  const source = globToRegexSource(pattern);
  const regex = new RegExp(anchored ? `^${source}$` : `^(?:.*/)?${source}$`);
  return { regex, negate, dirOnly, base };
}

export function parseIgnoreFile(text, base = '') {
  return text
    .split(/\r?\n/)
    .map((line) => compilePattern(line, base))
    .filter(Boolean);
}

function relativeToBase(relPath, base) {
  if (!base) return relPath;
  if (relPath.startsWith(base + '/')) return relPath.slice(base.length + 1);
  return null;
}

// Returns true if ignored, false if explicitly re-included, undefined if no rule matched.
export function matchRules(rules, relPath, isDir) {
  let result;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const p = relativeToBase(relPath, rule.base);
    if (p === null) continue;
    if (rule.regex.test(p)) result = !rule.negate;
  }
  return result;
}

export function matchesAny(patterns, relPath) {
  return patterns.some((rule) => rule.regex.test(relPath));
}
