#!/usr/bin/env node
// Encrypt the hierarchy data into a single bundle the page can decrypt in-browser.
//
//   SITE_PASSWORD='...' node tools/encrypt.mjs
//
// Produces data/bundle.enc.json. AES-256-GCM with a key derived by PBKDF2-SHA256
// (600k iterations, random 16-byte salt); random 12-byte IV per bundle. Uses the
// same WebCrypto API the browser does, so there is no interop guesswork.
//
// This is a single shared password, not per-person auth: it is only as good as the
// list of people you send it to, and it cannot be revoked from anyone who already
// has it without re-encrypting and redistributing. That is an accepted trade-off
// for non-sensitive data — see README.

import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ITERATIONS = 600000;

const password = process.env.SITE_PASSWORD;
if (!password) {
  console.error('SITE_PASSWORD is not set. Run:\n  SITE_PASSWORD=\'your-password\' node tools/encrypt.mjs');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Refusing to use a password shorter than 8 characters.');
  process.exit(1);
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

const payload = JSON.stringify({
  current: JSON.parse(readFileSync(join(ROOT, 'data/current.json'), 'utf8')),
  proposed: JSON.parse(readFileSync(join(ROOT, 'data/proposed.json'), 'utf8'))
});

const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));

const baseKey = await crypto.subtle.importKey(
  'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
  baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);

const ct = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv }, key, new TextEncoder().encode(payload));

writeFileSync(join(ROOT, 'data/bundle.enc.json'), JSON.stringify({
  v: 1,
  note: 'AES-256-GCM. Key = PBKDF2-SHA256(password, salt, iterations). Decrypted in-browser only.',
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) },
  iv: b64(iv),
  ct: b64(ct)
}, null, 1) + '\n');

console.log(`data/bundle.enc.json written — ${(payload.length / 1024).toFixed(0)} KB plaintext ` +
            `-> ${(ct.byteLength / 1024).toFixed(0)} KB ciphertext, ${ITERATIONS.toLocaleString()} PBKDF2 iterations.`);
