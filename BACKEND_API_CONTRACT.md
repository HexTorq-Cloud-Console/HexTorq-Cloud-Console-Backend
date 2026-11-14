# HexTorq Cloud Console — Backend API Contract

This document is the handoff contract for the separate frontend implementation.
It lists every endpoint, the required role, tenant-scope rules, request/response
shape, error cases, and — critically — whether an endpoint may return
infrastructure resource metrics (CPU/RAM). **Resource metrics are Super-Admin only.**

## Conventions

- Base path: `/api`.
- Auth: `Authorization: Bearer <JWT>` for users; `X-Agent-Id` + `X-Agent-Key` for agents.
- Roles: `SUPER_ADMIN`, `CLIENT`. A CLIENT is bound to a single `clientId`.
- Tenant rule: any resource owned by another tenant responds **404** (existence is
  not disclosed). Privileged endpoints respond **403**.
- `agentStatus` is one of `online | offline | disabled | unknown`, derived from the
  heartbeat timestamp versus `AGENT_STALE_THRESHOLD_MS`. `enabled` never means online.
- Never trust a process name, clientId, serviceId or role from the request body —
  ownership always comes from the JWT + database.

### Forbidden-in-CLIENT-response fields

A CLIENT response must never contain, at any nesting depth:
`cpu`, `cpuPercent`, `memory`, `memoryBytes`, `memoryMb`, `rss`, `memoryRss`,
`apiKeyEncrypted`, `apiKeyHash`, `enrollmentToken`, `baseUrl` (agent), `passwordHash`,
`googleSubject`, `webhookSecretHash`, decrypted credentials, or another tenant's data.

---

## Authentication

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | public | returns `{ token, user }` |
| POST | `/api/auth/google` | public | Google Identity Services |
| GET | `/api/auth/me` | any | current user |
| POST | `/api/auth/change-password` | CLIENT | min 8 chars |

## Services

| Method | Path | Role | Resource metrics? | Notes |
|---|---|---|---|---|
| GET | `/api/services` | any (scoped) | no | CLIENT sees own tenant only; agent `baseUrl` and all secrets stripped |
| GET | `/api/services/pm2/statuses` | any (scoped) | no | batch operational status, grouped per agent; no CPU/RAM; no process enumeration |
| GET | `/api/services/health` | any (scoped) | no | aggregate: agent counts, PM2 runtime counts, static counts. Distinguishes the three health concepts |
| GET | `/api/services/:serviceId` | any (scoped) | no | 404 cross-tenant |
| GET | `/api/services/:serviceId/pm2/status` | any (scoped) | **CLIENT: no / SUPER_ADMIN: yes** | see below |
| GET | `/api/services/:serviceId/pm2/logs/stream` | any (scoped) | no | SSE; own enabled PM2 service only; secrets redacted per line |
| POST | `/api/services/:serviceId/pm2/:action` | any (scoped) | no | `start|stop|restart` for CLIENT (when enabled), `reload` SUPER_ADMIN only |
| POST | `/api/services/:serviceId/deploy` | any (scoped) | no | triggers the pipeline |

### `GET /api/services/:serviceId/pm2/status`

Role-aware. The same URL returns different DTOs:

**CLIENT** (no resource metrics, ever):
```json
{
  "serviceId": "…",
  "status": "online",
  "uptime": 1784000000000,
  "restarts": 2,
  "lastUpdatedAt": "2026-01-01T00:00:00.000Z",
  "telemetryAvailable": true,
  "telemetryStale": false
}
```

**SUPER_ADMIN** (adds resource metrics for the console UI):
```json
{ "serviceId": "…", "status": "online", "uptime": 1784000000000, "restarts": 2,
  "cpu": 12.5, "memory": 450000000, "lastUpdatedAt": "…",
  "telemetryAvailable": true, "telemetryStale": false }
```

### PM2 control — `POST /api/services/:serviceId/pm2/:action`

