import webpush from 'web-push';
import nodemailer from 'nodemailer';

const APP_NAME = 'HexTorq Cloud Console';

export const NOTIFICATION_EVENTS = Object.freeze(['started', 'completed', 'failed']);

/**
 * Notification scopes.
 *
 * A scope identifies who a preference or a push subscription belongs to.
 * Clients are scoped by their client id, super-admins by their email. The
 * scope key is always non-null so it can carry a unique constraint (Postgres
 * treats NULLs in unique indexes as distinct, which would allow duplicates).
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
  if (!preference) return false;
  if (event === 'started') return preference.notifyStarted !== false;
  if (event === 'failed') return preference.notifyFailed !== false;
  return preference.notifyCompleted !== false;
}

/**
 * Pick the preferences and subscriptions that should receive a deployment
 * notification for a given service.
 *
 * A service belongs to exactly one client, so that client's scope always
 * matches. Super-admin scopes match every service, which is what an operator
 * wants: they administer all services.
 */
export function resolveRecipients({ clientId, preferences = [], subscriptions = [] }) {
  const clientScope = clientId ? scopeKeyForClient(clientId) : null;
  const matches = (scopeKey) => Boolean(clientScope && scopeKey === clientScope) || isAdminScope(scopeKey);
  return {
    preferences: preferences.filter((preference) => matches(preference.scopeKey)),
    subscriptions: subscriptions.filter((subscription) => matches(subscription.scopeKey)),
  };
}

export function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

export function smtpConfigured() {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
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

function truncate(value, length = 120) {
  const text = String(value || '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/**
 * Build the browser notification payload for a deployment event.
 *
 * The payload is what the service worker renders, so it stays small — push
 * services reject bodies over a few kilobytes. The deep link points at the
 * deployment record so the notification's action button opens the full detail.
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
      title: `🚀 Deployment started — ${name}`,
      body: [branch, commit, message].filter(Boolean).join(' · '),
    };
  }

  if (event === 'failed' || status === 'FAILED' || status === 'ERROR') {
    const reason = truncate(deployment?.failureReason || 'Deployment failed', 140);
    return {
      ...base,
      title: `❌ Deployment failed — ${name}`,
      body: [branch, commit, reason].filter(Boolean).join(' · '),
    };
  }

  const duration = typeof deployment?.durationMs === 'number'
    ? `${(deployment.durationMs / 1000).toFixed(1)}s`
    : null;
  return {
    ...base,
    title: `✅ Deployment succeeded — ${name}`,
    body: [branch, commit, message, duration].filter(Boolean).join(' · '),
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the HTML email for a deployment event, including the deploy log. */
export function buildDeploymentEmail({ event, status, service, deployment, logLines = [] }) {
  const name = service?.name || 'Service';
  const branch = deployment?.branch || 'default branch';
  const commit = deployment?.commitHash || '—';
  const message = deployment?.commitMessage || 'No commit message';
  const detailUrl = `${frontendUrl()}/deployments?deployment=${encodeURIComponent(deployment?.id || '')}`;
  const log = logLines.length
    ? `<pre style="margin:18px 0 0;padding:14px;border-radius:10px;background:#0b0d12;color:#d8dbe4;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto">${escapeHtml(logLines.join('\n'))}</pre>`
    : '';

  let heading = 'Deployment started';
  let accent = '#2563eb';
  let intro = `A deployment was triggered for ${name}.`;
  if (event === 'failed' || status === 'FAILED' || status === 'ERROR') {
    heading = 'Deployment failed';
    accent = '#b42318';
    intro = deployment?.failureReason || 'The deployment command failed.';
  } else if (event === 'completed') {
    heading = 'Deployment succeeded';
    accent = '#067647';
    intro = 'The deployment finished successfully.';
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(heading)} — ${escapeHtml(name)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17181b">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background:#f5f5f2"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e5df">
  <tr><td style="padding:22px 28px;border-bottom:1px solid #efefea">
    <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${accent}1a;color:${accent};font:700 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(heading)}</span>
    <h1 style="margin:14px 0 0;font:700 22px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">${escapeHtml(name)}</h1>
    <p style="margin:6px 0 0;color:#5f646d;font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">${escapeHtml(intro)}</p>
  </td></tr>
  <tr><td style="padding:22px 28px">
    <table width="100%" cellpadding="0" cellspacing="0" style="font:400 13px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#17181b">
      <tr><td style="padding:5px 0;color:#5f646d;width:96px">Branch</td><td style="padding:5px 0"><code style="background:#f2f2ee;border-radius:5px;padding:2px 6px;font:12px ui-monospace,monospace">${escapeHtml(branch)}</code></td></tr>
      <tr><td style="padding:5px 0;color:#5f646d">Commit</td><td style="padding:5px 0"><code style="background:#f2f2ee;border-radius:5px;padding:2px 6px;font:12px ui-monospace,monospace">${escapeHtml(commit)}</code></td></tr>
      <tr><td style="padding:5px 0;color:#5f646d">Message</td><td style="padding:5px 0">${escapeHtml(message)}</td></tr>
      <tr><td style="padding:5px 0;color:#5f646d">Trigger</td><td style="padding:5px 0">${escapeHtml(deployment?.triggerSource || 'webhook')}</td></tr>
    </table>
    ${log}
  </td></tr>
  <tr><td style="padding:0 28px 26px">
    <a href="${detailUrl}" style="display:inline-block;padding:12px 26px;border-radius:10px;background:#17181b;color:#ffffff;text-decoration:none;font:700 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">View full deployment details →</a>
  </td></tr>
  <tr><td style="padding:16px 28px;border-top:1px solid #efefea;color:#8a8f98;font:400 11px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif">
    You receive this because deployment notifications are enabled for your ${APP_NAME} account.
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!smtpConfigured()) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const mailer = getTransporter();
  if (!mailer) return { ok: false, reason: 'SMTP not configured' };
  try {
    const info = await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
      text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });
    return { ok: true, messageId: info.messageId };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * Send a push payload to every subscription.
 *
 * Push services answer 404/410 once a browser discards a subscription (the
 * app was uninstalled, site data was cleared). Those endpoints are dead and
 * must be removed, otherwise every deployment keeps retrying them.
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
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
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
      console.warn(`[Push] send failed for ${subscription.endpoint.slice(0, 48)}…: ${error.message}`);
    }
  }));

  return { sent, failed, expired };
}

