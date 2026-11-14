import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeploymentEventOwnership, completionDecision, validateLogMessage, MAX_LOG_MESSAGE_LENGTH } from '../src/eventOwnership.js';

const service = { id: 'svc-1' };

test('valid ownership passes', () => {
  const result = validateDeploymentEventOwnership({ deployment: { serviceId: 'svc-1', agentId: 'agent-1' }, service, agentId: 'agent-1' });
  assert.equal(result.ok, true);
});

test('unknown deployment is rejected', () => {
  const result = validateDeploymentEventOwnership({ deployment: null, service, agentId: 'agent-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 404);
});

test('mismatched service is rejected', () => {
  const result = validateDeploymentEventOwnership({ deployment: { serviceId: 'svc-2', agentId: 'agent-1' }, service, agentId: 'agent-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
});

test('mismatched agent is rejected', () => {
  const result = validateDeploymentEventOwnership({ deployment: { serviceId: 'svc-1', agentId: 'agent-9' }, service, agentId: 'agent-1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 409);
});

test('completion is idempotent for terminal deployments', () => {
  assert.deepEqual(completionDecision('DEPLOYING'), { apply: true, reason: 'accepted' });
  assert.equal(completionDecision('SUCCESS').apply, false);
  assert.equal(completionDecision('FAILED').apply, false);
  assert.equal(completionDecision('ERROR').apply, false);
});

test('oversized log messages are rejected', () => {
  const big = 'x'.repeat(MAX_LOG_MESSAGE_LENGTH + 1);
  assert.equal(validateLogMessage(big).ok, false);
  assert.equal(validateLogMessage('ok').ok, true);
  assert.equal(validateLogMessage(undefined).ok, true);
});
