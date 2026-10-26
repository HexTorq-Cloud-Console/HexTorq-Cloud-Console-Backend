# Webhook health checks and schedules

A client can schedule recurring webhook health checks for all of its enabled
services. A check calls the first service webhook, waits for that pipeline
deployment to finish, then calls the next service webhook, and stores each
webhook and deployment outcome for the client console.

## Schedule behavior

- The schedule is stored per client, not per service.
- Enabling the schedule runs the first check at the next `03:00` in
  `WEBHOOK_SCHEDULE_TIMEZONE` (default `Asia/Kolkata`).
- After a scheduled run, the next run is calculated by adding the configured
  interval in calendar days at the same local `03:00`.
- Supported intervals are 1-365 days. The console exposes 1, 3, 7, 14, 30, and
  90 day options.
- The backend checks for due schedules every 60 seconds. If the process was down,
  an overdue schedule starts when the process is available and the next run is
  advanced to a future interval boundary.
- A client cannot have two health-check runs active at the same time. A due
  scheduled run is skipped and advanced if a manual or previous run is still
  active.
- Interrupted `RUNNING` runs are reconciled on startup; unfinished checks are
  marked failed so they cannot block future checks.

## API

All routes require a bearer token. A client is always restricted to its own
records. A super admin must pass `clientId` for the selected client
(`?clientId=...` on `GET`, or `clientId` in the request body).

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/webhook-health` | Schedule, latest run with checks, active run, and five recent runs. |
| `PATCH` | `/api/webhook-health/schedule` | Enable/disable automatic checks and set the interval. |
| `POST` | `/api/webhook-health/run` | Manually run all enabled service webhooks now. |

Schedule payload:

```json
{
  "enabled": true,
  "intervalDays": 7
}
```

The schedule response includes the server time zone and schedule hour so the
client can render the next run accurately:

```json
{
  "schedule": {
    "clientId": "client-id",
    "enabled": true,
    "intervalDays": 7,
    "nextRunAt": "2026-11-02T21:30:00.000Z",
    "lastRunAt": "2026-10-26T21:30:00.000Z",
    "timeZone": "Asia/Kolkata",
    "hour": 3
  }
}
```

Each check reports:

- `status`: `QUEUED`, `RUNNING`, `SUCCESS`, or `FAILED`.
- `httpStatus`: the pipeline agent/webhook response, such as `202` or `400`.
- `message`: the last webhook or deployment message.
- `deployment`: the correlated deployment status, run ID, and failure reason,
  when the pipeline has emitted deployment events.

A health check is only `SUCCESS` when the pipeline reports
`deployment-completed` with status `SUCCESS`. A webhook accepted with HTTP 202 but
no deployment completion is marked failed after the per-service timeout,
`WEBHOOK_HEALTH_DEPLOY_TIMEOUT_MS` (20 minutes by default). The next service is
then started. Set `WEBHOOK_HEALTH_POLL_MS` to tune result polling.

## Run correlation

The console generates a unique `runId` for every deploy request and includes it
in the agent webhook payload. The agent forwards the payload unchanged. The
pipeline must preserve that `runId` in `deployment-started` and
`deployment-completed` events so the console can update the correct health check.

Deployment event relay is configured with `CONSOLE_AGENT_URL`,
`CONSOLE_AGENT_ID`, and `CONSOLE_AGENT_KEY` in the pipeline environment.

## Environment

```text
WEBHOOK_SCHEDULE_TIMEZONE=Asia/Kolkata
WEBHOOK_SCHEDULE_HOUR=3
WEBHOOK_SCHEDULER_EMAIL=scheduler@hextorq.local
WEBHOOK_HEALTH_DEPLOY_TIMEOUT_MS=1200000
WEBHOOK_HEALTH_POLL_MS=3000
```

`WEBHOOK_SCHEDULER_EMAIL` must be a valid email address when deployment events
are relayed because the pipeline validates `requestedBy`.

## Database migration

Apply the migration during deployment:

```sh
npx prisma migrate deploy
npx prisma generate
```

The migration is `prisma/migrations/0003_webhook_health_schedules`.
