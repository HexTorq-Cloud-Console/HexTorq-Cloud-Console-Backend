import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeploymentEmail,
  buildDeploymentNotification,
  isAdminScope,
  resolveRecipients,
  scopeKeyForAdmin,
  scopeKeyForClient,
  scopeKeyForUser,
  wantsEvent,
} from '../src/notifications.js';

const service = {
  id: 'svc-1',
  name: 'Food Tracker Backend',
  clientId: 'client-1',
};

const deployment = {
  id: 'dep-1',
  runId: 'run-1',
  branch: 'main',
  commitHash: '232e68aec47ccf35f17f61f237fc421056308a2b',
  commitMessage: 'Add full try-catch safety on upload_files',
  triggerSource: 'console',
};

test('scope keys separate clients from super-admins', () => {
  assert.equal(scopeKeyForClient('client-1'), 'client:client-1');
  assert.equal(scopeKeyForAdmin('Admin@RGuedu.in'), 'admin:admin@rguedu.in');
  assert.equal(isAdminScope('admin:admin@rguedu.in'), true);
  assert.equal(isAdminScope('client:client-1'), false);
});

test('scope key is derived from the authenticated user', () => {
  assert.equal(scopeKeyForUser({ role: 'CLIENT', clientId: 'client-1', email: 'a@b.c' }), 'client:client-1');
  assert.equal(scopeKeyForUser({ role: 'SUPER_ADMIN', email: 'admin@rguedu.in' }), 'admin:admin@rguedu.in');
  assert.equal(scopeKeyForUser(null), null);
});

test('a client never receives another client\'s scope, admins receive every scope', () => {
  const preferences = [
    { scopeKey: 'client:client-1' },
    { scopeKey: 'client:client-2' },
    { scopeKey: 'admin:admin@rguedu.in' },
  ];
  const subscriptions = [
    { scopeKey: 'client:client-1' },
    { scopeKey: 'client:client-2' },
    { scopeKey: 'admin:admin@rguedu.in' },
  ];

  // A deployment for client-1 reaches client-1 and the super-admin, never client-2.
  const clientResult = resolveRecipients({ clientId: 'client-1', preferences, subscriptions });
  assert.deepEqual(
    clientResult.preferences.map((item) => item.scopeKey).sort(),
    ['admin:admin@rguedu.in', 'client:client-1'],
  );
  assert.deepEqual(
    clientResult.subscriptions.map((item) => item.scopeKey).sort(),
    ['admin:admin@rguedu.in', 'client:client-1'],
  );

  // A deployment for client-2 reaches client-2 and the super-admin, never client-1.
  const otherResult = resolveRecipients({ clientId: 'client-2', preferences, subscriptions });
  assert.deepEqual(
    otherResult.preferences.map((item) => item.scopeKey).sort(),
    ['admin:admin@rguedu.in', 'client:client-2'],
  );
});

test('a service without a client never reaches a client scope', () => {
  const result = resolveRecipients({
    clientId: null,
    preferences: [{ scopeKey: 'client:client-1' }],
    subscriptions: [{ scopeKey: 'client:client-1' }],
  });
  assert.equal(result.preferences.length, 0);
  assert.equal(result.subscriptions.length, 0);
});

test('event preferences gate each deployment event', () => {
  const preference = { notifyStarted: true, notifyCompleted: true, notifyFailed: false };
  assert.equal(wantsEvent(preference, 'started'), true);
  assert.equal(wantsEvent(preference, 'completed'), true);
  assert.equal(wantsEvent(preference, 'failed'), false);
});

test('started notifications carry the branch and a deep link', () => {
  const payload = buildDeploymentNotification({ event: 'started', status: 'DEPLOYING', service, deployment });
  assert.match(payload.title, /Deployment started/);
  assert.match(payload.title, /Food Tracker Backend/);
  assert.match(payload.body, /main/);
  assert.match(payload.body, /232e68ae/);
  assert.match(payload.url, /\/deployments\?deployment=dep-1$/);
  assert.equal(payload.event, 'started');
  assert.equal(payload.tag, 'deployment-run-1');
});

test('completed notifications report success', () => {
  const payload = buildDeploymentNotification({ event: 'completed', status: 'SUCCESS', service, deployment });
  assert.match(payload.title, /Deployment succeeded/);
  assert.equal(payload.status, 'SUCCESS');
});

test('failed notifications report the failure reason', () => {
  const payload = buildDeploymentNotification({
    event: 'failed',
    status: 'FAILED',
    service,
    deployment: { ...deployment, failureReason: 'Command exited with code 1' },
  });
  assert.match(payload.title, /Deployment failed/);
  assert.match(payload.body, /Command exited with code 1/);
});

test('notification payloads stay small enough for push services', () => {
  const payload = buildDeploymentNotification({
    event: 'completed',
    status: 'SUCCESS',
    service,
    deployment: { ...deployment, commitMessage: 'x'.repeat(500) },
  });
  assert.ok(JSON.stringify(payload).length < 2048);
});

test('the email includes the deployment log and a details link', () => {
  const html = buildDeploymentEmail({
    event: 'completed',
    status: 'SUCCESS',
    service,
    deployment,
    logLines: ['Deploying configured branch: main', 'Command succeeded'],
  });
  assert.match(html, /Deployment succeeded/);
  assert.match(html, /Food Tracker Backend/);
  assert.match(html, /Deploying configured branch: main/);
  assert.match(html, /\/deployments\?deployment=dep-1/);
});

test('the email escapes log content so it cannot inject markup', () => {
  const html = buildDeploymentEmail({
    event: 'failed',
    status: 'FAILED',
    service,
    deployment,
    logLines: ['<script>alert(1)</script>'],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});
