// HTTP-level integration harness: runs the real backend against an in-process
// PostgreSQL engine (PGlite over the Postgres wire protocol), applies the real
// migrations, then exercises role isolation, CPU/RAM privacy and PM2 control.
//
//   node scripts/integration.mjs
//
// Not part of `npm test` because it boots the full server and Prisma migrate.
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const PG_PORT = 5433;
const API_PORT = 4677;
const BASE = `http://127.0.0.1:${API_PORT}/api`;

let failures = 0;
function check(name, condition, extra = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('close', (code) => resolve(code));
  });
}

function spawnServer(env) {
  const child = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, ...env }, stdio: 'inherit' });
  return child;
}

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}

const db = new PGlite();
const server = new PGLiteSocketServer({ db, port: PG_PORT, host: '127.0.0.1' });
await server.start();
console.log(`PGlite listening on ${PG_PORT}`);

const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres?schema=public&sslmode=disable&connection_limit=1&pool_timeout=30`;
const env = {
  DATABASE_URL,
  JWT_SECRET: 'integration-secret-integration-secret',
  SUPER_ADMIN_EMAIL: 'root@hextorq.test',
  SUPER_ADMIN_PASSWORD: 'super-secret-123',
  AGENT_ENCRYPTION_KEY: 'a'.repeat(64),
  PORT: String(API_PORT),
  AGENT_STALE_THRESHOLD_MS: '120000',
};

console.log('Applying migrations...');
const migrateCode = await run('npx', ['prisma', 'migrate', 'deploy'], { DATABASE_URL });
if (migrateCode !== 0) {
  console.error('migrate deploy failed');
  process.exit(1);
}

const backend = spawnServer(env);
await new Promise((resolve) => setTimeout(resolve, 3500));

async function cleanup() {
  backend.kill();
  if (typeof server.stop === 'function') await server.stop().catch(() => {});
  else if (typeof server.close === 'function') await server.close().catch(() => {});
  await db.close().catch(() => {});
}

try {
  const health = await api('/health');
  check('backend health', health.status === 200 && health.json?.status === 'ok');

  const adminLogin = await api('/auth/login', { method: 'POST', body: { email: env.SUPER_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD } });
  check('super admin login', adminLogin.status === 200 && adminLogin.json?.user?.role === 'SUPER_ADMIN');
  const admin = adminLogin.json.token;

  const c1 = await api('/admin/clients', { method: 'POST', token: admin, body: { name: 'Tenant One', email: 'one@example.com', temporaryPassword: 'password123' } });
  const c2 = await api('/admin/clients', { method: 'POST', token: admin, body: { name: 'Tenant Two', email: 'two@example.com', temporaryPassword: 'password123' } });
  check('create client 1', c1.status === 201, c1.text);
  check('create client 2', c2.status === 201, c2.text);
  const client1 = c1.json.client;
  const client2 = c2.json.client;

  const agentCreate = await api('/admin/agents', { method: 'POST', token: admin, body: { name: 'VPS-A', baseUrl: 'https://10.9.9.9:9100' } });
  check('create agent', agentCreate.status === 201, agentCreate.text);
  const agent = agentCreate.json.agent;
  const enrollmentToken = agentCreate.json.enrollmentToken;
  const enroll = await api('/agents/enroll', { method: 'POST', body: { agentId: agent.id, enrollmentToken, apiKey: 'k'.repeat(40) } });
  check('enroll agent', enroll.status === 200, enroll.text);

  const mkService = (name, slug, clientId, type, processName) => api('/admin/services', {
    method: 'POST', token: admin,
    body: { name, slug, type, repositoryUrl: 'https://github.com/acme/repo.git', projectKey: slug, workingDirectory: `/srv/${slug}`, ...(type === 'PM2' ? { pm2ProcessName: processName } : { deployDirectory: `/var/www/${slug}` }), clientId, agentId: agent.id },
  });
  const svc1 = await mkService('API One', 'api-one', client1.id, 'PM2', 'api-one');
  const svc2 = await mkService('App Two', 'app-two', client2.id, 'PM2', 'app-two');
  const static1 = await mkService('Site One', 'site-one', client1.id, 'STATIC_FRONTEND');
  check('create tenant1 service', svc1.status === 201, svc1.text);
  check('create tenant2 service', svc2.status === 201, svc2.text);
  check('create static service', static1.status === 201, static1.text);
  const service1 = svc1.json.service;

  // Disable client control on service1 via admin PATCH.
  await api(`/admin/services/${service1.id}`, { method: 'PATCH', token: admin, body: { clientControlEnabled: false } });

  const user1Login = await api('/auth/login', { method: 'POST', body: { email: 'one@example.com', password: 'password123' } });
  check('client1 login', user1Login.status === 200 && user1Login.json?.user?.role === 'CLIENT');
  const u1 = user1Login.json.token;

  console.log('\n-- Role isolation --');
  const adminServices = await api('/services', { token: admin });
  check('admin sees all services', (adminServices.json.services || []).length === 3);
  const u1Services = await api('/services', { token: u1 });
  check('client sees only own services', (u1Services.json.services || []).length === 2 && u1Services.json.services.every((s) => s.clientId === client1.id));
  check('client service detail (own)', (await api(`/services/${service1.id}`, { token: u1 })).status === 200);
  check('client cannot read other tenant service', (await api(`/services/${svc2.json.service.id}`, { token: u1 })).status === 404);
  check('client cannot list admin clients', (await api('/admin/clients', { token: u1 })).status === 403);
  check('client cannot list agents', (await api('/admin/agents', { token: u1 })).status === 403);
  check('client cannot read audit logs', (await api('/admin/audit-logs', { token: u1 })).status === 403);
  const u1ServiceJson = JSON.stringify(u1Services.json);
  check('client service payload leaks no agent baseUrl', !u1ServiceJson.includes('10.9.9.9'));
  check('client service payload leaks no webhookSecretHash', !u1ServiceJson.includes('webhookSecretHash'));

  console.log('\n-- CPU/RAM privacy --');
  const u1Status = await api(`/services/${service1.id}/pm2/status`, { token: u1 });
  const statusJson = JSON.stringify(u1Status.json || {});
  check('client pm2/status 200/404 reachable', u1Status.status === 200 || u1Status.status === 404, u1Status.text);
  check('client pm2/status has no cpu', !statusJson.includes('"cpu"'));
  check('client pm2/status has no memory', !statusJson.includes('"memory"'));
  check('client cannot call admin metrics', (await api(`/admin/services/${service1.id}/pm2/metrics`, { token: u1 })).status === 403);
  const adminMetrics = await api(`/admin/services/${service1.id}/pm2/metrics`, { token: admin });
  check('admin metrics endpoint works', adminMetrics.status === 200 && 'cpuPercent' in adminMetrics.json);
  check('admin metrics unavailable are null not zero', adminMetrics.json.available === false && adminMetrics.json.cpuPercent === null && adminMetrics.json.memoryBytes === null);
  const analytics = await api('/analytics?days=7', { token: u1 });
  const analyticsJson = JSON.stringify(analytics.json || {});
  check('client analytics has no cpu/memory', !analyticsJson.includes('"cpuPercent"') && !analyticsJson.includes('"memoryBytes"'));
  check('client analytics scoped', analytics.status === 200);

  console.log('\n-- PM2 control --');
  check('client reload is forbidden', (await api(`/services/${service1.id}/pm2/reload`, { method: 'POST', token: u1 })).status === 403);
  check('client control disabled -> 403', (await api(`/services/${service1.id}/pm2/start`, { method: 'POST', token: u1 })).status === 403);
  check('static service cannot be controlled', (await api(`/services/${static1.json.service.id}/pm2/start`, { method: 'POST', token: u1 })).status === 404);
  check('other tenant service not found', (await api(`/services/${svc2.json.service.id}/pm2/start`, { method: 'POST', token: u1 })).status === 404);

  console.log('\n-- Deployment event ownership --');
  const agentHeaders = { 'X-Agent-Id': agent.id, 'X-Agent-Key': 'k'.repeat(40) };
  const started = await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-started', projectKey: 'api-one', runId: 'run-1', status: 'DEPLOYING' } });
  check('agent can start its own deployment', started.status === 202, started.text);
  const mismatchService = await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-log', projectKey: 'app-two', runId: 'run-1', message: 'sneaky' } });
  check('mismatched service event rejected', mismatchService.status === 409, mismatchService.text);
  const logSecret = await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-log', projectKey: 'api-one', runId: 'run-1', message: 'connecting password=SuperSecret123 now' } });
  check('valid log accepted', logSecret.status === 202, logSecret.text);
  const bigMessage = await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-log', projectKey: 'api-one', runId: 'run-1', message: 'x'.repeat(21000) } });
  check('oversized log rejected', bigMessage.status === 413, bigMessage.text);
  const completed = await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-completed', projectKey: 'api-one', runId: 'run-1', status: 'SUCCESS' } });
  check('completion accepted', completed.status === 202, completed.text);
  const duplicate = await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-completed', projectKey: 'api-one', runId: 'run-1', status: 'FAILED' } });
  check('duplicate completion is idempotent', duplicate.status === 202 && duplicate.json?.duplicate === true, duplicate.text);

  const list = await api('/deployments', { token: u1 });
  const deployment = (list.json.deployments || [])[0];
  check('client sees own deployment', Boolean(deployment));
  const logs = await api(`/deployments/${deployment.id}/logs`, { token: u1 });
  const logsJson = JSON.stringify(logs.json || {});
  check('deployment log secret is redacted', !logsJson.includes('SuperSecret123') && logsJson.includes('[REDACTED]'), logsJson.slice(0, 200));
  check('deployment log service payload has no secret hash', !logsJson.includes('webhookSecretHash'));

  console.log('\n-- In-app notifications --');
  const history = await api('/notifications', { token: u1 });
  check('client notification history persisted', history.status === 200 && (history.json.notifications || []).length >= 1, history.text);
  const unread = await api('/notifications/unread-count', { token: u1 });
  check('client unread count > 0', unread.status === 200 && unread.json.unreadCount >= 1, unread.text);
  const firstNotification = (history.json.notifications || [])[0];
  check('notification payload has no resource metrics', !JSON.stringify(firstNotification || {}).includes('cpu'));

  // Client 2 has its own notifications; client 1 must not reach them.
  await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-started', projectKey: 'app-two', runId: 'run-c2', status: 'DEPLOYING' } });
  await api(`/agents/${agent.id}/events`, { method: 'POST', headers: agentHeaders, body: { type: 'deployment-completed', projectKey: 'app-two', runId: 'run-c2', status: 'SUCCESS' } });
  const c2Login = await api('/auth/login', { method: 'POST', body: { email: 'two@example.com', password: 'password123' } });
  const u2 = c2Login.json.token;
  const c2History = await api('/notifications', { token: u2 });
  const c2Id = (c2History.json.notifications || [])[0]?.id;
  check('client 2 has its own notification', Boolean(c2Id), c2History.text);
  check('client 1 cannot mark client 2 notification read', c2Id ? (await api(`/notifications/${c2Id}/read`, { method: 'PATCH', token: u1 })).status === 404 : false);
  check('client 1 history excludes client 2 rows', !(await api('/notifications', { token: u1 })).json.notifications.some((n) => n.id === c2Id));

  const markOne = await api(`/notifications/${firstNotification.id}/read`, { method: 'PATCH', token: u1 });
  check('mark one notification read', markOne.status === 200 && markOne.json.read === true, markOne.text);
  const readAll = await api('/notifications/read-all', { method: 'POST', token: u1 });
  check('mark all notifications read', readAll.status === 200 && readAll.json.unreadCount === 0, readAll.text);

  const selfTest = await api('/notifications/test', { method: 'POST', token: u1 });
  check('self-test creates a persisted notification', selfTest.status === 200 && Boolean(selfTest.json.notification), selfTest.text);
  check('client cannot read admin notifications', (await api('/admin/notifications', { token: u1 })).status === 403);
  const adminNotifications = await api('/admin/notifications', { token: admin });
  check('admin notifications overview available', adminNotifications.status === 200 && Array.isArray(adminNotifications.json.clients));

  const relogin = await api('/auth/login', { method: 'POST', body: { email: 'one@example.com', password: 'password123' } });
  const u1b = relogin.json.token;
  check('history retained after re-login (offline then online)', ((await api('/notifications', { token: u1b })).json.notifications || []).length >= 2);

  const audit = await api('/admin/audit-logs?limit=5', { token: admin });
  const auditRow = (audit.json.logs || [])[0];
  check('audit log exposes targetType/targetId aliases', Boolean(auditRow) && 'targetType' in auditRow && 'targetId' in auditRow && 'resourceType' in auditRow, audit.text);

  console.log(`\n${failures === 0 ? 'ALL INTEGRATION CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
} catch (error) {
  console.error('Integration harness error:', error);
  failures += 1;
} finally {
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}
