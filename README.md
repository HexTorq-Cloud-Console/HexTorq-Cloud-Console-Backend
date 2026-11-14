# HexTorq Cloud Console Backend

Central control-plane API for HexTorq Cloud Console. Pipeline agents run separately on managed VPS servers.

## Local setup

```bash
cp .env.example .env
npm install
npm run db:generate
npm run db:deploy
npm run dev
```

The sole super-admin account is read from `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`. It is deliberately not stored in PostgreSQL.

`AGENT_ENCRYPTION_KEY` must be a randomly generated 32-byte key represented as 64 hexadecimal characters. It encrypts enrolled agent control keys and client SFTP/PostgreSQL passwords at rest.

The Google Identity Services client ID is optional. When configured, only clients whose email already exists in the console can use Google sign-in.

Deployment log rows are removed after `LOG_RETENTION_DAYS` (30 days by default); deployment metadata remains available.

Pipeline agents must implement the contract in `docs/agent-control-contract.md` and report deployment events to `/api/agents/:agentId/events`.

Super admins can create any number of FileZilla/SFTP and PostgreSQL access entries per client. Passwords are encrypted with `AGENT_ENCRYPTION_KEY`. Normal list responses (`GET /api/access` and `GET /api/admin/access`) return credential metadata only and never include decrypted passwords. The secret is returned only by the authenticated reveal endpoints `GET /api/access/:accessId/reveal` (client, own enabled entries) and `GET /api/admin/access/:accessId/reveal` (super admin). Reveals are rate limited and written to the audit log without the secret value.

Clients can enable automatic webhook health checks from the console. At the configured interval and 03:00 in `WEBHOOK_SCHEDULE_TIMEZONE`, the backend calls each enabled service webhook, waits for that pipeline deployment to finish, then calls the next one. Each webhook and deployment result is recorded live for the client. See `docs/webhook-health-schedule.md`.

An agent is reported online only when its last heartbeat is newer than `AGENT_STALE_THRESHOLD_MS` (2 minutes by default); otherwise it is offline (stale heartbeat), unknown (no heartbeat yet), or disabled when the administrator disabled it. `agent.enabled` is never treated as connectivity.

`GET /api/deployments` is cursor-paginated (`limit`, `cursor`) with stable ordering and returns `hasMore`/`nextCursor`. It supports `serviceId`, `status`, `from`, `to`, `triggerSource`, `branch` and `commitHash` filters (all tenant-scoped). `GET /api/deployments/active` returns only currently-deploying runs.

## Role model and resource-metric privacy

- **CLIENT** receives only its own tenant's services, deployments, logs, sanitized PM2
  runtime logs and heartbeat-derived agent status. It never receives CPU, RAM, restart
  internals beyond its own operational DTO, other tenants' data, agent `baseUrl`/keys,
  `passwordHash`, `webhookSecretHash`, or any admin API.
- **SUPER_ADMIN** gets platform-wide visibility and the only resource-metric endpoints:
  `GET /api/admin/services/:serviceId/pm2/metrics` and
  `GET /api/admin/agents/:agentId/pm2/statuses`.
- `GET /api/services/:serviceId/pm2/status` is role-aware: CLIENT gets an operational DTO
  with no CPU/RAM; SUPER_ADMIN keeps the resource fields.
- Cross-tenant access returns `404`; privileged access returns `403`.

## PM2 process control

`POST /api/services/:serviceId/pm2/:action` requires auth, resolves ownership from the JWT
and database, verifies the service is enabled, the agent is enabled and online, and the
service is a PM2 process. CLIENT may `start|stop|restart` its own services when
`clientControlEnabled` is true; `reload` is SUPER_ADMIN-only. Process names always come
from the database; the agent re-validates against its allowlist. Actions are audited.

## Service health, analytics and redaction

- `GET /api/services/health` returns an aggregate that keeps agent connectivity, PM2 runtime
  health and (separately) static frontend configuration distinct.
- `GET /api/analytics?days=1..90` is database-backed and timezone-consistent
  (`REPORTING_TIMEZONE`), returning a current + previous window, hourly/daily buckets,
  median deployment duration, failure hotspots, trigger breakdown and active deployments.
- A shared redaction utility removes secrets from stored deployment logs, log responses and
  the PM2 SSE stream (line-buffered, so a secret split across chunks is still removed).

Apply the additive migration with `npm run db:deploy`. See `BACKEND_API_CONTRACT.md` for the
full contract and `BACKEND_IMPLEMENTATION_REPORT.md` for the change summary and test results.

Run `npm test` for unit tests (includes a real-PostgreSQL analytics SQL test) and
`npm run test:integration` for the end-to-end HTTP harness.
