# Pipeline agent control contract

The console calls these routes on an enrolled pipeline agent. The agent must validate both headers before executing anything:

```text
X-Console-Agent-Id: <agent id>
X-Console-Agent-Key: <enrolled agent key>
```

## PM2 action

```http
POST /control/pm2/:processName/start
POST /control/pm2/:processName/stop
POST /control/pm2/:processName/restart
POST /control/pm2/:processName/reload
```

The agent must allow only the four actions above, resolve the process name from its configured service allowlist, and never accept arbitrary shell commands from this endpoint. `delete` is intentionally not part of the client API.
