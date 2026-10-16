// Secret protection: files are excluded by name or when their content matches a
// common secret pattern. Matched values are never returned or printed.

const SECRET_FILE_NAMES = new Set([
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.htpasswd',
  'credentials',
  'credentials.json',
  'secrets.json',
  'secrets.yml',
  'secrets.yaml',
  'service-account.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SECRET_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.asc', '.gpg', '.ppk'];

const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private keys
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, // Slack tokens
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/, // Stripe live keys
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API keys
  /\bsk-[A-Za-z0-9_-]{32,}\b/, // OpenAI / Anthropic style keys
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm tokens
  // Generic assignments such as API_KEY = "abcd1234..." with a long literal value.
  /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd)[A-Za-z0-9_]*["']?\s*[:=]\s*["'][^"'\s]{16,}["']/i,
];

export function isSecretFileName(relPath) {
  const name = relPath.split('/').pop().toLowerCase();
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (SECRET_FILE_NAMES.has(name)) return true;
  return SECRET_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export function containsSecret(content) {
  return SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(content));
}
