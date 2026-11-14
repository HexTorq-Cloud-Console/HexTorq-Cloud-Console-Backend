import webpush from 'web-push';
import { redactSecrets } from './redact.js';

const APP_NAME = 'HexTorq Cloud Console';

export const NOTIFICATION_EVENTS = Object.freeze(['started', 'completed', 'failed']);

/**
 * Notification scopes.
 *
 * A scope identifies who a preference, a push subscription or a persisted
 * notification belongs to. Clients are scoped by their client id, super-admins
 * by their email. The scope key is always non-null so it can carry a unique
 * constraint (Postgres treats NULLs in unique indexes as distinct).
 */
export function scopeKeyForClient(clientId) {
  return `client:${clientId}`;
}

export function scopeKeyForAdmin(email) {
  return `admin:${String(email || '').trim().toLowerCase()}`;
}

export function isAdminScope(scopeKey) {
  return String(scopeKey || '').startsWith('admin:');
}

export function scopeKeyForUser(user) {
  if (!user) return null;
  if (user.role === 'CLIENT' && user.clientId) return scopeKeyForClient(user.clientId);
  if (user.email) return scopeKeyForAdmin(user.email);
  return null;
}

/** Which preference flag governs a given deployment event. */
export function wantsEvent(preference, event) {
  if (!preference) return true;
  if (event === 'started') return preference.notifyStarted !== false;
  if (event === 'failed') return preference.notifyFailed !== false;
  return preference.notifyCompleted !== false;
}

export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function frontendUrl() {
  return (process.env.FRONTEND_URL || 'https://cloud-console.hextorq.tech').replace(/\/$/, '');
}

let vapidReady = false;

function ensureVapid() {
  if (!pushConfigured()) return false;
  if (!vapidReady) {
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:hextorqtechnologies@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
    vapidReady = true;
  }
  return true;
}

function shortCommit(value) {
  return typeof value === 'string' && value.length > 8 ? value.slice(0, 8) : value || '—';
}

function truncate(value, length = 140) {
  const text = String(value || '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

/**
 * Build the notification payload for a deployment event. The same payload
 * backs the browser push, the live toast and the persisted history row.
 */
export function buildDeploymentNotification({ event, status, service, deployment }) {
  const name = service?.name || 'Service';
  const branch = deployment?.branch || 'default branch';
  const commit = shortCommit(deployment?.commitHash);
  const message = truncate(deployment?.commitMessage, 90);
  const detailUrl = `${frontendUrl()}/deployments?deployment=${encodeURIComponent(deployment?.id || '')}`;
  const base = {
    tag: `deployment-${deployment?.runId || deployment?.id || 'unknown'}`,
    url: detailUrl,
    event,
    status: status || null,
    serviceId: service?.id || null,
    deploymentId: deployment?.id || null,
    runId: deployment?.runId || null,
  };

  if (event === 'started') {
    return {
      ...base,
      type: 'deployment.started',
      title: `Deployment started — ${name}`,
      body: [branch, commit, message].filter(Boolean).join(' · '),
    };
  }

  if (event === 'failed' || status === 'FAILED' || status === 'ERROR') {
    const reason = truncate(deployment?.failureReason || 'Deployment failed', 140);
    return {
      ...base,
      type: 'deployment.failed',
      title: `Deployment failed — ${name}`,
      body: [branch, commit, reason].filter(Boolean).join(' · '),
    };
  }

  const duration = typeof deployment?.durationMs === 'number' ? `${(deployment.durationMs / 1000).toFixed(1)}s` : null;
  return {
    ...base,
    type: 'deployment.success',
    title: `Deployment succeeded — ${name}`,
    body: [branch, commit, message, duration].filter(Boolean).join(' · '),
  };
}

/**
 * Send a push payload to every subscription. Push services answer 404/410 once
 * a browser discards a subscription; those endpoints are dead and are removed.
 * Never throws.
 */
export async function deliverPush(subscriptions, payload, { onExpired } = {}) {
  if (!ensureVapid()) return { sent: 0, failed: 0, expired: 0, skipped: 'push-not-configured' };
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  let expired = 0;

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        body,
      );
      sent += 1;
    } catch (error) {
      const status = error?.statusCode;
      if (status === 404 || status === 410) {
        expired += 1;
        if (onExpired) await onExpired(subscription);
        return;
      }
      failed += 1;
      console.warn(`[Push] send failed for ${String(subscription.endpoint).slice(0, 48)}...: ${error.message}`);
    }
  }));

  return { sent, failed, expired };
}

/**
 * Persist a single notification row. Dedupe keys make retried events idempotent.
 * Never throws — a notification must never break the caller's real work.
 *
 * @returns {Promise<{created: boolean, notification?: object, skipped?: string}>}
 */
export async function createNotification(prisma, {
  scopeKey, clientId = null, userEmail = null, type, title, body,
  metadata = null, resourceType = null, resourceId = null, dedupeKey = null,
}) {
  try {
    const notification = await prisma.notification.create({
      data: {
        scopeKey,
        clientId,
        userEmail,
        type,
        title,
        body: redactSecrets(String(body || '')),
        metadata: metadata || undefined,
        resourceType,
        resourceId,
        dedupeKey,
      },
    });
    return { created: true, notification };
  } catch (error) {
    // A duplicate dedupeKey (P2002) means the event was already recorded.
    if (error?.code === 'P2002') return { created: false, skipped: 'duplicate' };
    console.error('[Notify] failed to store notification:', error.message);
    return { created: false, skipped: 'storage-error' };
  }
}

