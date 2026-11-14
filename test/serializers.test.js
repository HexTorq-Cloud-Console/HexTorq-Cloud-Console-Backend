import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAgentStatus, heartbeatMeta, serializeAgent, serializeService } from '../src/serializers.js';

const STALE = 120000;

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    name: 'VPS-1',
    baseUrl: 'https://10.0.0.5:9100',
    enabled: true,
    lastSeenAt: new Date(Date.now() - 1000),
    apiKeyHash: 'hash',
    apiKeyEncrypted: 'enc.secret.value',
    enrollmentToken: 'enroll-token',
    ...overrides,
  };
}

function service(overrides = {}) {
  return {
    id: 'svc-1',
    name: 'API',
    slug: 'api',
    type: 'PM2',
    repositoryUrl: 'https://github.com/acme/api.git',
    workingDirectory: '/srv/api',
    pm2ProcessName: 'api',
    webhookSecretHash: 'super-secret-hash',
    clientControlEnabled: true,
    clientId: 'client-1',
    client: { id: 'client-1', name: 'Acme', email: 'acme@example.com', passwordHash: 'bcrypt-hash', googleSubject: 'sub' },
    agent: agent(),
    ...overrides,
  };
}

test('agent status follows heartbeat, enabled precedence', () => {
  assert.equal(resolveAgentStatus(agent(), STALE), 'online');
  assert.equal(resolveAgentStatus(agent({ lastSeenAt: new Date(Date.now() - STALE * 5) }), STALE), 'offline');
  assert.equal(resolveAgentStatus(agent({ lastSeenAt: null }), STALE), 'unknown');
  assert.equal(resolveAgentStatus(agent({ enabled: false }), STALE), 'disabled');
});

test('heartbeat metadata reports age and threshold', () => {
  const meta = heartbeatMeta(agent({ lastSeenAt: new Date(Date.now() - 60000) }), STALE);
  assert.equal(meta.status, 'online');
  assert.equal(meta.staleThresholdSeconds, 120);
  assert.ok(meta.heartbeatAgeSeconds >= 59 && meta.heartbeatAgeSeconds <= 61);
});

test('CLIENT agent view never exposes baseUrl or secrets', () => {
  const out = serializeAgent(agent(), { role: 'CLIENT', staleThresholdMs: STALE });
  assert.equal(out.baseUrl, undefined);
  assert.equal(out.apiKeyEncrypted, undefined);
  assert.equal(out.apiKeyHash, undefined);
  assert.equal(out.enrollmentToken, undefined);
  assert.equal(out.status, 'online');
});

test('SUPER_ADMIN agent view keeps baseUrl but still strips secrets', () => {
  const out = serializeAgent(agent(), { role: 'SUPER_ADMIN', staleThresholdMs: STALE });
  assert.equal(out.baseUrl, 'https://10.0.0.5:9100');
  assert.equal(out.apiKeyEncrypted, undefined);
  assert.equal(out.apiKeyHash, undefined);
  assert.equal(out.enrollmentToken, undefined);
});

test('CLIENT service view strips webhook secret, passwordHash and agent baseUrl', () => {
  const out = serializeService(service(), { role: 'CLIENT', staleThresholdMs: STALE });
  assert.equal(out.webhookSecretHash, undefined);
  assert.equal(out.client.passwordHash, undefined);
  assert.equal(out.client.googleSubject, undefined);
  assert.equal(out.agent.baseUrl, undefined);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('super-secret-hash'));
  assert.ok(!json.includes('bcrypt-hash'));
  assert.ok(!json.includes('10.0.0.5'));
});

test('CLIENT service view keeps its own operational identity', () => {
  const out = serializeService(service(), { role: 'CLIENT', staleThresholdMs: STALE });
  assert.equal(out.id, 'svc-1');
  assert.equal(out.name, 'API');
  assert.equal(out.pm2ProcessName, 'api');
  assert.equal(out.client.email, 'acme@example.com');
  assert.equal(out.agent.name, 'VPS-1');
});
