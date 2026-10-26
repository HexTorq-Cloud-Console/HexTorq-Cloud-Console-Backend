import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { OAuth2Client } from 'google-auth-library';
import { serviceTemplates } from './templates.js';
import {
  nextScheduledRun,
  nextScheduledRunAfter,
  resolveScheduleOptions,
} from './schedule.js';

const app = express();
const prisma = new PrismaClient();
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;
const port = Number(process.env.PORT || 4000);
const webhookScheduleOptions = resolveScheduleOptions({
  timeZone: process.env.WEBHOOK_SCHEDULE_TIMEZONE,
  hour: process.env.WEBHOOK_SCHEDULE_HOUR,
});
function configuredMilliseconds(value, fallback, minimum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(Math.floor(parsed), minimum);
}

const webhookHealthTimeoutMs = configuredMilliseconds(
  process.env.WEBHOOK_HEALTH_DEPLOY_TIMEOUT_MS,
  20 * 60 * 1000,
  60 * 1000,
);
const webhookHealthPollMs = configuredMilliseconds(process.env.WEBHOOK_HEALTH_POLL_MS, 3000, 500);
const schedulerEmail = process.env.WEBHOOK_SCHEDULER_EMAIL || 'scheduler@hextorq.local';
const activeWebhookClients = new Set();
const defaultFrontendOrigin = 'https://hex-torq-cloud-console-frontend.vercel.app';
const allowedFrontendOrigins = new Set(
  [process.env.FRONTEND_URL, defaultFrontendOrigin, 'http://localhost:3000']
    .filter(Boolean)
    .map((origin) => origin.replace(/\/$/, ''))
);

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!process.env.SUPER_ADMIN_EMAIL || !process.env.SUPER_ADMIN_PASSWORD) {
  throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required');
}
const superAdminPasswordHash = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD, 12);

app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    const normalizedOrigin = origin?.replace(/\/$/, '');
    if (!origin || allowedFrontendOrigins.has(normalizedOrigin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by HexTorq Cloud Console CORS policy'));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-Id', 'X-Agent-Key'],
}));
app.use(express.json({ limit: '1mb' }));

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function createToken(email) {
  return jwt.sign({ email, role: 'SUPER_ADMIN' }, process.env.JWT_SECRET, {
    expiresIn: '8h',
  });
}

function createClientToken(client) {
  return jwt.sign({ email: client.email, role: 'CLIENT', clientId: client.id }, process.env.JWT_SECRET, {
    expiresIn: '8h',
  });
}

async function writeAudit(actorEmail, action, resourceType, resourceId, metadata = undefined) {
  try { await prisma.auditLog.create({ data: { actorEmail, action, resourceType, resourceId, metadata } }); } catch (error) { console.error('Audit write failed:', error.message); }
}