/** Scope resolution for the recipients of a client-owned event. */
async function recipientScopes(prisma, clientId) {
  const scopes = [];
  if (clientId) scopes.push({ scopeKey: scopeKeyForClient(clientId), clientId, userEmail: null });
  const adminPreferences = await prisma.notificationPreference.findMany({ where: { scopeKey: { startsWith: 'admin:' } } });
  for (const preference of adminPreferences) {
    scopes.push({ scopeKey: preference.scopeKey, clientId: null, userEmail: preference.userEmail });
  }
  return scopes;
}

/**
 * Create one persisted notification and any push deliveries for a single event.
 * Returns delivery stats. Never throws.
 */
export async function createEventNotifications(prisma, {
  clientId, event, type, title, body, metadata, resourceType, resourceId, dedupeKey,
}) {
  const result = { created: 0, push: { sent: 0, failed: 0, expired: 0 }, scopes: [] };
  try {
    const scopes = await recipientScopes(prisma, clientId);
    if (!scopes.length) return result;

    const preferences = await prisma.notificationPreference.findMany();
    const preferenceByScope = new Map(preferences.map((preference) => [preference.scopeKey, preference]));

    for (const scope of scopes) {
      const preference = preferenceByScope.get(scope.scopeKey) || null;
      if (!wantsEvent(preference, event)) continue;

      const stored = await createNotification(prisma, {
        scopeKey: scope.scopeKey,
        clientId: scope.clientId,
        userEmail: scope.userEmail,
        type,
        title,
        body,
        metadata,
        resourceType,
        resourceId,
        dedupeKey: dedupeKey ? `${scope.scopeKey}:${dedupeKey}` : null,
      });
      if (stored.created) result.created += 1;
      result.scopes.push(scope.scopeKey);

      if (preference && preference.pushEnabled === false) continue;
      const subscriptions = await prisma.pushSubscription.findMany({ where: { scopeKey: scope.scopeKey } });
      if (!subscriptions.length) continue;

      const push = await deliverPush(subscriptions, {
        title, body, url: metadata?.url || `${frontendUrl()}/alerts`, tag: dedupeKey || undefined,
        status: metadata?.status || null, serviceId: metadata?.serviceId || null, deploymentId: resourceId || null,
      }, {
        onExpired: async (subscription) => {
          await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
        },
      });
      result.push.sent += push.sent || 0;
      result.push.failed += push.failed || 0;
      result.push.expired += push.expired || 0;
      if (push.sent) {
        await prisma.pushSubscription.updateMany({
          where: { endpoint: { in: subscriptions.map((item) => item.endpoint) } },
          data: { lastUsedAt: new Date() },
        });
      }
    }
  } catch (error) {
    console.error('[Notify] createEventNotifications failed:', error.message);
  }
  return result;
}

/** Deployment event entry point used by the agent event handler. Never throws. */
export async function dispatchDeploymentNotification({ prisma, event, status, service, deployment }) {
  if (!service || !deployment) return { created: 0, push: null };
  const payload = buildDeploymentNotification({ event, status, service, deployment });
  return createEventNotifications(prisma, {
    clientId: service.clientId,
    event,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    metadata: {
      url: `${frontendUrl()}/deployments?deployment=${encodeURIComponent(deployment.id)}`,
      serviceId: service.id,
      serviceName: service.name,
      runId: deployment.runId,
      status: status || null,
      deploymentId: deployment.id,
    },
    resourceType: 'deployment',
    resourceId: deployment.id,
    dedupeKey: `deployment:${deployment.id}:${event}`,
  });
}

/* ------------------------------ History API ------------------------------ */

export async function listNotifications({ prisma, scopeKey, limit = 30, cursor = null, filter = 'all' }) {
  const where = { scopeKey };
  if (filter === 'unread') where.readAt = null;
  if (filter === 'read') where.readAt = { not: null };
  const rows = await prisma.notification.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const notifications = rows.slice(0, limit);
  return {
    notifications,
    total: await prisma.notification.count({ where }),
    hasMore,
    nextCursor: hasMore ? notifications[notifications.length - 1].id : null,
  };
}

export function getUnreadCount({ prisma, scopeKey }) {
  return prisma.notification.count({ where: { scopeKey, readAt: null } });
}

export async function markNotificationRead({ prisma, scopeKey, id }) {
  const result = await prisma.notification.updateMany({
    where: { id, scopeKey, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export function markAllNotificationsRead({ prisma, scopeKey }) {
  return prisma.notification.updateMany({ where: { scopeKey, readAt: null }, data: { readAt: new Date() } });
}

/** A self-test notification: records a row and pushes to the account's own devices. */
export async function createTestNotification({ prisma, scopeKey, clientId, userEmail }) {
  const payload = {
    type: 'test',
    title: `${APP_NAME} test notification`,
    body: 'This is a test notification. If you can see it here, notifications are working.',
  };
  const stored = await createNotification(prisma, {
    scopeKey,
    clientId,
    userEmail,
    type: payload.type,
    title: payload.title,
    body: payload.body,
    metadata: { url: `${frontendUrl()}/alerts` },
    resourceType: null,
    resourceId: null,
    dedupeKey: `test:${scopeKey}:${Date.now()}`,
  });
  const subscriptions = await prisma.pushSubscription.findMany({ where: { scopeKey } });
  const push = await deliverPush(subscriptions, { ...payload, url: `${frontendUrl()}/alerts`, tag: `test-${scopeKey}` }, {
    onExpired: async (subscription) => {
      await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
    },
  });
  return { stored, push };
}
