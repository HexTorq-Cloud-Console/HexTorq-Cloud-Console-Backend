// Executes the real analytics SQL from `src/analytics.js` against an in-process
// PostgreSQL engine (PGlite, WASM Postgres). This proves the parameterized
// aggregation actually runs and is tenant-scoped, without needing a live DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { buildAnalytics } from '../src/analytics.js';

async function harness() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "Service" (id text primary key, name text, "clientId" text, type text, enabled boolean, "pm2ProcessName" text);
    CREATE TABLE "ServerAgent" (id text primary key, name text, enabled boolean, "lastSeenAt" timestamp, "baseUrl" text);
    CREATE TABLE "Deployment" (id text primary key, "runId" text, "serviceId" text, "agentId" text, status text, "triggerSource" text, "startedAt" timestamp, "completedAt" timestamp, "durationMs" integer);
  `);
  await db.exec(`
    INSERT INTO "Service" VALUES
      ('s1','API','c1','PM2',true,'api'),
      ('s2','Web','c1','STATIC_FRONTEND',true,null),
      ('s3','Other','c2','PM2',true,'other');
    INSERT INTO "ServerAgent" VALUES
      ('a1','VPS-1',true, now(), 'https://10.0.0.1'),
      ('a2','VPS-2',true, now() - interval '1 day', 'https://10.0.0.2');
  `);
  const now = new Date();
  const at = (days, hour = 0) => { const x = new Date(now); x.setUTCDate(x.getUTCDate() - days); x.setUTCHours(hour, 0, 0, 0); return x.toISOString(); };
  const rows = [
    ['d1', 'r1', 's1', 'a1', 'SUCCESS', 'console', at(0), at(0), 30000],
    ['d2', 'r2', 's1', 'a1', 'FAILED', 'webhook', at(1), at(1), 12000],
    ['d3', 'r3', 's1', 'a1', 'SUCCESS', 'console', at(2), at(2), 45000],
    ['d4', 'r4', 's1', 'a1', 'ERROR', 'console', at(3), at(3), 8000],
    ['d5', 'r5', 's2', 'a1', 'SUCCESS', 'console', at(4), at(4), 6000],
    ['d9', 'r9', 's1', 'a1', 'SUCCESS', 'console', at(9), at(9), 20000],
    ['d16', 'r16', 's1', 'a1', 'SUCCESS', 'console', at(16), at(16), 25000],
    ['d10', 'r10', 's3', 'a2', 'SUCCESS', 'console', at(0), at(0), 11000],
    ['d11', 'r11', 's3', 'a2', 'FAILED', 'console', at(1), at(1), 9000],
    ['d12', 'r12', 's1', 'a1', 'DEPLOYING', 'console', now.toISOString(), null, null],
  ];
  for (const r of rows) {
    await db.query(`INSERT INTO "Deployment" (id,"runId","serviceId","agentId",status,"triggerSource","startedAt","completedAt","durationMs") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, r);
  }

  const fakePrisma = {
    async $queryRaw(strings, ...values) {
      let text = '';
      strings.forEach((chunk, i) => { text += chunk; if (i < values.length) text += `$${i + 1}`; });
      const params = values.map((v) => (v instanceof Date ? v.toISOString() : v));
      const result = await db.query(text, params);
      return result.rows;
    },
    service: {
      async findMany({ where }) {
        return (await db.query('SELECT type, enabled FROM "Service"' + (where?.clientId ? ' WHERE "clientId"=$1' : ''), where?.clientId ? [where.clientId] : [])).rows;
      },
    },
    serverAgent: {
      async findMany({ where } = {}) {
        const clientId = where?.services?.some?.clientId;
        const sql = clientId
          ? 'SELECT DISTINCT a.enabled, a."lastSeenAt" FROM "ServerAgent" a JOIN "Deployment" d ON d."agentId"=a.id JOIN "Service" s ON s.id=d."serviceId" WHERE s."clientId"=$1'
          : 'SELECT enabled, "lastSeenAt" FROM "ServerAgent"';
        return (await db.query(sql, clientId ? [clientId] : [])).rows;
      },
    },
  };
  const agentStatus = (a) => (!a.enabled ? 'disabled' : !a.lastSeenAt ? 'unknown' : 'online');
  return { fakePrisma, agentStatus };
}

test('analytics: 24h/7d/30d buckets, previous window, median and tenant scoping', async () => {
  const { fakePrisma, agentStatus } = await harness();
  const client = await buildAnalytics({ prisma: fakePrisma, clientId: 'c1', days: 14, timeZone: 'Asia/Kolkata', agentStatus });
  const global = await buildAnalytics({ prisma: fakePrisma, clientId: null, days: 30, timeZone: 'UTC', agentStatus });

  assert.equal(client.daily.length, 14, 'zero-filled daily buckets for the window');
  assert.equal(client.previousDaily.length, 14, 'previous-window daily buckets');
  assert.equal(client.hourly.length, 24, '24 hourly activity buckets');
  assert.equal(client.previousHourly.length, 24, 'previous 24 hourly buckets');

  assert.equal(client.summary.running, 1, 'active deployments reported separately');
  assert.equal(client.summary.successful, 4);
  assert.equal(client.summary.failed, 2);
  assert.equal(client.summary.total, 7, 'client activity total (start time) excludes other tenants and out-of-window rows');

  assert.equal(client.completedOutcomes.total, 6, 'completed outcomes use completion time');
  assert.equal(client.performance.current.medianDurationMs, 16000, 'median duration current window');

  assert.ok(client.serviceHotspots.every((h) => h.name !== 'Other'), 'tenant hotspots exclude other tenant');
  assert.equal(client.triggerBreakdown.length, 2, 'trigger breakdown groups console/webhook');

  assert.equal(client.agents.total, 1, 'client agent summary is tenant scoped');

  assert.equal(global.summary.total, 10, 'global activity includes every tenant');
  assert.ok(global.services.total >= client.services.total, 'global service count >= tenant');
});
