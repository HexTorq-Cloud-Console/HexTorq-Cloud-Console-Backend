# Client access credentials

Client access entries let a super admin publish FileZilla/SFTP and PostgreSQL
connection details to a client console. A client can have any number of entries
of either type.

## Storage and encryption

`ClientAccess.passwordEncrypted` is encrypted with AES-256-GCM using
`AGENT_ENCRYPTION_KEY`. Passwords are decrypted only when an authorized API
response is built; they are never included in audit metadata or logs.

Changing `AGENT_ENCRYPTION_KEY` makes existing access passwords unreadable.

## Admin API

All admin routes require a super-admin bearer token.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/admin/access` | List every access entry, including its client. |
| `POST` | `/api/admin/access` | Create an entry for a client. |
| `PATCH` | `/api/admin/access/:accessId` | Update an entry; omit `password` to keep it. |
| `DELETE` | `/api/admin/access/:accessId` | Delete an entry. |

Create payload:

```json
{
  "clientId": "client-id",
  "type": "SFTP",
  "label": "FileZilla SFTP",
  "host": "203.0.113.10",
  "port": 22,
  "username": "client_user",
  "password": "replace-me",
  "path": "/project-folder/",
  "notes": "Read/write project access",
  "enabled": true
}
```

For `type: "DATABASE"`, send `databaseName` and optionally `sslMode`
(defaults to `Prefer`) instead of `path`:

```json
{
  "clientId": "client-id",
  "type": "DATABASE",
  "label": "PostgreSQL read/write",
  "host": "203.0.113.10",
  "port": 5432,
  "username": "client_db_user",
  "password": "replace-me",
  "databaseName": "client_db",
  "sslMode": "Prefer",
  "enabled": true
}
```

Validation rules:

- `SFTP` requires `path`.
- `DATABASE` requires `databaseName`.
- `port` must be between 1 and 65535.
- `clientId` is fixed after creation.
- The label, host, port, username, path/database fields, notes, and enabled
  state can be edited; the password can be rotated by sending a new `password`.

## Client API

`GET /api/access` requires a client bearer token and returns only the enabled
entries owned by that client. Disabled entries stay visible to admins but are
hidden from the client console.

## Database migration

Apply the new migration during deployment:

```sh
npx prisma migrate deploy
npx prisma generate
```

The migration is `prisma/migrations/0002_client_access_credentials`.