/**
 * Dispatch a deployment notification to every opted-in channel.
 *
 * This never throws: a broken push or SMTP server must not roll back the
 * deployment record that was already written.
 */
export async function dispatchDeploymentNotification({
  prisma,
  event,
  status,
  service,
  deployment,
  logLines = [],
}) {
  const result = { push: null, email: null, skipped: [] };
  if (!service || !deployment) return result;

  const scopeKeys = [service.clientId ? scopeKeyForClient(service.clientId) : null].filter(Boolean);
  const preferences = await prisma.notificationPreference.findMany();
  const subscriptions = await prisma.pushSubscription.findMany();
  const { preferences: scopedPreferences, subscriptions: scopedSubscriptions } = resolveRecipients({
    clientId: service.clientId,
    preferences,
    subscriptions,
  });

  const interested = scopedPreferences.filter((preference) => wantsEvent(preference, event));
  if (!interested.length && !scopedSubscriptions.length) {
    result.skipped.push('no-recipients');
    return result;
  }

  const payload = buildDeploymentNotification({ event, status, service, deployment });

  const pushRecipients = interested.filter((preference) => preference.pushEnabled !== false);
  if (!pushRecipients.length) result.skipped.push('push-disabled');
  else if (!scopedSubscriptions.length) result.skipped.push('no-push-subscriptions');
  else {
    result.push = await deliverPush(scopedSubscriptions, payload, {
      onExpired: async (subscription) => {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: subscription.endpoint } });
      },
    });
    if (result.push.sent) {
      await prisma.pushSubscription.updateMany({
        where: { endpoint: { in: scopedSubscriptions.map((item) => item.endpoint) } },
        data: { lastUsedAt: new Date() },
      });
    }
  }

  const emailRecipients = interested
    .filter((preference) => preference.emailEnabled === true)
    .map((preference) => preference.emailAddress)
    .filter(Boolean);
  if (!emailRecipients.length) result.skipped.push('email-disabled');
  else {
    const subject = payload.title;
    const html = buildDeploymentEmail({ event, status, service, deployment, logLines });
    const outcomes = await Promise.all(emailRecipients.map((to) => sendMail({ to, subject, html })));
    result.email = {
      sent: outcomes.filter((outcome) => outcome.ok).length,
      failed: outcomes.filter((outcome) => !outcome.ok).length,
    };
  }

  void scopeKeys;
  return result;
}
