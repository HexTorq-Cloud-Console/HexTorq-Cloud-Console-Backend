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

const app = express();
const prisma = new PrismaClient();
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;
const port = Number(process.env.PORT || 4000);

if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
if (!process.env.SUPER_ADMIN_EMAIL || !process.env.SUPER_ADMIN_PASSWORD) {
  throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD are required');
}
const superAdminPasswordHash = await bcrypt.hash(process.env.SUPER_ADMIN_PASSWORD, 12);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000' }));
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

function encryptAgentKey(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${encrypted.toString('hex')}`;
}

function decryptAgentKey(value) {
  const [ivHex, tagHex, encryptedHex] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]).toString('utf8');
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
    const client = await prisma.client.findUnique({ where: { email: payload.email.toLowerCase() } });
    if (!client || !client.enabled) return res.status(403).json({ message: 'This Google account is not registered as a client' });
    await prisma.client.update({ where: { id: client.id }, data: { googleSubject: payload.sub } });
    await writeAudit(client.email, 'AUTH_GOOGLE_LOGIN', 'Client', client.id);
    res.json({ token: createClientToken(client), user: { email: client.email, role: 'CLIENT', clientId: client.id, forcePasswordChange: client.forcePasswordChange } });
  } catch { res.status(401).json({ message: 'Invalid Google credential' }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
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

app.post('/api/services/:serviceId/deploy', requireAuth, async (req, res, next) => {
  try {
    const service = await getAccessibleService(req, req.params.serviceId);
    if (!service) return res.status(404).json({ message: 'Service not found' });
    if (!service.agent.apiKeyEncrypted) return res.status(409).json({ message: 'Pipeline agent is not enrolled' });
    const agentHeaders = { 'Content-Type': 'application/json', 'X-Console-Agent-Id': service.agent.id, 'X-Console-Agent-Key': decryptAgentKey(service.agent.apiKeyEncrypted) };
    const upstream = await fetch(agentUrl(service.agent, `/webhook/${encodeURIComponent(service.projectKey)}`), { method: 'POST', headers: agentHeaders, body: JSON.stringify({ source: 'console', requestedBy: req.user.email }) });
    const body = await upstream.text();
    if (!upstream.ok) return res.status(502).json({ message: 'Pipeline agent rejected deployment', upstreamStatus: upstream.status, upstreamBody: body });
    await writeAudit(req.user.email, 'DEPLOYMENT_REQUESTED', 'Service', service.id, { triggerSource: 'console' });
    res.status(202).json({ serviceId: service.id, message: 'Deployment requested', agentResponse: body });
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

app.get('/api/admin/clients', requireAuth, requireSuperAdmin, async (_req, res, next) => {
  try {
    const clients = await prisma.client.findMany({ include: { _count: { select: { services: true } } }, orderBy: { createdAt: 'desc' } });
    res.json({ clients: clients.map(({ passwordHash, ...client }) => client) });
  } catch (error) { next(error); }
});

app.get('/api/templates', requireAuth, (_req, res) => {
  res.json({ templates: serviceTemplates });
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

app.post('/api/admin/services', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    const input = z.object({
      name: z.string().min(2),
      slug: z.string().regex(/^[a-z0-9-]+$/),
      type: z.enum(['PM2', 'STATIC_FRONTEND']),
      repositoryUrl: z.string().url(),
      branch: z.string().min(1).default('main'),
      projectKey: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
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
    const input = z.object({ name: z.string().min(2).optional(), branch: z.string().min(1).optional(), enabled: z.boolean().optional(), templateKey: z.string().optional(), customCommands: z.record(z.string(), z.string()).optional(), pm2ProcessName: z.string().optional(), deployDirectory: z.string().optional() }).parse(req.body);
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
      timestamp: z.string().datetime().optional(),
    }).parse(req.body);
    const service = await prisma.service.findFirst({ where: { projectKey: input.projectKey, agentId: agent.id } });
    if (!service) return res.status(404).json({ message: 'Service is not registered to this agent' });
    if (input.type === 'deployment-started') {
      await prisma.deployment.upsert({ where: { runId: input.runId }, create: { runId: input.runId, serviceId: service.id, agentId: agent.id, triggerSource: 'webhook', status: 'DEPLOYING', commitHash: input.commitHash, branch: input.branch, commitMessage: input.commitMessage }, update: {} });
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

const server = app.listen(port, () => console.log(`HexTorq API listening on port ${port}`));

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
