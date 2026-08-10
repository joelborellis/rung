# Deploying Rung

Live at **https://handrail-review.azurewebsites.net**

| | |
|---|---|
| Subscription | gametolearn (`083988ac-…`) |
| Resource group | `AppServices` |
| Plan | `handrail-review-plan` — Linux **B1**, Central US (~$13/mo) |
| App | `handrail-review`, Node 22 LTS |
| Database | `rung` on `mcp-registry-postgres`, Central US |

Central US on purpose: same region as the database, so queries do not cross a
region. Its own plan rather than sharing `partnervoicesignals-plan-w`, so a
problem in one app cannot take down the others.

## Deploying a change

```bash
npm test                     # unit + boundary checks
npm run build:deploy         # dist/ + bundled server -> deploy.zip (~0.2 MB)
az webapp deploy -g AppServices -n handrail-review --src-path deploy.zip --type zip
```

Then verify against the real thing rather than assuming:

```bash
API_BASE_URL=https://handrail-review.azurewebsites.net npm run e2e
APP_BASE_URL=https://handrail-review.azurewebsites.net npm run e2e:browser
```

The first run after a deploy takes ~30s to answer while the container starts.

### What ships

`scripts/build-server.mjs` bundles the API into one file with esbuild; `pg`
stays external and is installed on the server. `scripts/package-deploy.mjs`
stages exactly what is needed and refuses to package a `.env`.

```
wwwroot/index.js       bundled API + static file server
wwwroot/package.json   pg only
wwwroot/dist/          the built SPA
```

No source, no tests, no `.env`, and ~0.45 MB of `node_modules`. Small deploys
are fast deploys, which matters when you are chasing a config problem.

**One process serves both the SPA and `/api`.** Not a shortcut — same-origin is
what lets the session cookie be `HttpOnly; SameSite=Strict`, lets `sendBeacon`
work on tab close (it cannot set headers), and removes CORS entirely. Splitting
the SPA onto a CDN would cost all three.

## Configuration

Set in App Service, never in the repo:

| Setting | Notes |
|---|---|
| `DATABASE_URL` | the least-privilege `rung_app` role — CRUD only, no DDL |
| `SESSION_SECRET` | production-only value; **not** the one in local `.env` |
| `APP_BASE_URL` | `https://handrail-review.azurewebsites.net` |
| `NODE_ENV` | `production` — this is what makes cookies `Secure` |

`NODE_ENV=production` is load-bearing. Azure terminates TLS at the front end and
forwards over plain http, so the server cannot infer TLS from the socket; without
this the `Secure` flag is dropped and session cookies travel unprotected.

Read them back with:

```bash
az webapp config appsettings list -g AppServices -n handrail-review \
  --query "[].name" -o tsv
```

Also set: HTTPS-only, TLS floor 1.2, HTTP/2, and **ARR affinity disabled** — the
app is stateless, so session affinity buys nothing and only adds cookies.

## Database access

The app reaches Postgres through the `allow-azure` firewall rule (`0.0.0.0`,
Azure's "allow Azure services"). Nothing about deployment needed the firewall
widened.

**An `AllowAll` rule spanning `0.0.0.0`–`255.255.255.255` was deleted** on
2026-08-10. The database had been reachable from anywhere on the internet with
only the password protecting it. Current rules:

```
allow-azure         0.0.0.0          Azure services, including this app
joel-dev-20260810   99.147.172.34    the dev machine
```

**Your home IP is dynamic.** When it changes, every `db:*` and `e2e` command
fails with `timeout expired` — which looks like the database is down. It is not:

```bash
node db/check-connectivity.mjs    # tells you which paths broke
# then, with the address from https://api.ipify.org
az postgres flexible-server firewall-rule create -g StorageServices \
  -s mcp-registry-postgres -n joel-dev-$(date +%Y%m%d) \
  --start-ip-address <ip> --end-ip-address <ip>
```

The deployed app is unaffected by this — it comes in via `allow-azure`.

## Invite links

Links are built from the browser's own origin, so links minted through **Manage
counselors** on the live site are correct automatically. Only `db/seed.mjs` uses
`APP_BASE_URL`, so set it when reissuing from the command line:

```bash
APP_BASE_URL=https://handrail-review.azurewebsites.net node db/seed.mjs --reissue
```

A minted token is shown once and never stored recoverably. Losing it means
reissuing — which is cheap, and much better than a database that holds working
credentials.

## Logs

```bash
az webapp log tail -g AppServices -n handrail-review
```

The server logs failing API requests (`! POST /api/... -> 403`) and not
successful ones, so the stream stays readable. Never a request body — those
contain clinical reasoning.

## Still outstanding

- **Rotate the database password.** It has been in a terminal transcript and sits
  in two `.env` files. Rotating needs three places updated: this repo's `.env`,
  the App Service `DATABASE_URL` setting, and the ElevenLabs project's `.env`.
- **No custom domain.** `handrail-review.azurewebsites.net` is what counselors
  see. Fine for an internal tool; a real domain would need a certificate.
- **No CI.** Deploys are the manual command above. Two commits in, that is
  honest; if it becomes routine, a GitHub Actions workflow on `main` is the fix.
- **B1 has no autoscale and no SLA.** Correct for 3–8 counselors. If a batch
  gets much larger, S1 is the next step up.