Order of checks: authenticate → role → load service (DB) → tenant ownership →
service.enabled → agent.enabled → agent online → service is PM2 → process name from DB →
`clientControlEnabled` (CLIENT) → action allowed for role → forward permitted action.
The agent re-validates the process against its allowlist. `shell: true` is never used.

- CLIENT: `start`, `stop`, `restart` only (and only when `clientControlEnabled`).
- SUPER_ADMIN: `start`, `stop`, `restart`, `reload`.
- Agent offline → `409`. Static service → `404`. Client control disabled → `403`.
- Success/failure is written to the audit log (actor, role, tenant, service, agent,
  process, action, result, redacted failure reason).

## Super-Admin resource monitoring

| Method | Path | Role | Resource metrics? |
|---|---|---|---|
| GET | `/api/admin/services/:serviceId/pm2/metrics` | SUPER_ADMIN | **yes** |
| GET | `/api/admin/agents/:agentId/pm2/statuses` | SUPER_ADMIN | **yes** (batch) |
| GET | `/api/admin/agents/:agentId/pm2/processes` | SUPER_ADMIN | yes |

`GET /api/admin/services/:serviceId/pm2/metrics`:
```json
{
  "serviceId": "…", "agentId": "…", "processName": "api",
  "status": "online", "cpuPercent": 12.5, "memoryBytes": 450000000, "memoryMb": 429.15,
  "restarts": 2, "uptime": 1784000000000, "collectedAt": "…",
  "available": true, "reason": null
}
```
When metrics are unavailable (agent offline/disabled, process stopped, upstream error),
`available` is `false` and metric fields are `null` (never `0`), with a `reason`.

