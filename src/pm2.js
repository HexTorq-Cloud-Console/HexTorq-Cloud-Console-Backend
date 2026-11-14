// PM2 process DTOs and helpers.
//
// CPU/RAM (and restart counts) are infrastructure resource metrics. They are
// Super-Admin-only. A CLIENT receives a strictly operational DTO that carries
// no resource-utilization fields.

/** Operational status for a tenant-facing response. No cpu/memory ever. */
export function clientPm2Status({ serviceId, raw, telemetryAvailable, telemetryStale = false, lastUpdatedAt = null }) {
  return {
    serviceId,
    status: raw?.status ?? (telemetryAvailable ? 'unknown' : 'unavailable'),
    uptime: typeof raw?.uptime === 'number' ? raw.uptime : null,
    restarts: typeof raw?.restarts === 'number' ? raw.restarts : null,
    lastUpdatedAt,
    telemetryAvailable: Boolean(telemetryAvailable),
    telemetryStale: Boolean(telemetryStale),
  };
}

/** Full resource metrics for Super Admin. Never substitutes zero for missing. */
export function adminPm2Metrics({ serviceId, agentId, processName, raw, collectedAt, available, reason }) {
  const memoryBytes = typeof raw?.memory === 'number' && Number.isFinite(raw.memory) ? raw.memory : null;
  return {
    serviceId,
    agentId,
    processName,
    status: raw?.status ?? null,
    cpuPercent: typeof raw?.cpu === 'number' && Number.isFinite(raw.cpu) ? raw.cpu : null,
    memoryBytes,
    memoryMb: memoryBytes === null ? null : Math.round((memoryBytes / 1024 / 1024) * 100) / 100,
    restarts: typeof raw?.restarts === 'number' && Number.isFinite(raw.restarts) ? raw.restarts : null,
    uptime: typeof raw?.uptime === 'number' && Number.isFinite(raw.uptime) ? raw.uptime : null,
    collectedAt: collectedAt ?? null,
    available: Boolean(available),
    reason: available ? null : (reason || 'Metrics unavailable'),
  };
}

/**
 * Match raw `pm2 jlist` entries to registered services by process name.
 * Unregistered processes are dropped — a client must never be able to
 * enumerate arbitrary processes on the VPS.
 */
export function matchProcessesToServices(processList, services) {
  const byName = new Map();
  for (const service of services) {
    if (service.pm2ProcessName) byName.set(service.pm2ProcessName, service);
  }
  const matched = [];
  for (const entry of processList || []) {
    const service = byName.get(entry?.name);
    if (!service) continue;
    matched.push({
      serviceId: service.id,
      serviceName: service.name,
      processName: entry.name,
      status: entry.status ?? entry.pm2_env?.status ?? null,
      cpuPercent: typeof entry.cpu === 'number' ? entry.cpu : null,
      memoryBytes: typeof entry.memory === 'number' ? entry.memory : null,
      restarts: typeof entry.restarts === 'number' ? entry.restarts : null,
      uptime: typeof entry.uptime === 'number' ? entry.uptime : null,
    });
  }
  return matched;
}

/** Tenant-safe batch: operational status only, keyed by service id. */
export function clientPm2Batch(matched) {
  const byService = {};
  for (const item of matched || []) {
    byService[item.serviceId] = {
      serviceId: item.serviceId,
      status: item.status ?? 'unknown',
      uptime: item.uptime ?? null,
      restarts: item.restarts ?? null,
      telemetryAvailable: true,
    };
  }
  return byService;
}
