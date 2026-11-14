import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, createLineRedactor, REDACTED } from '../src/redact.js';

test('redacts bearer tokens', () => {
  const out = redactSecrets('curl -H "Authorization: Bearer abcdef1234567890XYZ"');
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes('abcdef1234567890XYZ'));
});

test('redacts key=value secrets but keeps the key and message', () => {
  const out = redactSecrets('connecting password=Sup3rSecret host=db');
  assert.ok(out.includes('password=' + REDACTED));
  assert.ok(out.includes('host=db'));
  assert.ok(!out.includes('Sup3rSecret'));
});

test('redacts JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  assert.equal(redactSecrets(`token ${jwt}`), `token ${REDACTED}`);
});

test('redacts passwords inside connection URLs', () => {
  const out = redactSecrets('postgresql://user:hunter2@db.internal:5432/app');
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes('user:'));
  assert.ok(out.includes('@db.internal:5432/app'));
});

test('redacts PEM private keys', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redactSecrets(pem), REDACTED);
});

test('preserves ordinary error text and stack traces', () => {
  const line = 'TypeError: Cannot read properties of undefined\n    at /app/server.js:42:11';
  assert.equal(redactSecrets(line), line);
});

test('line redactor holds a secret split across chunks', () => {
  const redactor = createLineRedactor();
  assert.equal(redactor.push('Authorization: Bearer '), '');
  const out = redactor.push('abcdef1234567890\nnext line\n');
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes('abcdef1234567890'));
  assert.ok(out.includes('next line'));
  assert.equal(redactor.flush(), '');
});

test('line redactor flushes a trailing partial line', () => {
  const redactor = createLineRedactor();
  assert.equal(redactor.push('password=topsecret'), '');
  assert.equal(redactor.flush(), 'password=' + REDACTED);
});
