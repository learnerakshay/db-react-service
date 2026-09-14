#!/usr/bin/env node
// Pre-commit / CI guard against committing secrets.
// 1. No real .env files may be tracked or unignored.
// 2. .env.example must contain empty placeholders only.
// 3. Files git would commit must not contain obvious credential patterns.
// ponytail: pattern list is a tripwire, not a full scanner; add gitleaks in CI if needed.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const problems = [];

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

for (const file of files) {
  const name = file.split('/').pop();
  if (name.startsWith('.env') && name !== '.env.example') {
    problems.push(`${file}: environment file is not ignored`);
  }
}

readFileSync('.env.example', 'utf8')
  .split(/\r?\n/)
  .forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (!/^[A-Z][A-Z0-9_]*=$/.test(trimmed)) {
      problems.push(`.env.example:${index + 1}: must be an empty placeholder (KEY=)`);
    }
  });

const patterns = [
  ['OpenAI-style API key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Twilio account SID', /\bAC[0-9a-f]{32}\b/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    'database URL with inline password',
    /postgres(?:ql)?:\/\/(?!USER:PASSWORD@)[^\s:/@'"]+:[^\s@'"]+@/,
  ],
];

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|lock)$/i;

for (const file of files) {
  if (BINARY.test(file) || file === 'package-lock.json' || file === 'scripts/check-secrets.mjs')
    continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // Deleted-but-tracked files show up in ls-files; anything else is a real failure.
    if (err.code === 'ENOENT') continue;
    throw err;
  }
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) problems.push(`${file}: possible ${label}`);
  }
}

if (problems.length > 0) {
  console.error(`Secret check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`Secret check passed (${files.length} files scanned).`);
