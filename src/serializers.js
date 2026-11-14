// Role-aware projections. Every controller response that can carry tenant or
// infrastructure data must pass through these so a CLIENT never receives agent
// secrets, internal URLs, resource metrics or another tenant's data.

const CLIENT_CLIENT_FIELDS = { id: true, name: true, email: true };

/** Minimal safe client projection (never passwordHash/googleSubject). */
export function safeClient(client) {
  if (!client) return client;
  const out = {};
  for (const key of Object.keys(CLIENT_CLIENT_FIELDS)) {
    if (key in client) out[key] = client[key];
  }
  return out;
}

/** Derive agent connectivity from heartbeat timestamps (never `enabled`). */
export function resolveAgentStatus(agent, staleThresholdMs) {
  if (!agent) return 'unknown';
  if (!agent.enabled) return 'disabled';
  if (!agent.lastSeenAt) return 'unknown';
  const elapsed = Date.now() - new Date(agent.lastSeenAt).getTime();
  return elapsed <= staleThresholdMs ? 'online' : 'offline';
}

export function heartbeatMeta(agent, staleThresholdMs) {
  const status = resolveAgentStatus(agent, staleThresholdMs);
  const ageMs = agent?.lastSeenAt ? Date.now() - new Date(agent.lastSeenAt).getTime() : null;
  return {
    status,
    enabled: Boolean(agent?.enabled),
    lastSeenAt: agent?.lastSeenAt ?? null,
    heartbeatAgeSeconds: ageMs === null ? null : Math.max(0, Math.round(ageMs / 1000)),
    staleThresholdSeconds: Math.round(staleThresholdMs / 1000),
  };
}

/**
 * Agent projection.
 * - CLIENT: identity, connectivity and heartbeat age only. No baseUrl, no keys.
 * - SUPER_ADMIN: adds baseUrl/createdAt for operations. Secrets are always removed.
 */
export function serializeAgent(agent, { role, staleThresholdMs } = {}) {
  if (!agent) return agent;
  const meta = heartbeatMeta(agent, staleThresholdMs);
  const base = {
    id: agent.id,
    name: agent.name,
    enabled: meta.enabled,
    status: meta.status,
    lastSeenAt: meta.lastSeenAt,
    heartbeatAgeSeconds: meta.heartbeatAgeSeconds,
    staleThresholdSeconds: meta.staleThresholdSeconds,
  };
  if (role === 'SUPER_ADMIN') {
    return { ...base, baseUrl: agent.baseUrl, createdAt: agent.createdAt, updatedAt: agent.updatedAt };
  }
  return base;
}

/**
 * Service projection. Strips the webhook secret hash for everyone and
 * sanitizes the nested client + agent. Secret-bearing agent fields
 * (apiKeyEncrypted/apiKeyHash/enrollmentToken) are never included.
 */
export function serializeService(service, { role, staleThresholdMs } = {}) {
  if (!service) return service;
  const { webhookSecretHash, client, agent, ...rest } = service;
  const out = { ...rest };
  if (client) out.client = safeClient(client);
  if (agent) out.agent = serializeAgent(agent, { role, staleThresholdMs });
  return out;
}

export function serializeServices(services, options) {
  return (services || []).map((service) => serializeService(service, options));
}

/** Deployment projection — tenant scoping already enforced by the query. */
export function serializeDeployment(deployment) {
  if (!deployment) return deployment;
  return deployment;
}
