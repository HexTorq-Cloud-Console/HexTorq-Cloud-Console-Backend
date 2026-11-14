# Pipeline agent control contract

The console calls these routes on an enrolled pipeline agent. The agent must validate both headers before executing anything:

```text
X-Console-Agent-Id: <agent id>
X-Console-Agent-Key: <enrolled agent key>
```

## PM2 status (single and batch)

```http
GET /pm2/status/:processName
GET /pm2/statuses
```

`/pm2/statuses` runs a single `pm2 jlist`, filters the result through the agent's
allowlist, and returns `{ processes: [{ name, id, status, uptime, restarts, cpu, memory }] }`.
Unknown processes are never returned, and arbitrary process names are never accepted.
CPU/memory are consumed only by the console's Super-Admin-only endpoints.

## PM2 action

```http
POST /control/pm2/:processName/start
POST /control/pm2/:processName/stop
POST /control/pm2/:processName/restart
POST /control/pm2/:processName/reload
```

The agent must allow only the four actions above, resolve the process name from its configured service allowlist, and never accept arbitrary shell commands from this endpoint. `delete` is intentionally not part of the client API.

## Deployment request

```http
POST /webhook/:project
Content-Type: application/json

{
  "source": "console",
  "requestedBy": "admin@example.com",
  "runId": "console-8fbb0b89-58b6-4f31-b4c2-28871f51b0cf",
  "service": {
    "id": "cm...",
    "name": "CCTV Backend",
    "slug": "cctv-backend",
    "type": "PM2",
    "repositoryUrl": "https://github.com/example/cctv-backend.git",
    "branch": "main",
    "projectKey": "Rathinam_CCTV_Backend",
    "workingDirectory": "/home/mohan/SERVER/cctv-be",
    "deployDirectory": null,
    "pm2ProcessName": "R-CCTV-BE",
    "enabled": true,
    "templateKey": "nodejs-pm2",
    "customCommands": null
  }
}
```

The agent forwards this body unchanged to the Git Pipeline. The pipeline validates that `service.projectKey` matches the URL project, rejects disabled services, and uses the branch/commit metadata for deployment history. It must preserve the supplied `runId` in deployment events so the console can correlate scheduled webhook health checks with the resulting deployment. The executable command sequence remains in the pipeline's local `deployments.js`, keyed by `projectKey`; service metadata is never treated as shell input.
