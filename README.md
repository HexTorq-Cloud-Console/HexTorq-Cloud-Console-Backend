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

Super admins can create any number of FileZilla/SFTP and PostgreSQL access entries per client. Passwords are encrypted with `AGENT_ENCRYPTION_KEY`; clients see only their own enabled entries through `GET /api/access`. See `docs/client-access-credentials.md` for the API and deployment notes.

Clients can enable automatic webhook health checks from the console. At the configured interval and 03:00 in `WEBHOOK_SCHEDULE_TIMEZONE`, the backend calls each enabled service webhook, waits for that pipeline deployment to finish, then calls the next one. Each webhook and deployment result is recorded live for the client. See `docs/webhook-health-schedule.md`.
