import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scopeKeyForUser,
  scopeKeyForClient,
  scopeKeyForAdmin,
  wantsEvent,
  buildDeploymentNotification,
  createEventNotifications,
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../src/notifications.js';

/* --------------------------- pure helpers --------------------------- */

test('scope keys: clients by id, admins by email', () => {
  assert.equal(scopeKeyForClient('c1'), 'client:c1');
  assert.equal(scopeKeyForAdmin('Admin@X.com'), 'admin:admin@x.com');
  assert.equal(scopeKeyForUser({ role: 'CLIENT', clientId: 'c1' }), 'client:c1');
  assert.equal(scopeKeyForUser({ role: 'SUPER_ADMIN', email: 'root@x.com' }), 'admin:root@x.com');
  assert.equal(scopeKeyForUser(null), null);
});

test('wantsEvent respects explicit preferences and defaults to on', () => {
  assert.equal(wantsEvent(null, 'failed'), true);
  assert.equal(wantsEvent({ notifyFailed: false }, 'failed'), false);
  assert.equal(wantsEvent({ notifyCompleted: false }, 'completed'), false);
  assert.equal(wantsEvent({ notifyStarted: false }, 'started'), false);
});

test('deployment payload carries a deep link and no resource metrics', () => {
  const payload = buildDeploymentNotification({
    event: 'failed', status: 'FAILED',
    service: { id: 's1', name: 'API' },
    deployment: { id: 'd1', runId: 'r1', branch: 'main', commitHash: 'abcdef123456', failureReason: 'boom' },
  });
  assert.equal(payload.type, 'deployment.failed');
  assert.ok(payload.url.includes('/deployments?deployment=d1'));
  const json = JSON.stringify(payload);
  for (const key of ['cpu', 'memory', 'cpuPercent', 'memoryBytes']) assert.ok(!json.includes(key));
});

/* --------------------------- in-memory prisma --------------------------- */

function matchWhere(where) {
  return (row) => Object.entries(where || {}).every(([key, value]) => {
    if (value === null) return row[key] === null || row[key] === undefined;
    if (typeof value === 'object' && value !== null) {
      if ('not' in value) return row[key] !== value.not;
      if ('startsWith' in value) return String(row[key] || '').startsWith(value.startsWith);
      if ('in' in value) return value.in.includes(row[key]);
    }
    return row[key] === value;
  });
}

function memoryPrisma() {
  const notifications = [];
  const preferences = [];
  const subscriptions = [];
  let seq = 0;
  const prisma = {
    notification: {
      async create({ data }) {
        if (data.dedupeKey && notifications.some((n) => n.dedupeKey === data.dedupeKey)) {
          const error = new Error('unique constraint');
          error.code = 'P2002';
          throw error;
        }
        const row = { readAt: null, metadata: null, resourceType: null, resourceId: null, clientId: null, userEmail: null, createdAt: new Date(1000 + (++seq)), ...data };
        row.id = row.id || `n${seq}`;
        notifications.push(row);
        return row;
      },
      async findMany({ where = {}, take, cursor, skip } = {}) {
        let rows = notifications.filter(matchWhere(where));
        rows = rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
        const cursorId = typeof cursor === 'string' ? cursor : cursor?.id;
        if (cursorId) {
          const index = rows.findIndex((row) => row.id === cursorId);
          rows = index >= 0 ? rows.slice(index + (skip || 0)) : rows;
        }
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      async count({ where = {} } = {}) { return notifications.filter(matchWhere(where)).length; },
      async findUnique({ where }) { return notifications.find((row) => row.id === where.id) || null; },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of notifications) if (matchWhere(where)(row)) { Object.assign(row, data); count += 1; }
        return { count };
      },
    },
    notificationPreference: {
      async findMany({ where = {} } = {}) { return preferences.filter(matchWhere(where)); },
      async findUnique({ where }) { return preferences.find(matchWhere(where)) || null; },
    },
    pushSubscription: {
      async findMany({ where = {} } = {}) { return subscriptions.filter(matchWhere(where)); },
      async deleteMany({ where = {} } = {}) {
        const before = subscriptions.length;
        for (let i = subscriptions.length - 1; i >= 0; i -= 1) if (matchWhere(where)(subscriptions[i])) subscriptions.splice(i, 1);
        return { count: before - subscriptions.length };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of subscriptions) if (matchWhere(where)(row)) { Object.assign(row, data); count += 1; }
        return { count };
      },
    },
    _seed: {
      preference(preference) { preferences.push(preference); },
      subscription(subscription) { subscriptions.push(subscription); },
    },
    _notifications: notifications,
  };
  return prisma;
}

const SERVICE = { id: 's1', name: 'API', clientId: 'c1' };
const DEPLOYMENT = { id: 'd1', runId: 'r1', branch: 'main', commitHash: 'abc12345', status: 'SUCCESS' };

/* --------------------------- service behaviour --------------------------- */

