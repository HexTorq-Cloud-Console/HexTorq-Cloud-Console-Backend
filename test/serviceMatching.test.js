import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchServiceForEvent } from '../src/serviceMatching.js';

const services = [
  { id: 'a', projectKey: 'app-a', templateKey: 'node-backend' },
  { id: 'b', projectKey: 'app-b', templateKey: 'node-backend' },
  { id: 'c', projectKey: 'app-c', templateKey: 'static-site' },
];

test('exact projectKey match wins for the agent', () => {
  const result = matchServiceForEvent(services, 'app-b');
  assert.equal(result.conflict, undefined);
  assert.equal(result.match?.id, 'b');
});

test('falls back to a single unique template key match', () => {
  const result = matchServiceForEvent(services, 'static-site');
  assert.equal(result.conflict, undefined);
  assert.equal(result.match?.id, 'c');
});

test('rejects ambiguous template matches instead of selecting one', () => {
  const result = matchServiceForEvent(services, 'node-backend');
  assert.equal(result.match, undefined);
  assert.equal(result.conflict, true);
  assert.deepEqual(result.candidates?.sort(), ['a', 'b']);
});

test('unknown project keys return no match', () => {
  const result = matchServiceForEvent(services, 'missing');
  assert.equal(result.match, null);
  assert.equal(result.conflict, undefined);
});

test('empty services and missing keys return no match', () => {
  assert.equal(matchServiceForEvent([], 'anything').match, null);
  assert.equal(matchServiceForEvent(services, '').match, null);
  assert.equal(matchServiceForEvent(services, null).match, null);
});