## Deployments

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/api/deployments` | any (scoped) | cursor pagination + filters: `serviceId,status,from,to,triggerSource,branch,commitHash,limit,cursor` |
| GET | `/api/deployments/active` | any (scoped) | only `DEPLOYING`; `{ count, deployments[] }` |
| GET | `/api/deployments/:deploymentId/logs` | any (scoped) | 404 cross-tenant; secrets redacted; `limit` capped |

Ownership is always `deployment.service.clientId === user.clientId`.

## Analytics

`GET /api/analytics?days=1..90` — SUPER_ADMIN global; CLIENT tenant-scoped.
Database-backed, timezone-consistent (`REPORTING_TIMEZONE`). Backward-compatible keys:
`window`, `summary{total,successful,failed,running,successRate}`, `daily[]`, `services{}`.
Extended sections: `previousWindow`, `generatedAt`, `timezone`, `comparison`, `hourly`,
`previousHourly`, `previousDaily`, `completedOutcomes`, `activeDeployments`,
`performance` (median duration + slowest), `runtime` (availability state),
`agents`, `serviceHotspots`, `triggerBreakdown`.

Definitions: **activity** = started in window (by `startedAt`); **completed outcomes** =
completed in window (by `completedAt`); success rate denominator excludes active runs.
No CPU/RAM is ever included.

## Webhook health

| Method | Path | Role |
|---|---|---|
| GET | `/api/webhook-health` | CLIENT (own) / SUPER_ADMIN (`?clientId=`) |
| PATCH | `/api/webhook-health/schedule` | CLIENT (own) / SUPER_ADMIN |
| POST | `/api/webhook-health/run` | CLIENT (own) / SUPER_ADMIN |

## Client access credentials

| Method | Path | Role |
|---|---|---|
| GET | `/api/access` | CLIENT (own, metadata only) |
| GET | `/api/access/:accessId/reveal` | CLIENT (own, rate-limited, audited) |
| GET | `/api/admin/access` | SUPER_ADMIN |
| POST/PATCH/DELETE | `/api/admin/access[/:accessId]` | SUPER_ADMIN |
| GET | `/api/admin/access/:accessId/reveal` | SUPER_ADMIN (rate-limited, audited) |

## Admin (SUPER_ADMIN only)

`/api/admin/clients` (GET/POST), `/api/admin/agents` (GET/POST),
`/api/admin/agents/:agentId/enrollment-token`, `/api/admin/services`
(POST/PATCH/DELETE), `/api/admin/settings` (GET/PATCH retention),
`/api/admin/audit-logs` (GET, paginated), `/api/admin/repository-metadata`.

`PATCH /api/admin/services/:serviceId` accepts `clientControlEnabled` (boolean).

## Agent-facing (not for browsers)

| Method | Path | Auth |
|---|---|---|
| POST | `/api/agents/enroll` | enrollment token |
| POST | `/api/agents/:agentId/heartbeat` | `X-Agent-Id`/`X-Agent-Key` |
| POST | `/api/agents/:agentId/events` | `X-Agent-Id`/`X-Agent-Key` |

Deployment events (`deployment-log`, `deployment-completed`) are validated against
ownership: the deployment must belong to the matched service **and** the authenticating
agent (else `409`). Completion is idempotent. Log messages are capped at 20,000 chars
(else `413`) and redacted before storage.

## Pipeline agent control contract (backend → agent)

All require `X-Console-Agent-Id` + `X-Console-Agent-Key`.

`POST /control/pm2/:processName/:action`, `GET /pm2/status/:target`,
`GET /pm2/statuses` (batch), `GET /pm2/processes`,
`GET /pm2/logs/:target/stream`, `POST /webhook/:project`,
`POST /projects/register`, `POST /console/events`, `GET /health`.

## Error responses

`400` invalid input · `401` unauthenticated · `403` privileged/disabled ·
`404` not found or cross-tenant · `409` conflict (agent offline, duplicate) ·
`413` oversized payload · `429` rate limited · `502` upstream/agent failure ·
`500` internal (never leaks stack traces or credentials).

---

## In-app notifications (persistent history + browser push)

The authoritative history is the Notification table (PostgreSQL). Browser push
(PushSubscription) is one of three delivery surfaces for the **same** row: the bell
dropdown + live toast and the Alerts history page read the persisted row. **No email/SMTP.**

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | /api/notifications/config | CLIENT / SUPER_ADMIN | {enabled,mode:'in_app',browserPushEnabled,emailEnabled:false,vapidPublicKey,scopeKey,preferences,devices,deviceCount} |
| GET | /api/notifications | any (scoped) | ?filter=all\|unread\|read&limit<=100&cursor= ? {notifications,total,unreadCount,hasMore,nextCursor} newest-first |
| GET | /api/notifications/unread-count | any (scoped) | {unreadCount} |
| PATCH | /api/notifications/:id/read | any (scoped) | cross-scope id ? 404 |
| POST | /api/notifications/read-all | any (scoped) | {updated,unreadCount} |
| PATCH | /api/notifications/preferences | any (scoped) | {pushEnabled,notifyStarted,notifyCompleted,notifyFailed} |
| POST | /api/notifications/subscribe | any (scoped) | register a browser device; 409 when VAPID unconfigured |
| DELETE | /api/notifications/subscribe | any (scoped) | remove one device |
| DELETE | /api/notifications/devices | any (scoped) | remove all devices for the scope |
| POST | /api/notifications/test | any (scoped) | creates a real history row + pushes to own devices |
| GET | /api/admin/notifications | SUPER_ADMIN | per-client push device counts + notify flags |

Ownership scope is derived **only** from the verified JWT (client:<clientId> /
dmin:<email>). No scopeKey/clientId is accepted from the body. Notification bodies
are redacted; no CPU/RAM is ever included. Deployment events (started/completed/ailed)
create one notification per recipient scope, deduplicated by dedupeKey, in the background
so a push failure never affects the deployment.

GET /api/admin/audit-logs now also returns 	argetType/	argetId aliases (alongside the
existing esourceType/esourceId).
