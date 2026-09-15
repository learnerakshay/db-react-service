#!/usr/bin/env node
// Generate one Mission Control operator bearer token and its OPERATOR_TOKENS entry.
//
//   npm run operator:token -- <id> <OPERATOR|ADMIN>
//
// The raw token is printed once for the operator and is not stored anywhere.
// Only the SHA-256 entry goes into OPERATOR_TOKENS (secret manager / .env).

import { createHash, randomBytes } from 'node:crypto';

const [id, role] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id ?? '') || !['OPERATOR', 'ADMIN'].includes(role ?? '')) {
  console.error('usage: npm run operator:token -- <id: lowercase, 1-64 chars> <OPERATOR|ADMIN>');
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(token, 'utf8').digest('hex');

console.log(`Bearer token for "${id}" (hand to the operator once; it is not stored):`);
console.log(token);
console.log('');
console.log('OPERATOR_TOKENS entry (comma-separate multiple operators):');
console.log(`${id}:${role}:${hash}`);