function encryptionKey() {
  const key = process.env.AGENT_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error('AGENT_ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(key, 'hex');
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`;
}

function decryptSecret(value) {
  const [ivHex, tagHex, encryptedHex] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
}

function encryptAgentKey(value) {
  return encryptSecret(value);
}

function decryptAgentKey(value) {
  return decryptSecret(value);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentication required' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'HexTorq Cloud Console API' });
});

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid login details' });

  const emailMatches = parsed.data.email.toLowerCase() === process.env.SUPER_ADMIN_EMAIL.toLowerCase();
  const passwordMatches = await bcrypt.compare(parsed.data.password, superAdminPasswordHash);
  if (emailMatches && passwordMatches) {
    return res.json({
      token: createToken(process.env.SUPER_ADMIN_EMAIL),
      user: { email: process.env.SUPER_ADMIN_EMAIL, role: 'SUPER_ADMIN' },
    });
  }

  const client = await prisma.client.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!client || !client.enabled || !(await bcrypt.compare(parsed.data.password, client.passwordHash))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  res.json({
    token: createClientToken(client),
    user: { email: client.email, role: 'CLIENT', clientId: client.id, forcePasswordChange: client.forcePasswordChange },
  });
});

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(503).json({ message: 'Google sign-in is not configured' });
  const credential = z.string().min(1).safeParse(req.body?.credential);
  if (!credential.success) return res.status(400).json({ message: 'Google credential is required' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential.data, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified || !payload.sub) return res.status(401).json({ message: 'Google account could not be verified' });
    if (payload.email.toLowerCase() === process.env.SUPER_ADMIN_EMAIL.toLowerCase()) {
      await writeAudit(payload.email, 'AUTH_GOOGLE_LOGIN', 'SuperAdmin', null);
      return res.json({ token: createToken(payload.email), user: { email: payload.email, role: 'SUPER_ADMIN' } });
    }
    const client = await prisma.client.findUnique({ where: { email: payload.email.toLowerCase() } });
    if (!client || !client.enabled) return res.status(403).json({ message: 'This Google account is not registered as a client' });
    await prisma.client.update({ where: { id: client.id }, data: { googleSubject: payload.sub } });
    await writeAudit(client.email, 'AUTH_GOOGLE_LOGIN', 'Client', client.id);
    res.json({ token: createClientToken(client), user: { email: client.email, role: 'CLIENT', clientId: client.id, forcePasswordChange: client.forcePasswordChange } });
  } catch { res.status(401).json({ message: 'Invalid Google credential' }); }
});

app.get('/api/auth/me', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'CLIENT') return res.json({ user: req.user });
    const client = await prisma.client.findUnique({
      where: { id: req.user.clientId },
      select: { id: true, email: true, enabled: true, forcePasswordChange: true },
    });
    if (!client || !client.enabled) return res.status(401).json({ message: 'Client account is disabled' });
    return res.json({
      user: {
        email: client.email,
        role: 'CLIENT',
        clientId: client.id,
        forcePasswordChange: client.forcePasswordChange,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ message: 'Only client passwords can be changed here' });
    const input = z.object({ password: z.string().min(8) }).parse(req.body);
    await prisma.client.update({ where: { id: req.user.clientId }, data: { passwordHash: await bcrypt.hash(input.password, 12), forcePasswordChange: false } });
    await writeAudit(req.user.email, 'CLIENT_PASSWORD_CHANGED', 'Client', req.user.clientId);
    res.json({ changed: true });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Password must contain at least 8 characters' });
    next(error);
  }
});

function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== 'SUPER_ADMIN') return res.status(403).json({ message: 'Super-admin access required' });
  next();
}

function requireAgentKey(req, res, next) {
  const agentId = req.headers['x-agent-id'];
  const key = req.headers['x-agent-key'];
  if (!agentId || !key) return res.status(401).json({ message: 'Agent credentials required' });
  req.agentCredentials = { agentId: String(agentId), key: String(key) };
  next();
}

app.get('/api/services', requireAuth, async (req, res, next) => {
  try {
    const where = req.user.role === 'CLIENT' ? { clientId: req.user.clientId } : {};
    const services = await prisma.service.findMany({
      where,
      include: { client: true, agent: { select: { id: true, name: true, baseUrl: true, enabled: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ services });
  } catch (error) {
    next(error);
  }
});

app.get('/api/services/:serviceId', requireAuth, async (req, res, next) => {
  try {
    const service = await prisma.service.findUnique({ where: { id: req.params.serviceId }, include: { client: true, agent: { select: { id: true, name: true, baseUrl: true, enabled: true } } } });
    if (!service || (req.user.role === 'CLIENT' && service.clientId !== req.user.clientId)) return res.status(404).json({ message: 'Service not found' });
    res.json({ service });
  } catch (error) { next(error); }
});

function agentUrl(agent, route) {
  return `${agent.baseUrl.replace(/\/$/, '')}/${route.replace(/^\//, '')}`;
}

async function getAccessibleService(req, serviceId) {
  const service = await prisma.service.findUnique({ where: { id: serviceId }, include: { agent: true, client: true } });
  if (!service || !service.enabled || !service.agent.enabled || (req.user.role === 'CLIENT' && service.clientId !== req.user.clientId)) return null;
  return service;
}

const accessTypeSchema = z.enum(['SFTP', 'DATABASE']);
const optionalAccessText = z.string().trim().max(2000).optional().nullable();
const accessCreateSchema = z.object({
  clientId: z.string().min(1),
  type: accessTypeSchema,
  label: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(500),
  path: optionalAccessText,
  databaseName: optionalAccessText,
  sslMode: optionalAccessText,
  notes: optionalAccessText,
  enabled: z.boolean().optional(),
});
const accessUpdateSchema = z.object({
  type: accessTypeSchema.optional(),
  label: z.string().trim().min(1).max(120).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  password: z.string().min(1).max(500).optional(),
  path: optionalAccessText,
  databaseName: optionalAccessText,
  sslMode: optionalAccessText,
  notes: optionalAccessText,
  enabled: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied' });

function cleanAccessText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function validateAccessShape(type, path, databaseName) {
  if (type === 'SFTP' && !path) return 'SFTP access requires a path';
  if (type === 'DATABASE' && !databaseName) return 'Database access requires a maintenance database';
  return null;
}

function accessRecordValues(input, current = null) {
  const type = input.type ?? current?.type;
  const path = type === 'SFTP'
    ? cleanAccessText(input.path !== undefined ? input.path : current?.path)
    : null;
  const databaseName = type === 'DATABASE'
    ? cleanAccessText(input.databaseName !== undefined ? input.databaseName : current?.databaseName)
    : null;
  const sslMode = type === 'DATABASE'
    ? cleanAccessText(input.sslMode !== undefined ? input.sslMode : current?.sslMode) || 'Prefer'
    : null;

  return {
    type,
    label: input.label ?? current?.label,
    host: input.host ?? current?.host,
    port: input.port ?? current?.port,
    username: input.username ?? current?.username,
    path,
    databaseName,
    sslMode,
    notes: input.notes !== undefined ? cleanAccessText(input.notes) : current?.notes ?? null,
    enabled: input.enabled ?? current?.enabled ?? true,
  };
}

function serializeClientAccess(entry) {
  const { passwordEncrypted, ...access } = entry;
  let password = null;
  try {
    password = decryptSecret(passwordEncrypted);
  } catch (error) {
    console.error('Unable to decrypt client access credentials:', error.message);
  }
  return { ...access, password };
}

function accessAuditMetadata(access) {
  return {
    clientId: access.clientId,
    type: access.type,
    label: access.label,
    host: access.host,
    port: access.port,
    username: access.username,
  };
}

app.get('/api/access', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'CLIENT') return res.status(403).json({ message: 'Client access required' });
    const entries = await prisma.clientAccess.findMany({
      where: { clientId: req.user.clientId, enabled: true },
      orderBy: [{ type: 'asc' }, { label: 'asc' }],
    });
    res.json({ access: entries.map(serializeClientAccess) });
  } catch (error) {
    next(error);
  }
});

function serviceDeploymentConfig(service) {
  return {
    id: service.id,
    name: service.name,
    slug: service.slug,
    type: service.type,
    repositoryUrl: service.repositoryUrl,
    branch: service.branch,
    projectKey: service.projectKey,
    webhookUrl: service.webhookUrl,
    workingDirectory: service.workingDirectory,
    deployDirectory: service.deployDirectory,
    enabled: service.enabled,
    pm2ProcessName: service.pm2ProcessName,
    templateKey: service.templateKey,
    customCommands: service.customCommands,
  };
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function upstreamMessage(parsed, body) {
  const message = typeof parsed?.message === 'string' ? parsed.message : body;
  return String(message || 'Pipeline request failed').slice(0, 2000);
}

async function requestServiceDeployment(service, { requestedBy, runId, source = 'console' } = {}) {
  if (!service.agent?.apiKeyEncrypted) {
    return {
      ok: false,
      httpStatus: 409,
      body: 'Pipeline agent is not enrolled',
      parsed: null,
      deploymentRunId: runId,
    };
  }

  try {
    const response = await fetch(agentUrl(service.agent, `/webhook/${encodeURIComponent(service.projectKey)}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Console-Agent-Id': service.agent.id,
        'X-Console-Agent-Key': decryptAgentKey(service.agent.apiKeyEncrypted),
      },
      body: JSON.stringify({
        source,
        requestedBy,
        runId,
        service: serviceDeploymentConfig(service),
      }),
      signal: AbortSignal.timeout(30 * 1000),
    });
    const body = await response.text();
    const parsed = parseJsonBody(body);
    return {
      ok: response.ok,
      httpStatus: response.status,
      body,
      parsed,
      deploymentRunId: typeof parsed?.runId === 'string' && parsed.runId ? parsed.runId : runId,
    };
  } catch (error) {
    const body = JSON.stringify({ message: 'Pipeline agent is unreachable', error: error.message });
    return { ok: false, httpStatus: 502, body, parsed: parseJsonBody(body), deploymentRunId: runId };
  }
}

function newDeploymentRunId() {
  return `console-${crypto.randomUUID()}`;
}

app.post('/api/services/:serviceId/deploy', requireAuth, async (req, res, next) => {
  try {
    const service = await getAccessibleService(req, req.params.serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found' });
    const runId = newDeploymentRunId();
    const result = await requestServiceDeployment(service, {
      requestedBy: req.user.email,
      runId,
      source: 'console',
    });
    if (!result.ok) {
      return res.status(result.httpStatus === 409 ? 409 : 502).json({
        message: result.httpStatus === 409 ? 'Pipeline agent is not enrolled' : 'Pipeline agent rejected deployment',
        upstreamStatus: result.httpStatus,
        upstreamBody: result.body,
      });
    }
    await writeAudit(req.user.email, 'DEPLOYMENT_REQUESTED', 'Service', service.id, {
      triggerSource: 'console',
      runId: result.deploymentRunId,
    });
    res.status(202).json({
      serviceId: service.id,
      runId: result.deploymentRunId,
      message: 'Deployment requested',
      agentResponse: result.body,
    });
  } catch (error) { next(error); }
});

const webhookHealthServiceSelect = {
  id: true,
  name: true,
  slug: true,
  type: true,
  pm2ProcessName: true,
  enabled: true,
};
const webhookScheduleClientSelect = {
  id: true,
  name: true,
  email: true,
  enabled: true,
  webhookScheduleEnabled: true,
  webhookScheduleIntervalDays: true,
  webhookScheduleNextRunAt: true,
  webhookScheduleLastRunAt: true,
};

function serializeWebhookSchedule(client) {
  return {
    clientId: client.id,
    enabled: client.webhookScheduleEnabled,
    intervalDays: client.webhookScheduleIntervalDays ?? null,
    nextRunAt: client.webhookScheduleNextRunAt ?? null,
    lastRunAt: client.webhookScheduleLastRunAt ?? null,
    timeZone: webhookScheduleOptions.timeZone,
    hour: webhookScheduleOptions.hour,
  };
}

function serializeDeploymentSummary(deployment) {
  if (!deployment) return null;
  return {
    runId: deployment.runId,
    status: deployment.status,
    triggerSource: deployment.triggerSource,
    startedAt: deployment.startedAt,
    completedAt: deployment.completedAt,
    durationMs: deployment.durationMs,
    failureReason: deployment.failureReason,
  };
}

async function serializeWebhookHealthRun(run) {
  const deploymentRunIds = [...new Set(
    (run.checks || [])
      .map((check) => check.deploymentRunId)
      .filter((runId) => typeof runId === 'string' && runId),
  )];
  const deployments = deploymentRunIds.length
    ? await prisma.deployment.findMany({
      where: { runId: { in: deploymentRunIds } },
      select: {
        runId: true,
        status: true,
        triggerSource: true,
        startedAt: true,
        completedAt: true,
        durationMs: true,
        failureReason: true,
      },
    })
    : [];
  const deploymentsByRunId = new Map(deployments.map((deployment) => [deployment.runId, deployment]));
  const checks = [...(run.checks || [])].sort((left, right) =>
    (left.service?.name || '').localeCompare(right.service?.name || ''),
  );

  return {
    id: run.id,
    clientId: run.clientId,
    source: run.source,
    status: run.status,
    requestedBy: run.requestedBy,
    totalServices: run.totalServices,
    successfulServices: run.successfulServices,
    failedServices: run.failedServices,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    checks: checks.map((check) => ({
      id: check.id,
      serviceId: check.serviceId,
      service: check.service,
      status: check.status,
      httpStatus: check.httpStatus,
      message: check.message,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
      durationMs: check.durationMs,
      deployment: serializeDeploymentSummary(deploymentsByRunId.get(check.deploymentRunId)),
    })),
  };
}

async function loadWebhookHealth(clientId) {
  const [client, latestRun, recentRuns] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId }, select: webhookScheduleClientSelect }),
    prisma.webhookHealthRun.findFirst({
      where: { clientId },
      orderBy: { startedAt: 'desc' },
      include: {
        checks: {
          include: { service: { select: webhookHealthServiceSelect } },
          orderBy: { createdAt: 'asc' },
        },
      },
    }),
    prisma.webhookHealthRun.findMany({
      where: { clientId },
      orderBy: { startedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        source: true,
        status: true,
        totalServices: true,
        successfulServices: true,
        failedServices: true,
        startedAt: true,
        completedAt: true,
      },
    }),
  ]);

  if (!client || !client.enabled) return null;
  const serializedLatestRun = latestRun ? await serializeWebhookHealthRun(latestRun) : null;
  return {
    schedule: serializeWebhookSchedule(client),
    latestRun: serializedLatestRun,
    activeRun: serializedLatestRun?.status === 'RUNNING' ? serializedLatestRun : null,
    recentRuns,
  };
}

function requestedWebhookClientId(req, source) {
  if (req.user?.role === 'CLIENT') return req.user.clientId;
  if (req.user?.role !== 'SUPER_ADMIN') return null;
  const candidate = source === 'query' ? req.query.clientId : req.body?.clientId;
  return typeof candidate === 'string' && candidate ? candidate : null;
}

function webhookCheckDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  return Math.max(new Date(completedAt).getTime() - new Date(startedAt).getTime(), 0);
}

async function refreshWebhookRunProgress(runId) {
  const checks = await prisma.webhookHealthCheck.findMany({
    where: { runId },
    select: { status: true },
  });
  await prisma.webhookHealthRun.updateMany({
    where: { id: runId, status: 'RUNNING' },
    data: {
      successfulServices: checks.filter((check) => check.status === 'SUCCESS').length,
      failedServices: checks.filter((check) => check.status === 'FAILED').length,
    },
  });
}

async function failWebhookCheck(checkId, message, httpStatus, startedAt = null) {
  const completedAt = new Date();
  await prisma.webhookHealthCheck.update({
    where: { id: checkId },
    data: {
      status: 'FAILED',
      httpStatus: httpStatus ?? null,
      message: String(message || 'Webhook check failed').slice(0, 2000),
      completedAt,
      durationMs: webhookCheckDuration(startedAt, completedAt),
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWebhookCheckResult({ runId, checkId, deploymentRunId, httpStatus, startedAt }) {
  const deadline = Date.now() + webhookHealthTimeoutMs;

  while (true) {
    const deployment = await prisma.deployment.findUnique({
      where: { runId: deploymentRunId },
      select: {
        status: true,
        completedAt: true,
        failureReason: true,
      },
    });

    if (deployment && deployment.status !== 'DEPLOYING') {
      const completedAt = deployment.completedAt || new Date();
      if (deployment.status === 'SUCCESS') {
        await prisma.webhookHealthCheck.update({
          where: { id: checkId },
          data: {
            status: 'SUCCESS',
            message: 'Deployment completed successfully',
            completedAt,
            durationMs: webhookCheckDuration(startedAt, completedAt),
          },
        });
      } else {
        await prisma.webhookHealthCheck.update({
          where: { id: checkId },
          data: {
            status: 'FAILED',
            message: (deployment.failureReason || `Deployment finished with ${deployment.status}`).slice(0, 2000),
            completedAt,
            durationMs: webhookCheckDuration(startedAt, completedAt),
          },
        });
      }
      await refreshWebhookRunProgress(runId);
      return;
    }

    if (Date.now() >= deadline) {
      await failWebhookCheck(
        checkId,
        'Timed out waiting for the pipeline deployment result',
        httpStatus,
        startedAt,
      );
      await refreshWebhookRunProgress(runId);
      return;
    }

    await sleep(Math.min(webhookHealthPollMs, Math.max(deadline - Date.now(), 250)));
  }
}

async function finalizeWebhookHealthRun(runId, actorEmail) {
  const checks = await prisma.webhookHealthCheck.findMany({
    where: { runId },
    select: { status: true },
  });
  const successfulServices = checks.filter((check) => check.status === 'SUCCESS').length;
  const failedServices = checks.length - successfulServices;
  const status = checks.length > 0 && successfulServices === checks.length
    ? 'SUCCESS'
    : successfulServices > 0
      ? 'PARTIAL'
      : 'FAILED';

  const run = await prisma.webhookHealthRun.update({
    where: { id: runId },
    data: {
      status,
      successfulServices,
      failedServices,
      completedAt: new Date(),
    },
  });

  await writeAudit(actorEmail, 'WEBHOOK_HEALTH_RUN_COMPLETED', 'WebhookHealthRun', run.id, {
    clientId: run.clientId,
    status: run.status,
    successfulServices,
    failedServices,
  });
  return run;
}

async function executeWebhookHealthRun({ runId, client, services, requestedBy }) {
  const servicesById = new Map(services.map((service) => [service.id, service]));

  try {
    const checks = await prisma.webhookHealthCheck.findMany({
      where: { runId },
      orderBy: { createdAt: 'asc' },
    });
    checks.sort((left, right) =>
      (servicesById.get(left.serviceId)?.name || '').localeCompare(servicesById.get(right.serviceId)?.name || ''),
    );

    for (const check of checks) {
      const service = servicesById.get(check.serviceId);
      if (!service || !service.enabled || !service.agent?.enabled) {
        await failWebhookCheck(check.id, 'Service or its pipeline agent is disabled', null);
        await refreshWebhookRunProgress(runId);
        continue;
      }

      const startedAt = new Date();
      await prisma.webhookHealthCheck.update({
        where: { id: check.id },
        data: {
          status: 'RUNNING',
          startedAt,
          completedAt: null,
          durationMs: null,
          httpStatus: null,
          message: 'Calling the pipeline webhook',
        },
      });

      let result;
      try {
        result = await requestServiceDeployment(service, {
          requestedBy,
          runId: `health-${crypto.randomUUID()}`,
          source: 'console',
        });
      } catch (error) {
        result = {
          ok: false,
          httpStatus: 502,
          body: JSON.stringify({ message: error.message }),
          parsed: { message: error.message },
          deploymentRunId: null,
        };
      }

      if (!result.ok) {
        await failWebhookCheck(
          check.id,
          upstreamMessage(result.parsed, result.body),
          result.httpStatus,
          startedAt,
        );
        await refreshWebhookRunProgress(runId);
        continue;
      }

      await prisma.webhookHealthCheck.update({
        where: { id: check.id },
        data: {
          status: 'RUNNING',
          httpStatus: result.httpStatus,
          deploymentRunId: result.deploymentRunId,
          message: 'Webhook accepted; waiting for the pipeline deployment',
        },
      });
      await refreshWebhookRunProgress(runId);
      await waitForWebhookCheckResult({
        runId,
        checkId: check.id,
        deploymentRunId: result.deploymentRunId,
        httpStatus: result.httpStatus,
        startedAt,
      });
    }

    await finalizeWebhookHealthRun(runId, requestedBy || client.email);
  } catch (error) {
    console.error(`Webhook health run ${runId} failed:`, error);
    const completedAt = new Date();
    await prisma.webhookHealthCheck.updateMany({
      where: { runId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        message: `Health check runner failed: ${error.message}`.slice(0, 2000),
        completedAt,
      },
    });
    const failedChecks = await prisma.webhookHealthCheck.findMany({
      where: { runId },
      select: { status: true },
    }).catch(() => []);
    const successfulServices = failedChecks.filter((check) => check.status === 'SUCCESS').length;
    await prisma.webhookHealthRun.update({
      where: { id: runId },
      data: {
        status: successfulServices > 0 ? 'PARTIAL' : 'FAILED',
        successfulServices,
        failedServices: failedChecks.length - successfulServices,
        completedAt,
      },
    }).catch(() => {});
  } finally {
    activeWebhookClients.delete(client.id);
  }
}

async function startWebhookHealthRun({ client, source, requestedBy }) {
  if (activeWebhookClients.has(client.id)) {
    const activeRun = await prisma.webhookHealthRun.findFirst({
      where: { clientId: client.id, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
    });
    return { conflict: activeRun || { status: 'RUNNING', clientId: client.id } };
  }

  activeWebhookClients.add(client.id);
  try {
    const activeRun = await prisma.webhookHealthRun.findFirst({
      where: { clientId: client.id, status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
    });
    if (activeRun) {
      activeWebhookClients.delete(client.id);
      return { conflict: activeRun };
    }

    const services = await prisma.service.findMany({
      where: { clientId: client.id, enabled: true },
      include: { agent: true },
      orderBy: { name: 'asc' },
    });
    if (services.length === 0) {
      activeWebhookClients.delete(client.id);
      return { error: 'No enabled services are available for a webhook health check' };
    }

    const run = await prisma.webhookHealthRun.create({
      data: {
        clientId: client.id,
        source,
        requestedBy,
        totalServices: services.length,
        checks: { create: services.map((service) => ({ serviceId: service.id })) },
      },
      include: {
        checks: {
          include: { service: { select: webhookHealthServiceSelect } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    await prisma.client.update({
      where: { id: client.id },
      data: { webhookScheduleLastRunAt: new Date() },
    });

    void executeWebhookHealthRun({
      runId: run.id,
      client,
      services,
      requestedBy,
    }).catch((error) => {
      console.error(`Unhandled webhook health run error for ${run.id}:`, error);
    });

    return { run };
  } catch (error) {
    activeWebhookClients.delete(client.id);
    throw error;
  }
}

app.get('/api/webhook-health', requireAuth, async (req, res, next) => {
  try {
    const clientId = requestedWebhookClientId(req, 'query');
    if (!clientId) return res.status(400).json({ message: 'clientId is required for super-admin access' });
    const health = await loadWebhookHealth(clientId);
    if (!health) return res.status(404).json({ message: 'Client not found' });
    res.json(health);
  } catch (error) { next(error); }
});

app.patch('/api/webhook-health/schedule', requireAuth, async (req, res, next) => {
  try {
    const clientId = requestedWebhookClientId(req, 'body');
    if (!clientId) return res.status(400).json({ message: 'clientId is required for super-admin access' });
    const parsed = z.object({
      enabled: z.boolean(),
      intervalDays: z.coerce.number().int().min(1).max(365).optional(),
    }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Interval must be between 1 and 365 days', issues: parsed.error.issues });
    }

    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: webhookScheduleClientSelect,
    });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (!client.enabled) return res.status(403).json({ message: 'Client account is disabled' });

    const intervalDays = parsed.data.intervalDays ?? client.webhookScheduleIntervalDays;
    if (parsed.data.enabled && !intervalDays) {
      return res.status(400).json({ message: 'Choose an interval before enabling automatic webhook checks' });
    }

    let nextRunAt = null;
    if (parsed.data.enabled) {
      const intervalChanged = intervalDays !== client.webhookScheduleIntervalDays;
      nextRunAt = client.webhookScheduleEnabled && !intervalChanged && client.webhookScheduleNextRunAt
        ? client.webhookScheduleNextRunAt
        : nextScheduledRun(new Date(), webhookScheduleOptions);
    }

    const updated = await prisma.client.update({
      where: { id: client.id },
      data: {
        webhookScheduleEnabled: parsed.data.enabled,
        webhookScheduleIntervalDays: intervalDays ?? null,
        webhookScheduleNextRunAt: nextRunAt,
      },
      select: webhookScheduleClientSelect,
    });

    await writeAudit(req.user.email, 'WEBHOOK_SCHEDULE_UPDATED', 'Client', client.id, {
      enabled: updated.webhookScheduleEnabled,
      intervalDays: updated.webhookScheduleIntervalDays,
      nextRunAt: updated.webhookScheduleNextRunAt?.toISOString() ?? null,
    });
    res.json({ schedule: serializeWebhookSchedule(updated) });
  } catch (error) { next(error); }
});

app.post('/api/webhook-health/run', requireAuth, async (req, res, next) => {
  try {
    const clientId = requestedWebhookClientId(req, 'body');
    if (!clientId) return res.status(400).json({ message: 'clientId is required for super-admin access' });
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: webhookScheduleClientSelect,
    });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    if (!client.enabled) return res.status(403).json({ message: 'Client account is disabled' });

    const result = await startWebhookHealthRun({
      client,
      source: 'MANUAL',
      requestedBy: req.user.email,
    });
    if (result.conflict) {
      return res.status(409).json({
        message: 'A webhook health check is already running for this client',
        run: result.conflict,
      });
    }
    if (result.error) return res.status(400).json({ message: result.error });

    await writeAudit(req.user.email, 'WEBHOOK_HEALTH_RUN_REQUESTED', 'WebhookHealthRun', result.run.id, {
      clientId: client.id,
      source: 'MANUAL',
    });
    res.status(202).json({ run: await serializeWebhookHealthRun(result.run) });
  } catch (error) { next(error); }
});

app.get('/api/services/:serviceId/pm2/logs/stream', requireAuth, async (req, res, next) => {
  try {
    const service = await getAccessibleService(req, req.params.serviceId);
    if (!service || service.type !== 'PM2' || !service.pm2ProcessName) return res.status(404).json({ message: 'PM2 service not found' });
    const lines = Math.min(Math.max(Number(req.query.lines) || 100, 1), 1000);
    if (!service.agent.apiKeyEncrypted) return res.status(409).json({ message: 'Pipeline agent is not enrolled' });
    const upstream = await fetch(agentUrl(service.agent, `/pm2/logs/${encodeURIComponent(service.pm2ProcessName)}/stream?lines=${lines}`), { headers: { Accept: 'text/event-stream', 'X-Console-Agent-Id': service.agent.id, 'X-Console-Agent-Key': decryptAgentKey(service.agent.apiKeyEncrypted) } });
    if (!upstream.ok || !upstream.body) return res.status(502).json({ message: 'Unable to connect to pipeline agent logs' });
    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const reader = upstream.body.getReader();
    req.on('close', () => reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) next(error); else res.end();
  }
});

app.get('/api/services/:serviceId/pm2/status', requireAuth, async (req, res, next) => {
  try {
    const service = await getAccessibleService(req, req.params.serviceId);
    if (!service || service.type !== 'PM2' || !service.pm2ProcessName || !service.agent.apiKeyEncrypted) return res.status(404).json({ message: 'PM2 service not found' });
    const response = await fetch(agentUrl(service.agent, `/pm2/status/${encodeURIComponent(service.pm2ProcessName)}`), { headers: { 'X-Console-Agent-Id': service.agent.id, 'X-Console-Agent-Key': decryptAgentKey(service.agent.apiKeyEncrypted) } });
    const body = await response.text();
    res.status(response.ok ? 200 : 502).type('application/json').send(body);
  } catch (error) { next(error); }
});

app.get('/api/admin/access', requireAuth, requireSuperAdmin, async (_req, res, next) => {
  try {
    const entries = await prisma.clientAccess.findMany({
      include: { client: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ access: entries.map(serializeClientAccess) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/access', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = accessCreateSchema.parse(req.body);
    const values = accessRecordValues(input);
    const validationError = validateAccessShape(values.type, values.path, values.databaseName);
    if (validationError) return res.status(400).json({ message: validationError });
    const client = await prisma.client.findUnique({ where: { id: input.clientId } });
    if (!client) return res.status(404).json({ message: 'Client not found' });

    const entry = await prisma.clientAccess.create({
      data: {
        ...values,
        clientId: input.clientId,
        passwordEncrypted: encryptSecret(input.password),
      },
      include: { client: { select: { id: true, name: true, email: true } } },
    });
    await writeAudit(req.user.email, 'ACCESS_CREATED', 'ClientAccess', entry.id, accessAuditMetadata(entry));
    res.status(201).json({ access: serializeClientAccess(entry) });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid access details', issues: error.issues });
    next(error);
  }
});

app.patch('/api/admin/access/:accessId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const existing = await prisma.clientAccess.findUnique({ where: { id: req.params.accessId } });
    if (!existing) return res.status(404).json({ message: 'Access entry not found' });
    const input = accessUpdateSchema.parse(req.body);
    const values = accessRecordValues(input, existing);
    const validationError = validateAccessShape(values.type, values.path, values.databaseName);
    if (validationError) return res.status(400).json({ message: validationError });

    const entry = await prisma.clientAccess.update({
      where: { id: existing.id },
      data: {
        ...values,
        ...(input.password ? { passwordEncrypted: encryptSecret(input.password) } : {}),
      },
      include: { client: { select: { id: true, name: true, email: true } } },
    });
    await writeAudit(req.user.email, 'ACCESS_UPDATED', 'ClientAccess', entry.id, accessAuditMetadata(entry));
    res.json({ access: serializeClientAccess(entry) });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid access details', issues: error.issues });
    next(error);
  }
});

app.delete('/api/admin/access/:accessId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const existing = await prisma.clientAccess.findUnique({ where: { id: req.params.accessId } });
    if (!existing) return res.status(404).json({ message: 'Access entry not found' });
    await prisma.clientAccess.delete({ where: { id: existing.id } });
    await writeAudit(req.user.email, 'ACCESS_DELETED', 'ClientAccess', existing.id, accessAuditMetadata(existing));
    res.json({ deleted: true, accessId: existing.id });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/clients', requireAuth, requireSuperAdmin, async (_req, res, next) => {
  try {
    const clients = await prisma.client.findMany({ include: { _count: { select: { services: true, accessEntries: true } } }, orderBy: { createdAt: 'desc' } });
    res.json({ clients: clients.map(({ passwordHash, ...client }) => client) });
  } catch (error) { next(error); }
});

app.get('/api/templates', requireAuth, (_req, res) => {
  res.json({ templates: serviceTemplates });
});

app.get('/api/admin/agents/:agentId/pm2/processes', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const agent = await prisma.serverAgent.findUnique({ where: { id: req.params.agentId } });
    if (!agent?.enabled || !agent.apiKeyEncrypted) return res.status(404).json({ message: 'Enabled enrolled agent not found' });
    const response = await fetch(agentUrl(agent, '/pm2/processes'), {
      headers: { 'X-Console-Agent-Id': agent.id, 'X-Console-Agent-Key': decryptAgentKey(agent.apiKeyEncrypted) },
      signal: AbortSignal.timeout(15 * 1000),
    });
    const body = await response.text();
    res.status(response.status).type('application/json').send(body);
  } catch (error) { next(error); }
});

app.get('/api/admin/repository-metadata', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const value = String(req.query.url || '').trim();
    const match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i);
    if (!match) return res.status(400).json({ message: 'Only GitHub repository URLs are supported for automatic metadata' });
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HexTorq-Cloud-Console' },
      signal: AbortSignal.timeout(10 * 1000),
    });
    if (!response.ok) return res.status(400).json({ message: 'GitHub repository could not be found' });
    const repository = await response.json();
    res.json({ slug: String(repository.name || match[2]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), branch: repository.default_branch || 'main' });
  } catch (error) { next(error); }
});

app.post('/api/admin/clients', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2), email: z.string().email(), temporaryPassword: z.string().min(8).optional() }).parse(req.body);
    const temporaryPassword = input.temporaryPassword || crypto.randomBytes(9).toString('base64url');
    const client = await prisma.client.create({ data: { name: input.name, email: input.email.toLowerCase(), passwordHash: await bcrypt.hash(temporaryPassword, 12) } });
    await writeAudit(req.user.email, 'CLIENT_CREATED', 'Client', client.id, { email: client.email });
    const { passwordHash, ...safeClient } = client;
    res.status(201).json({ client: safeClient, temporaryPassword });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid client details', issues: error.issues });
    next(error);
  }
});

app.get('/api/admin/agents', requireAuth, requireSuperAdmin, async (_req, res, next) => {
  try {
    const agents = await prisma.serverAgent.findMany({ select: { id: true, name: true, baseUrl: true, enabled: true, lastSeenAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
    res.json({ agents });
  } catch (error) { next(error); }
});

app.get('/api/admin/settings', requireAuth, requireSuperAdmin, async (_req, res, next) => {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'log_retention_days' } });
    res.json({ logRetentionDays: Number(setting?.value || process.env.LOG_RETENTION_DAYS || 30) });
  } catch (error) { next(error); }
});

app.patch('/api/admin/settings', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = z.object({ logRetentionDays: z.number().int().min(1).max(3650) }).parse(req.body);
    await prisma.systemSetting.upsert({ where: { key: 'log_retention_days' }, create: { key: 'log_retention_days', value: String(input.logRetentionDays) }, update: { value: String(input.logRetentionDays) } });
    await writeAudit(req.user.email, 'RETENTION_UPDATED', 'SystemSetting', 'log_retention_days', input);
    res.json({ logRetentionDays: input.logRetentionDays });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Retention must be between 1 and 3650 days' });
    next(error);
  }
});

app.post('/api/admin/agents', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2), baseUrl: z.string().url() }).parse(req.body);
    const enrollmentToken = crypto.randomBytes(32).toString('hex');
    const agent = await prisma.serverAgent.create({ data: { name: input.name, baseUrl: input.baseUrl, enrollmentToken } });
    await writeAudit(req.user.email, 'AGENT_CREATED', 'ServerAgent', agent.id, { baseUrl: agent.baseUrl });
    res.status(201).json({ agent: { id: agent.id, name: agent.name, baseUrl: agent.baseUrl }, enrollmentToken });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid agent details', issues: error.issues });
    next(error);
  }
});

app.post('/api/admin/agents/:agentId/enrollment-token', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const agent = await prisma.serverAgent.findUnique({ where: { id: req.params.agentId } });
    if (!agent) return res.status(404).json({ message: 'Agent not found' });

    const enrollmentToken = crypto.randomBytes(32).toString('hex');
    await prisma.serverAgent.update({
      where: { id: agent.id },
      data: { enrollmentToken },
    });
    await writeAudit(req.user.email, 'AGENT_ENROLLMENT_TOKEN_REGENERATED', 'ServerAgent', agent.id, {
      agentId: agent.id,
    });
    res.json({ agentId: agent.id, enrollmentToken });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/services', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = z.object({
      name: z.string().min(2),
      slug: z.string().regex(/^[a-z0-9-]+$/),
      type: z.enum(['PM2', 'STATIC_FRONTEND']),
      repositoryUrl: z.string().url(),
      branch: z.string().min(1).default('main'),
      projectKey: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
      webhookUrl: z.string().url().optional(),
      workingDirectory: z.string().min(1),
      deployDirectory: z.string().optional(),
      pm2ProcessName: z.string().optional(),
      templateKey: z.string().optional(),
      customCommands: z.record(z.string(), z.string()).optional(),
      clientId: z.string().min(1),
      agentId: z.string().min(1),
    }).parse(req.body);
    if (input.type === 'PM2' && !input.pm2ProcessName) return res.status(400).json({ message: 'pm2ProcessName is required for PM2 services' });
    if (input.type === 'STATIC_FRONTEND' && !input.deployDirectory) return res.status(400).json({ message: 'deployDirectory is required for static frontend services' });
    const [client, agent] = await Promise.all([prisma.client.findUnique({ where: { id: input.clientId } }), prisma.serverAgent.findUnique({ where: { id: input.agentId } })]);
    if (!client || !agent || !agent.enabled) return res.status(400).json({ message: 'Client or enabled agent not found' });
    const service = await prisma.service.create({ data: input });
    await writeAudit(req.user.email, 'SERVICE_CREATED', 'Service', service.id, { clientId: service.clientId, agentId: service.agentId });
    res.status(201).json({ service });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid service details', issues: error.issues });
    next(error);
  }
});

app.patch('/api/admin/services/:serviceId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().min(2).optional(), branch: z.string().min(1).optional(), webhookUrl: z.string().url().optional().nullable(), enabled: z.boolean().optional(), templateKey: z.string().optional(), customCommands: z.record(z.string(), z.string()).optional(), pm2ProcessName: z.string().optional(), deployDirectory: z.string().optional() }).parse(req.body);
    const service = await prisma.service.update({ where: { id: req.params.serviceId }, data: input });
    await writeAudit(req.user.email, 'SERVICE_UPDATED', 'Service', service.id, input);
    res.json({ service });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid service details', issues: error.issues });
    next(error);
  }
});

app.delete('/api/admin/services/:serviceId', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const service = await prisma.service.delete({ where: { id: req.params.serviceId } });
    await writeAudit(req.user.email, 'SERVICE_DELETED', 'Service', service.id, { name: service.name });
    res.json({ deleted: true, serviceId: service.id });
  } catch (error) { next(error); }
});

app.get('/api/deployments', requireAuth, async (req, res, next) => {
  try {
    const where = req.user.role === 'CLIENT' ? { service: { clientId: req.user.clientId } } : {};
    const deployments = await prisma.deployment.findMany({ where, include: { service: { select: { id: true, name: true, projectKey: true } }, agent: { select: { id: true, name: true } } }, orderBy: { startedAt: 'desc' }, take: 100 });
    res.json({ deployments });
  } catch (error) { next(error); }
});

app.get('/api/deployments/:deploymentId/logs', requireAuth, async (req, res, next) => {
  try {
    const deployment = await prisma.deployment.findUnique({ where: { id: req.params.deploymentId }, include: { service: true } });
    if (!deployment || (req.user.role === 'CLIENT' && deployment.service.clientId !== req.user.clientId)) return res.status(404).json({ message: 'Deployment not found' });
    const logs = await prisma.deploymentLog.findMany({ where: { deploymentId: deployment.id }, orderBy: { timestamp: 'asc' } });
    res.json({ deployment, logs });
  } catch (error) { next(error); }
});

app.post('/api/agents/enroll', async (req, res, next) => {
  try {
    const input = z.object({ agentId: z.string(), enrollmentToken: z.string().min(1), apiKey: z.string().min(32) }).parse(req.body);
    const agent = await prisma.serverAgent.findUnique({ where: { id: input.agentId } });
    if (!agent || !agent.enabled || agent.enrollmentToken !== input.enrollmentToken) return res.status(401).json({ message: 'Invalid enrollment details' });
    await prisma.serverAgent.update({ where: { id: agent.id }, data: { apiKeyHash: await bcrypt.hash(input.apiKey, 12), apiKeyEncrypted: encryptAgentKey(input.apiKey), enrollmentToken: crypto.randomBytes(32).toString('hex'), lastSeenAt: new Date() } });
    res.json({ enrolled: true, agentId: agent.id });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid enrollment details' });
    next(error);
  }
});

app.post('/api/agents/:agentId/heartbeat', requireAgentKey, async (req, res, next) => {
  try {
    if (req.params.agentId !== req.agentCredentials.agentId) return res.status(403).json({ message: 'Agent identity mismatch' });
    const agent = await prisma.serverAgent.findUnique({ where: { id: req.params.agentId } });
    if (!agent || !agent.enabled || !agent.apiKeyHash || !(await bcrypt.compare(req.agentCredentials.key, agent.apiKeyHash))) return res.status(401).json({ message: 'Invalid agent credentials' });
    await prisma.serverAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch (error) { next(error); }
});

app.post('/api/agents/:agentId/events', requireAgentKey, async (req, res, next) => {
  try {
    if (req.params.agentId !== req.agentCredentials.agentId) return res.status(403).json({ message: 'Agent identity mismatch' });
    const agent = await prisma.serverAgent.findUnique({ where: { id: req.params.agentId } });
    if (!agent || !agent.enabled || !agent.apiKeyHash || !(await bcrypt.compare(req.agentCredentials.key, agent.apiKeyHash))) return res.status(401).json({ message: 'Invalid agent credentials' });
    const input = z.object({
      type: z.enum(['deployment-started', 'deployment-log', 'deployment-completed']),
      projectKey: z.string().min(1),
      runId: z.string().min(1),
      message: z.string().optional(),
      status: z.enum(['DEPLOYING', 'SUCCESS', 'FAILED', 'ERROR']).optional(),
      commitHash: z.string().optional(),
      branch: z.string().optional(),
      commitMessage: z.string().optional(),
      failureReason: z.string().optional(),
      triggerSource: z.enum(['console', 'webhook']).optional(),
      deployerEmail: z.string().email().optional(),
      timestamp: z.string().datetime().optional(),
    }).parse(req.body);
    const service = await prisma.service.findFirst({ where: { projectKey: input.projectKey, agentId: agent.id } });
    if (!service) return res.status(404).json({ message: 'Service is not registered to this agent' });
    if (input.type === 'deployment-started') {
      await prisma.deployment.upsert({ where: { runId: input.runId }, create: { runId: input.runId, serviceId: service.id, agentId: agent.id, triggerSource: input.triggerSource || 'webhook', deployerEmail: input.deployerEmail, status: 'DEPLOYING', commitHash: input.commitHash, branch: input.branch, commitMessage: input.commitMessage }, update: {} });
    } else {
      const deployment = await prisma.deployment.findUnique({ where: { runId: input.runId } });
      if (!deployment) return res.status(404).json({ message: 'Deployment run not found' });
      if (input.type === 'deployment-log' && input.message) await prisma.deploymentLog.create({ data: { deploymentId: deployment.id, message: input.message, timestamp: input.timestamp ? new Date(input.timestamp) : undefined } });
      if (input.type === 'deployment-completed') {
        const completedAt = input.timestamp ? new Date(input.timestamp) : new Date();
        await prisma.deployment.update({ where: { id: deployment.id }, data: { status: input.status || 'ERROR', completedAt, durationMs: completedAt.getTime() - deployment.startedAt.getTime(), failureReason: input.failureReason } });
      }
    }
    await prisma.serverAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
    res.status(202).json({ accepted: true });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ message: 'Invalid deployment event', issues: error.issues });
    next(error);
  }
});

let webhookSchedulerBusy = false;

async function runDueWebhookSchedules() {
  const now = new Date();
  const dueClients = await prisma.client.findMany({
    where: {
      enabled: true,
      webhookScheduleEnabled: true,
      webhookScheduleIntervalDays: { not: null },
      webhookScheduleNextRunAt: { lte: now },
    },
    select: webhookScheduleClientSelect,
  });

  for (const client of dueClients) {
    const intervalDays = client.webhookScheduleIntervalDays;
    if (!intervalDays) continue;

    const nextRunAt = nextScheduledRunAfter(
      client.webhookScheduleNextRunAt || now,
      intervalDays,
      now,
      webhookScheduleOptions,
    );
    await prisma.client.update({
      where: { id: client.id },
      data: { webhookScheduleNextRunAt: nextRunAt },
    });

    try {
      const result = await startWebhookHealthRun({
        client,
        source: 'SCHEDULED',
        requestedBy: schedulerEmail,
      });
      if (result.conflict) {
        console.log(`Skipped scheduled webhook health check for ${client.email}: a run is already active`);
        continue;
      }
      if (result.error) {
        console.log(`Skipped scheduled webhook health check for ${client.email}: ${result.error}`);
        continue;
      }
      await writeAudit(schedulerEmail, 'WEBHOOK_HEALTH_RUN_SCHEDULED', 'WebhookHealthRun', result.run.id, {
        clientId: client.id,
        nextRunAt: nextRunAt.toISOString(),
      });
    } catch (error) {
      console.error(`Scheduled webhook health check failed for ${client.email}:`, error);
    }
  }
}

function startWebhookScheduler() {
  const tick = () => {
    if (webhookSchedulerBusy) return;
    webhookSchedulerBusy = true;
    runDueWebhookSchedules()
      .catch((error) => console.error('Webhook schedule check failed:', error.message))
      .finally(() => {
        webhookSchedulerBusy = false;
      });
  };

  setTimeout(tick, 5000).unref();
  setInterval(tick, 60 * 1000).unref();
}

async function reconcileInterruptedWebhookRuns() {
  const runs = await prisma.webhookHealthRun.findMany({
    where: { status: 'RUNNING' },
    select: { id: true, requestedBy: true },
  });
  if (runs.length === 0) return;

  const completedAt = new Date();
  for (const run of runs) {
    await prisma.webhookHealthCheck.updateMany({
      where: { runId: run.id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        message: 'Health check was interrupted by a console restart',
        completedAt,
      },
    });
    const checks = await prisma.webhookHealthCheck.findMany({
      where: { runId: run.id },
      select: { status: true },
    });
    const successfulServices = checks.filter((check) => check.status === 'SUCCESS').length;
    const failedServices = checks.length - successfulServices;
    const status = checks.length > 0 && successfulServices === checks.length
      ? 'SUCCESS'
      : successfulServices > 0
        ? 'PARTIAL'
        : 'FAILED';
    await prisma.webhookHealthRun.update({
      where: { id: run.id },
      data: {
        status,
        successfulServices,
        failedServices,
        completedAt,
      },
    });
  }

  console.log(`Reconciled ${runs.length} interrupted webhook health run(s)`);
}

const pm2Actions = new Set(['start', 'stop', 'restart', 'reload']);

app.post('/api/services/:serviceId/pm2/:action', requireAuth, async (req, res, next) => {
  try {
    if (!pm2Actions.has(req.params.action)) return res.status(400).json({ message: 'Unsupported PM2 action' });
    const service = await getAccessibleService(req, req.params.serviceId);
    if (!service || service.type !== 'PM2' || !service.pm2ProcessName || !service.agent.apiKeyEncrypted) return res.status(404).json({ message: 'PM2 service not found or agent is not enrolled' });
    const response = await fetch(agentUrl(service.agent, `/control/pm2/${encodeURIComponent(service.pm2ProcessName)}/${req.params.action}`), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Console-Agent-Key': decryptAgentKey(service.agent.apiKeyEncrypted), 'X-Console-Agent-Id': service.agent.id }, body: JSON.stringify({ requestedBy: req.user.email, serviceId: service.id }) });
    const responseBody = await response.text();
    if (!response.ok) return res.status(502).json({ message: 'Pipeline agent rejected PM2 action', upstreamStatus: response.status, upstreamBody: responseBody });
    await writeAudit(req.user.email, `PM2_${req.params.action.toUpperCase()}`, 'Service', service.id, { processName: service.pm2ProcessName });
    res.json({ action: req.params.action, serviceId: service.id, agentResponse: responseBody });
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: 'Internal server error' });
});

await reconcileInterruptedWebhookRuns().catch((error) => {
  console.error('Unable to reconcile interrupted webhook health runs:', error.message);
});
const server = app.listen(port, () => console.log(`HexTorq API listening on port ${port}`));
startWebhookScheduler();

async function shutdown(signal) {
  console.log(`${signal} received; shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function removeExpiredDeploymentLogs() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'log_retention_days' } });
  const days = Math.max(Number(setting?.value || process.env.LOG_RETENTION_DAYS || 30), 1);
  const before = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await prisma.deploymentLog.deleteMany({ where: { timestamp: { lt: before } } });
  if (result.count) console.log(`Removed ${result.count} expired deployment log entries`);
}

removeExpiredDeploymentLogs().catch((error) => console.error('Log retention cleanup failed:', error.message));
setInterval(() => removeExpiredDeploymentLogs().catch((error) => console.error('Log retention cleanup failed:', error.message)), 60 * 60 * 1000).unref();
