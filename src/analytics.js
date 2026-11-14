// Database-backed deployment analytics.
//
// Bucketing happens in PostgreSQL (parameterized) so large tenants never load
// every deployment row into Node just to group them. A single reporting
// timezone keeps hourly and daily boundaries consistent with the previous
// comparison window.

const DEFAULT_TIME_ZONE = 'UTC';

export function resolveTimeZone(value, fallback = DEFAULT_TIME_ZONE) {
  const candidate = (value || fallback || DEFAULT_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Median of a list of finite numbers, or null when the sample is empty. */
export function median(values) {
  const numbers = (values || []).filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value);
}

/** Percentage change between two periods, or null when it is not defined. */
export function percentChange(current, previous) {
  if (typeof current !== 'number' || typeof previous !== 'number' || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export function successRateFor(successful, failed) {
  const completed = (successful || 0) + (failed || 0);
  if (completed === 0) return null;
  return Math.round((successful / completed) * 1000) / 10;
}

/** UTC instant of local midnight for a given reporting timezone. */
export function zonedDayStart(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const offset = tzOffsetMs(date, timeZone);
  return new Date(asUTC - offset);
}

function tzOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, Number(parts.minute), Number(parts.second));
  return asUTC - date.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Activity series by start time, or outcome series by completion time.
async function activitySeries(prisma, { unit, dateColumn, from, to, tz, clientId, days }) {
  // The CASE keeps the column choice parameterized (no identifier interpolation).
  if (unit === 'hour') {
    return prisma.$queryRaw`
      WITH series AS (
        SELECT generate_series(
          date_trunc('hour', (${from}::timestamptz AT TIME ZONE ${tz})),
          date_trunc('hour', (${to}::timestamptz AT TIME ZONE ${tz})),
          interval '1 hour'
        ) AS bucket
      ),
      agg AS (
        SELECT date_trunc('hour', ((CASE WHEN ${dateColumn} = 'startedAt' THEN d."startedAt" ELSE d."completedAt" END) AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
          count(*)::int AS total,
          count(*) FILTER (WHERE d.status = 'SUCCESS')::int AS successful,
          count(*) FILTER (WHERE d.status IN ('FAILED','ERROR'))::int AS failed,
          count(*) FILTER (WHERE d.status = 'DEPLOYING')::int AS active
        FROM "Deployment" d
        JOIN "Service" s ON s.id = d."serviceId"
        WHERE (CASE WHEN ${dateColumn} = 'startedAt' THEN d."startedAt" ELSE d."completedAt" END) >= (${from}::timestamptz AT TIME ZONE 'UTC')
          AND (CASE WHEN ${dateColumn} = 'startedAt' THEN d."startedAt" ELSE d."completedAt" END) < (${to}::timestamptz AT TIME ZONE 'UTC')
          AND (${clientId}::text IS NULL OR s."clientId" = ${clientId})
        GROUP BY 1
      )
      SELECT to_char(series.bucket, 'YYYY-MM-DD"T"HH24:00') AS bucket,
        COALESCE(agg.total,0)::int AS total,
        COALESCE(agg.successful,0)::int AS successful,
        COALESCE(agg.failed,0)::int AS failed,
        COALESCE(agg.active,0)::int AS active
      FROM series LEFT JOIN agg ON agg.bucket = series.bucket
      ORDER BY series.bucket
    `;
  }

  return prisma.$queryRaw`
    WITH params AS (
      SELECT date_trunc('day', (${to}::timestamptz AT TIME ZONE ${tz})) AS today_local
    ),
    series AS (
      SELECT generate_series(
        (SELECT today_local FROM params) - make_interval(days => ${days}::int - 1),
        (SELECT today_local FROM params),
        interval '1 day'
      ) AS bucket
    ),
    agg AS (
      SELECT date_trunc('day', ((CASE WHEN ${dateColumn} = 'startedAt' THEN d."startedAt" ELSE d."completedAt" END) AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
        count(*)::int AS total,
        count(*) FILTER (WHERE d.status = 'SUCCESS')::int AS successful,
        count(*) FILTER (WHERE d.status IN ('FAILED','ERROR'))::int AS failed,
        count(*) FILTER (WHERE d.status = 'DEPLOYING')::int AS active
      FROM "Deployment" d
      JOIN "Service" s ON s.id = d."serviceId"
      WHERE (CASE WHEN ${dateColumn} = 'startedAt' THEN d."startedAt" ELSE d."completedAt" END) >= ((SELECT today_local FROM params) - make_interval(days => ${days}::int - 1)) AT TIME ZONE ${tz}
        AND (CASE WHEN ${dateColumn} = 'startedAt' THEN d."startedAt" ELSE d."completedAt" END) < ((SELECT today_local FROM params) + interval '1 day') AT TIME ZONE ${tz}
        AND (${clientId}::text IS NULL OR s."clientId" = ${clientId})
      GROUP BY 1
    )
    SELECT to_char(series.bucket, 'YYYY-MM-DD') AS bucket,
      COALESCE(agg.total,0)::int AS total,
      COALESCE(agg.successful,0)::int AS successful,
      COALESCE(agg.failed,0)::int AS failed,
      COALESCE(agg.active,0)::int AS active
    FROM series LEFT JOIN agg ON agg.bucket = series.bucket
    ORDER BY series.bucket
  `;
}

function sumSeries(rows) {
  return rows.reduce((acc, row) => {
    acc.total += row.total;
    acc.successful += row.successful;
    acc.failed += row.failed;
    acc.active += row.active;
    return acc;
  }, { total: 0, successful: 0, failed: 0, active: 0 });
}

function toDaily(rows) {
  return rows.map((row) => ({
    date: row.bucket,
    total: row.total,
    successful: row.successful,
    failed: row.failed,
    running: row.active,
  }));
}

function toHourly(rows) {
  return rows.map((row) => ({
    hour: row.bucket,
    total: row.total,
    successful: row.successful,
    failed: row.failed,
    active: row.active,
  }));
}

async function medianDuration(prisma, { from, to, clientId }) {
  const rows = await prisma.$queryRaw`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY d."durationMs") AS median,
      count(*)::int AS completed
    FROM "Deployment" d
    JOIN "Service" s ON s.id = d."serviceId"
    WHERE d."completedAt" >= (${from}::timestamptz AT TIME ZONE 'UTC')
      AND d."completedAt" < (${to}::timestamptz AT TIME ZONE 'UTC')
      AND d."durationMs" IS NOT NULL
      AND d.status IN ('SUCCESS','FAILED','ERROR')
      AND (${clientId}::text IS NULL OR s."clientId" = ${clientId})
  `;
  const row = rows[0] || { median: null, completed: 0 };
  return {
    medianDurationMs: row.median === null || row.median === undefined ? null : Math.round(Number(row.median)),
    completedDeployments: Number(row.completed) || 0,
  };
}

async function serviceHotspots(prisma, { from, to, clientId }) {
  const rows = await prisma.$queryRaw`
    SELECT s.id AS "serviceId", s.name AS name,
      count(*)::int AS "completedDeployments",
      count(*) FILTER (WHERE d.status IN ('FAILED','ERROR'))::int AS "failedDeployments",
      max(d."completedAt") FILTER (WHERE d.status IN ('FAILED','ERROR')) AS "lastFailureAt",
      max(d."completedAt") FILTER (WHERE d.status = 'SUCCESS') AS "lastSuccessAt",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY d."durationMs") AS "medianDurationMs"
    FROM "Deployment" d
    JOIN "Service" s ON s.id = d."serviceId"
    WHERE d."completedAt" >= (${from}::timestamptz AT TIME ZONE 'UTC')
      AND d."completedAt" < (${to}::timestamptz AT TIME ZONE 'UTC')
      AND d.status IN ('SUCCESS','FAILED','ERROR')
      AND (${clientId}::text IS NULL OR s."clientId" = ${clientId})
    GROUP BY s.id, s.name
    ORDER BY "failedDeployments" DESC, "completedDeployments" DESC
    LIMIT 25
  `;
  return rows.map((row) => {
    const completed = Number(row.completedDeployments) || 0;
    const failed = Number(row.failedDeployments) || 0;
    return {
      serviceId: row.serviceId,
      name: row.name,
      completedDeployments: completed,
      failedDeployments: failed,
      failureRate: completed ? Math.round((failed / completed) * 1000) / 10 : null,
      sampleSufficient: completed >= 5,
      lastFailureAt: row.lastFailureAt ?? null,
      lastSuccessAt: row.lastSuccessAt ?? null,
      medianDurationMs: row.medianDurationMs === null || row.medianDurationMs === undefined ? null : Math.round(Number(row.medianDurationMs)),
    };
  });
}

async function triggerBreakdown(prisma, { from, to, clientId }) {
  const rows = await prisma.$queryRaw`
    SELECT d."triggerSource" AS "triggerSource",
      count(*)::int AS total,
      count(*) FILTER (WHERE d.status = 'SUCCESS')::int AS successful,
      count(*) FILTER (WHERE d.status IN ('FAILED','ERROR'))::int AS failed,
      count(*) FILTER (WHERE d.status = 'DEPLOYING')::int AS active
    FROM "Deployment" d
    JOIN "Service" s ON s.id = d."serviceId"
    WHERE d."startedAt" >= (${from}::timestamptz AT TIME ZONE 'UTC')
      AND d."startedAt" < (${to}::timestamptz AT TIME ZONE 'UTC')
      AND (${clientId}::text IS NULL OR s."clientId" = ${clientId})
    GROUP BY 1
    ORDER BY total DESC
  `;
  return rows.map((row) => ({
    triggerSource: row.triggerSource || 'unknown',
    total: row.total,
    successful: row.successful,
    failed: row.failed,
    active: row.active,
  }));
}

async function activeDeployments(prisma, { clientId }) {
  const rows = await prisma.$queryRaw`
    SELECT d.id, d."runId", d.status, d."startedAt",
      s.id AS "serviceId", s.name AS "serviceName",
      (EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - d."startedAt")) * 1000)::bigint AS "elapsedMs"
    FROM "Deployment" d
    JOIN "Service" s ON s.id = d."serviceId"
    WHERE d.status = 'DEPLOYING'
      AND (${clientId}::text IS NULL OR s."clientId" = ${clientId})
    ORDER BY d."startedAt" ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    status: row.status,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    startedAt: row.startedAt,
    elapsedMs: Number(row.elapsedMs) || 0,
  }));
}

/**
 * Build the full analytics payload.
 * - SUPER_ADMIN: platform-wide (clientId = null).
 * - CLIENT: restricted to its own tenant.
 */
export async function buildAnalytics({ prisma, clientId, days, timeZone, agentStatus }) {
  const tz = resolveTimeZone(timeZone);
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 90);
  const now = new Date();
  const dayStart = zonedDayStart(now, tz);
  const windowFrom = new Date(dayStart.getTime() - (safeDays - 1) * DAY_MS);
  const previousFrom = new Date(windowFrom.getTime() - safeDays * DAY_MS);

  const hourTo = new Date(Math.floor(now.getTime() / (60 * 60 * 1000)) * 60 * 60 * 1000);
  const hourFrom = new Date(hourTo.getTime() - 24 * 60 * 60 * 1000);

  const [
    daily, previousDaily,
    hourlyRaw, previousHourlyRaw,
    completedDaily,
    active,
    currentMedian, previousMedian,
    hotspots,
    triggers,
    services,
    agents,
  ] = await Promise.all([
    activitySeries(prisma, { unit: 'day', dateColumn: 'startedAt', from: windowFrom, to: now, tz, clientId, days: safeDays }),
    activitySeries(prisma, { unit: 'day', dateColumn: 'startedAt', from: previousFrom, to: windowFrom, tz, clientId, days: safeDays }),
    activitySeries(prisma, { unit: 'hour', dateColumn: 'startedAt', from: hourFrom, to: hourTo, tz, clientId }),
    activitySeries(prisma, { unit: 'hour', dateColumn: 'startedAt', from: new Date(hourFrom.getTime() - 24 * 60 * 60 * 1000), to: hourFrom, tz, clientId }),
    activitySeries(prisma, { unit: 'day', dateColumn: 'completedAt', from: windowFrom, to: now, tz, clientId, days: safeDays }),
    activeDeployments(prisma, { clientId }),
    medianDuration(prisma, { from: windowFrom, to: now, clientId }),
    medianDuration(prisma, { from: previousFrom, to: windowFrom, clientId }),
    serviceHotspots(prisma, { from: windowFrom, to: now, clientId }),
    triggerBreakdown(prisma, { from: windowFrom, to: now, clientId }),
    prisma.service.findMany({
      where: clientId ? { clientId } : {},
      select: { type: true, enabled: true },
    }),
    // Agents are tenant-scoped for a CLIENT: only agents hosting its services.
    prisma.serverAgent.findMany({
      where: clientId ? { services: { some: { clientId } } } : {},
      select: { enabled: true, lastSeenAt: true },
    }),
  ]);

  const currentTotals = sumSeries(daily);
  const previousTotals = sumSeries(previousDaily);
  const completedTotals = sumSeries(completedDaily);

  const agentCounts = { total: agents.length, online: 0, offline: 0, disabled: 0, unknown: 0 };
  for (const agent of agents) {
    const status = agentStatus ? agentStatus(agent) : (agent.enabled ? (agent.lastSeenAt ? 'offline' : 'unknown') : 'disabled');
    agentCounts[status] = (agentCounts[status] || 0) + 1;
  }

  const currentSuccessRate = successRateFor(currentTotals.successful, currentTotals.failed);
  const previousSuccessRate = successRateFor(previousTotals.successful, previousTotals.failed);

  return {
    window: { from: windowFrom.toISOString(), to: now.toISOString(), days: safeDays, timezone: tz },
    previousWindow: { from: previousFrom.toISOString(), to: windowFrom.toISOString(), days: safeDays, timezone: tz },
    generatedAt: now.toISOString(),
    timezone: tz,

    summary: {
      total: currentTotals.total,
      successful: currentTotals.successful,
      failed: currentTotals.failed,
      running: currentTotals.active,
      successRate: currentSuccessRate,
    },
    comparison: {
      totalChange: percentChange(currentTotals.total, previousTotals.total),
      successRateChangePts: currentSuccessRate === null || previousSuccessRate === null
        ? null
        : Math.round((currentSuccessRate - previousSuccessRate) * 10) / 10,
      completedChange: percentChange(completedTotals.total, sumSeries(previousDaily).total),
      previous: {
        total: previousTotals.total,
        successful: previousTotals.successful,
        failed: previousTotals.failed,
        active: previousTotals.active,
        successRate: previousSuccessRate,
      },
    },

    daily: toDaily(daily),
    previousDaily: toDaily(previousDaily),
    hourly: toHourly(hourlyRaw).slice(-24),
    previousHourly: toHourly(previousHourlyRaw).slice(-24),
    completedOutcomes: {
      total: completedTotals.total,
      successful: completedTotals.successful,
      failed: completedTotals.failed,
      successRate: successRateFor(completedTotals.successful, completedTotals.failed),
      daily: toDaily(completedDaily),
    },

    activeDeployments: { count: active.length, items: active },

    performance: {
      current: currentMedian,
      previous: previousMedian,
      slowest: hotspots
        .filter((spot) => spot.medianDurationMs !== null)
        .sort((a, b) => (b.medianDurationMs || 0) - (a.medianDurationMs || 0))
        .slice(0, 5)
        .map((spot) => ({ serviceId: spot.serviceId, name: spot.name, medianDurationMs: spot.medianDurationMs })),
    },

    services: {
      total: services.length,
      enabled: services.filter((service) => service.enabled).length,
      disabled: services.filter((service) => !service.enabled).length,
      pm2: services.filter((service) => service.type === 'PM2').length,
      static: services.filter((service) => service.type === 'STATIC_FRONTEND').length,
    },

    // Live PM2 runtime is collected per service / per agent; the aggregate is
    // served by /api/services/health. Reported here as an explicit availability
    // state rather than a fabricated zero.
    runtime: {
      available: false,
      reason: 'PM2 runtime metrics are collected live via /api/services/health',
      monitoredServices: services.filter((service) => service.type === 'PM2' && service.enabled).length,
    },

    agents: agentCounts,
    serviceHotspots: hotspots,
    triggerBreakdown: triggers,
  };
}
