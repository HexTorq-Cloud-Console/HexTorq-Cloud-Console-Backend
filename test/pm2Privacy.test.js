import test from 'node:test';
import assert from 'node:assert/strict';
import { clientPm2Status, adminPm2Metrics, matchProcessesToServices, clientPm2Batch } from '../src/pm2.js';

const FORBIDDEN = ['cpu', 'cpuPercent', 'memory', 'memoryBytes', 'memoryMb', 'rss', 'memoryRss'];

function assertNoResourceMetrics(value) {
  const json = JSON.stringify(value);
  for (const key of FORBIDDEN) {
    assert.ok(!json.includes(`"${key}"`), `client payload leaked ${key}: ${json}`);
  }
}

const rawProcess = { status: 'online', uptime: 1784000000000, restarts: 2, cpu: 12.5, memory: 450000000 };

test('CLIENT PM2 status DTO contains no cpu/memory fields', () => {
  const out = clientPm2Status({ serviceId: 'svc-1', raw: rawProcess, telemetryAvailable: true, telemetryStale: false });
  assert.equal(out.status, 'online');
  assert.equal(out.uptime, 1784000000000);
  assert.equal(out.restarts, 2);
  assertNoResourceMetrics(out);
});

test('CLIENT batch DTO contains no cpu/memory fields', () => {
  const matched = matchProcessesToServices([{ name: 'api', status: 'online', cpu: 12.5, memory: 450000000, uptime: 1, restarts: 0 }], [{ id: 'svc-1', name: 'API', pm2ProcessName: 'api' }]);
  const out = clientPm2Batch(matched);
  assert.equal(out['svc-1'].status, 'online');
  assertNoResourceMetrics(out);
});

test('admin metrics expose cpu/memory and convert memory to MB', () => {
  const out = adminPm2Metrics({ serviceId: 'svc-1', agentId: 'agent-1', processName: 'api', raw: rawProcess, collectedAt: '2026-01-01T00:00:00.000Z', available: true });
  assert.equal(out.cpuPercent, 12.5);
  assert.equal(out.memoryBytes, 450000000);
  assert.equal(out.memoryMb, 429.15);
  assert.equal(out.restarts, 2);
  assert.equal(out.available, true);
});

test('unavailable admin metrics are null, never zero', () => {
  const out = adminPm2Metrics({ serviceId: 'svc-1', agentId: 'agent-1', processName: 'api', raw: null, collectedAt: '2026-01-01T00:00:00.000Z', available: false, reason: 'Agent is offline' });
  assert.equal(out.cpuPercent, null);
  assert.equal(out.memoryBytes, null);
  assert.equal(out.memoryMb, null);
  assert.equal(out.restarts, null);
  assert.equal(out.available, false);
  assert.equal(out.reason, 'Agent is offline');
});

test('process matching drops unregistered processes', () => {
  const matched = matchProcessesToServices(
    [{ name: 'api', status: 'online' }, { name: 'rogue', status: 'online' }],
    [{ id: 'svc-1', name: 'API', pm2ProcessName: 'api' }],
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].processName, 'api');
});
