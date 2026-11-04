# Spinbox

Spin containers up and down on Railway from a small web page, using Railway's GraphQL API.

Live: https://control-panel-production-014d.up.railway.app (password on request)

## Why it looks like this

The server holds a Railway token that can create and delete infrastructure, so the interesting part is what it refuses to do:

- **Password on everything** except `/health`, with CSRF protection on the API.
- **Allowed images only.** The browser sends a key (`nginx`), never an image name.
- **A cap on running containers** (`MAX_CONTAINERS`, default 3), counted per project.
- **It can only delete what it created.** Ownership is the `spinbox-` name prefix, checked on the server against the live service list. A real Railway id for another service gets a 404.
- **Railway error text stays on the server.** The browser gets a generic message.

Rules live in `src/containers.ts`, API calls in `src/railway.ts`, HTTP in `src/app.ts`, so each can change alone.

## Run

```sh
npm install
APP_PASSWORD=... RAILWAY_API_TOKEN=... TARGET_PROJECT_ID=... TARGET_ENVIRONMENT_ID=... npm run dev
npm test
npm run typecheck
```

| Variable | Meaning |
|---|---|
| `APP_PASSWORD` | Login password, username `admin`, at least 12 characters |
| `RAILWAY_API_TOKEN` | Account or workspace token |
| `TARGET_PROJECT_ID`, `TARGET_ENVIRONMENT_ID` | Where containers go. On Railway they default to the app's own project and environment |
| `MAX_CONTAINERS` | Optional, default 3 |

## What I would do next

- Close the race in the cap: two simultaneous requests can both pass the check. Fine for one operator, not for a team.
- Replace the name prefix with a stored ownership record, since anyone can name a service `spinbox-x` in the dashboard.
- Replace polling with Railway's subscriptions, and add per-user login and an audit log.