test('deployment event persists one client history row even with no push subscription', async () => {
  const prisma = memoryPrisma();
  const result = await createEventNotifications(prisma, {
    clientId: 'c1', event: 'completed', type: 'deployment.success',
    title: 'Deployment succeeded — API', body: 'main · abc12345',
    metadata: { url: '/deployments?deployment=d1' }, resourceType: 'deployment', resourceId: 'd1',
    dedupeKey: 'deployment:d1:completed',
  });
  assert.equal(result.created, 1);
  assert.equal(prisma._notifications.length, 1);
  assert.equal(prisma._notifications[0].scopeKey, 'client:c1');
});

test('a repeated event is deduplicated', async () => {
  const prisma = memoryPrisma();
  const args = {
    clientId: 'c1', event: 'failed', type: 'deployment.failed',
    title: 'Deployment failed — API', body: 'boom',
    resourceType: 'deployment', resourceId: 'd1', dedupeKey: 'deployment:d1:failed',
  };
  assert.equal((await createEventNotifications(prisma, args)).created, 1);
  assert.equal((await createEventNotifications(prisma, args)).created, 0);
  assert.equal(prisma._notifications.length, 1);
});

test('notification body is redacted before storage', async () => {
  const prisma = memoryPrisma();
  await createEventNotifications(prisma, {
    clientId: 'c1', event: 'failed', type: 'deployment.failed',
    title: 'failed', body: 'connecting password=SuperSecret123 now',
    dedupeKey: 'deployment:d9:failed',
  });
  assert.ok(!prisma._notifications[0].body.includes('SuperSecret123'));
  assert.ok(prisma._notifications[0].body.includes('[REDACTED]'));
});

test('admin scope notifications are created only for opted-in admins', async () => {
  const prisma = memoryPrisma();
  prisma._seed.preference({ scopeKey: 'admin:ops@x.com', userEmail: 'ops@x.com' });
  await createEventNotifications(prisma, {
    clientId: 'c1', event: 'completed', type: 'deployment.success', title: 't', body: 'b',
    dedupeKey: 'deployment:d1:completed',
  });
  const scopes = prisma._notifications.map((n) => n.scopeKey).sort();
  assert.deepEqual(scopes, ['admin:ops@x.com', 'client:c1']);
});

test('push is skipped (not failing) when VAPID is not configured', async () => {
  const prisma = memoryPrisma();
  prisma._seed.subscription({ id: 'sub1', scopeKey: 'client:c1', endpoint: 'https://push/x', p256dh: 'k', auth: 'a' });
  const result = await createEventNotifications(prisma, {
    clientId: 'c1', event: 'started', type: 'deployment.started', title: 't', body: 'b',
    dedupeKey: 'deployment:d1:started',
  });
  assert.equal(result.created, 1);
  assert.equal(result.push.sent, 0);
});

test('history is newest-first, paginated, and tenant-isolated', async () => {
  const prisma = memoryPrisma();
  for (const [client, i] of [['c1', 1], ['c1', 2], ['c2', 3]]) {
    await createEventNotifications(prisma, {
      clientId: client, event: 'completed', type: 'deployment.success', title: `t${i}`, body: 'b',
      dedupeKey: `d${i}:completed`,
    });
  }
  const page = await listNotifications({ prisma, scopeKey: 'client:c1', limit: 1 });
  assert.equal(page.notifications.length, 1);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  const second = await listNotifications({ prisma, scopeKey: 'client:c1', limit: 1, cursor: page.nextCursor });
  assert.equal(second.notifications.length, 1);
  assert.equal(second.hasMore, false);
  const c2 = await listNotifications({ prisma, scopeKey: 'client:c2', limit: 10 });
  assert.equal(c2.total, 1);
});

test('unread count, mark one read, and mark all read are scope-bound', async () => {
  const prisma = memoryPrisma();
  for (const i of [1, 2, 3]) {
    await createEventNotifications(prisma, {
      clientId: 'c1', event: 'completed', type: 'deployment.success', title: `t${i}`, body: 'b',
      dedupeKey: `d${i}:completed`,
    });
  }
  assert.equal(await getUnreadCount({ prisma, scopeKey: 'client:c1' }), 3);
  const target = prisma._notifications.find((n) => n.scopeKey === 'client:c1');

  // Another scope cannot mark this notification read.
  assert.equal(await markNotificationRead({ prisma, scopeKey: 'client:c2', id: target.id }), 0);
  assert.equal(await getUnreadCount({ prisma, scopeKey: 'client:c1' }), 3);

  assert.equal(await markNotificationRead({ prisma, scopeKey: 'client:c1', id: target.id }), 1);
  assert.equal(await getUnreadCount({ prisma, scopeKey: 'client:c1' }), 2);

  const all = await markAllNotificationsRead({ prisma, scopeKey: 'client:c1' });
  assert.equal(all.count, 2);
  assert.equal(await getUnreadCount({ prisma, scopeKey: 'client:c1' }), 0);
});
