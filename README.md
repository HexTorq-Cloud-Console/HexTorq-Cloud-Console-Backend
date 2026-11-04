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

`GET /api/deployments` is cursor-paginated (`limit`, `cursor`) with stable ordering and returns `hasMore`/`nextCursor`. `GET /api/analytics?days=7` returns role-scoped, database-backed seven-day deployment counts, daily distribution, success rate, and service counts. `GET /api/admin/audit-logs` returns a paginated audit trail for super admins.
