# CivicLoop deployment and staging guide

This guide describes the deployment shape supported by the current code. It does not assume a hosting provider. No deployment or database operation was performed while preparing it.

## 1. Architecture

CivicLoop is a monorepo with a Vite/React static client, an Express API, PostgreSQL through Prisma, and locally stored processed images.

Recommended staging shape:

```text
Browser
  └─ HTTPS site / reverse proxy
       ├─ /       → client/dist static files
       └─ /api/*  → CivicLoop Express server
                         ├─ PostgreSQL
                         └─ persistent writable server/uploads directory
```

Serving the client and API under one HTTPS origin is the simplest arrangement and avoids cross-origin cookie issues. The server does not serve the client bundle itself. A separate API origin is supported by the client, but production auth cookies use `SameSite=Strict`; keep both hosts on the same site (such as sibling subdomains), configure CORS for the exact client origin, and use HTTPS.

Uploads are stored under `server/uploads` relative to the server package. This directory must be writable and persistent across restarts. The application has no object-storage adapter or upload-directory setting. Use one API instance for staging unless all API instances share the same persistent upload storage. Do not use an ephemeral container filesystem for a demonstration that must preserve evidence.

## 2. Runtime and build requirements

The installed Vite version declares Node `^20.19.0 || >=22.12.0`; Sharp requires Node `>=20.9.0`. Use a supported Node version for both build and runtime. Validation in this workspace ran on Node 24.14.0.

From the repository root:

```powershell
npm ci
npm run db:generate
npm run build
```

`npm run build` writes the static client to `client/dist` and compiled API code to `server/dist`. Install/build dependencies for the build stage; the TypeScript, Vite, Prisma CLI, and test tools are development dependencies. Generate Prisma Client as part of the build/release preparation. The Prisma command reads `DATABASE_URL` through `server/prisma.config.ts`; provide the intended environment value without running a migration.

Start the API from the repository root with:

```powershell
npm run start -w server
```

The API listens on `PORT` or port `4000` by default. The reverse proxy must forward `/api` to that listener and serve the contents of `client/dist` for the client routes. Configure client-side history fallback to `client/index.html` for non-API routes.

### First administrator provisioning

The public registration route always creates `CITIZEN` accounts. Provision the first administrator with the backend-only one-time command after building the server:

```powershell
npm run db:generate
npm run build -w server
npm run admin:bootstrap -w server
```

Run this as a one-off job with `NODE_ENV=production`, `DATABASE_URL`, `BOOTSTRAP_ADMIN_EMAIL`, and `BOOTSTRAP_ADMIN_PASSWORD` injected from the deployment secret store. Do not put the password in a checked-in file, shell command history, or logs. Use the intended production database target, and remove/unset the two bootstrap variables immediately after the command. The command takes the same PostgreSQL advisory lock used by administrator role changes, refuses if any `ADMIN` account exists (including inactive accounts), and refuses to promote an existing account with the supplied email. It creates an active ADMIN using the normal bcrypt password hash at cost 12. The command is not an HTTP route and cannot be invoked through public registration.

The command requires a password of at least eight characters, including lowercase, uppercase, and numeric characters; use a longer randomly generated password stored only in the secret manager. Its success message contains no email or secret. If it reports that an administrator exists, stop and use the existing administrator recovery procedure rather than trying another email. The command has not been run against any database as part of this work.

The development seed's optional `BOOTSTRAP_ADMIN_ENABLED=true` path now calls the same one-time bootstrap logic, and therefore also refuses an existing administrator or existing email. It remains disabled in production. Do not use `npm run db:seed` as the production administrator provisioning command.

## 3. Environment configuration

Set server variables in the deployment's secret/configuration store, not in a committed file. `server/.env` is used for local development. `.env.example` contains examples only.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection used by Prisma. Use a connection string reachable by the API. |
| `JWT_SECRET` | Yes | Unique, unpredictable session-signing secret. The server now refuses to start in production if this is blank. Never use an example value. |
| `NODE_ENV` | Production | Set to `production` so session cookies are `Secure` and `SameSite=Strict`. |
| `CORS_ORIGIN` | For cross-origin client/API | Exact client origin, including scheme and port. The code permits one configured origin. Same-origin requests do not depend on CORS. |
| `PORT` | No | API listener port; defaults to `4000`. |
| `GEMINI_API_KEY` | No | Optional external AI. Leave unset for a local rules/manual-review demo with no Gemini calls. |
| `GEMINI_MODEL` | No | Optional model name used only when Gemini is configured. |
| `VITE_API_URL` | Build-time, only for separate API origin | Client API origin, no path/query/fragment. Leave blank when `/api` is proxied on the client origin. See below. |
| `BOOTSTRAP_ADMIN_ENABLED` | No | Development-only seed option. Keep `false` in production. |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | One-off bootstrap only | Supplied to `admin:bootstrap` from the deployment secret store, or used by the optional development seed. Remove them after bootstrap; never commit credentials. |
| `INCIDENT_DUPLICATE_RADIUS_METERS`, `INCIDENT_DUPLICATE_WINDOW_DAYS` | No | Duplicate suggestion limits. |
| `AUTHORITY_OVERDUE_HOURS`, `AUTHORITY_UNACKNOWLEDGED_HOURS` | No | Authority queue thresholds. |
| `VERIFICATION_RESPONSE_HOURS`, `VERIFICATION_DISPUTE_ESCALATION_HOURS`, `VERIFICATION_REVIEW_OVERDUE_HOURS` | No | Verification deadlines. |
| `INTELLIGENCE_HOTSPOT_RADIUS_METERS`, `INTELLIGENCE_HOTSPOT_MIN_INCIDENTS`, `INTELLIGENCE_PUBLIC_HOTSPOT_MIN_INCIDENTS`, `INTELLIGENCE_RECURRENCE_RADIUS_METERS`, `INTELLIGENCE_RECURRENCE_WINDOW_DAYS`, `INTELLIGENCE_OVERDUE_HOURS`, `INTELLIGENCE_RISK_WEIGHT_DENSITY`, `INTELLIGENCE_RISK_WEIGHT_SEVERITY`, `INTELLIGENCE_RISK_WEIGHT_RECURRENCE`, `INTELLIGENCE_RISK_WEIGHT_OVERDUE`, `INTELLIGENCE_RISK_WEIGHT_DISPUTE_REOPEN` | No | City intelligence configuration; the risk weights must sum to 100. |

There is no upload-storage environment variable. Keep the `server/uploads` location writable and persistent. The application does not require Gemini for report creation or its fallback analysis.

### Client API origin

The client uses one shared API configuration for API requests and upload URLs:

- Same-origin deployment: leave `VITE_API_URL` blank; the browser uses `/api/...`. Route `/api/*` through the reverse proxy to Express.
- Separate API origin: copy `client/.env.example` to `client/.env.local`, set `VITE_API_URL` to the API origin only, and build again. Vite embeds it at build time. Do not add `/api` to the value.
- Local development: `npm run dev` uses the Vite `/api` proxy to `http://localhost:4000`; no `VITE_API_URL` is needed.

If using a separate same-site API host, set `CORS_ORIGIN` to the exact browser client origin. The client sends credentialed requests. A cross-site API host is incompatible with the current production `SameSite=Strict` session cookie policy; use a same-origin proxy or same-site hostnames instead.

## 4. PostgreSQL and Prisma deployment

PostgreSQL is required for auth and all database-backed workflows. Prisma reads `DATABASE_URL` from the server environment. The project has nine ordered PostgreSQL migrations, from `20261122_module02` through `20261124120000_ai_processing_consent`.

Static inspection found no migration `DROP`, `TRUNCATE`, or `DELETE` statements. Migrations create/add schema objects; the Module 05 migration also inserts verification cases for existing incidents in `VERIFICATION_PENDING`. This is a data backfill and should be reviewed against the target database. Foreign keys include `ON DELETE CASCADE` for related records, so future deletion of parent users/incidents can cascade; that is separate from migration-time deletion.

The migration files were not executed or compared to a live database's `_prisma_migrations` table. Schema validation alone does not establish that the target database has the expected migration history or no schema drift.

Safe manual staging procedure:

1. Provision a **disposable staging PostgreSQL database** and confirm its connection string independently. Never point this procedure at production or an unknown existing database.
2. Take a restorable snapshot/backup before applying migrations. Review every pending SQL file in timestamp order, including the Module 05 backfill, and confirm the expected row impact for staging.
3. Set `DATABASE_URL` only in the staging deployment environment. Run the status check:

   ```powershell
   npm exec --workspace server -- prisma migrate status
   ```

4. After confirming the target and pending migrations, apply the checked-in migrations:

   ```powershell
   npm exec --workspace server -- prisma migrate deploy
   ```

5. Verify migration status, then check `/api/ready` and run the staging workflow below. Keep the snapshot until the workflow is accepted.

Do not use `npm run db:migrate` for production deployment: it runs `prisma migrate dev`. Do not use `prisma migrate reset`. If a deployment fails after a migration, do not attempt a guessed reverse migration; restore the staging snapshot or prepare a reviewed forward fix. The production migration command above is documented for an operator; it was **not run** in this task.

## 5. Authentication, CORS, and cookies

Sessions are JWTs in an HttpOnly cookie with a 30-minute lifetime. Production mode sets `Secure` and `SameSite=Strict`; development uses a non-secure cookie with `SameSite=Lax`. Set `NODE_ENV=production` behind HTTPS. Set `JWT_SECRET` from a secret manager or equivalent secure configuration, use a distinct random secret for each environment, and do not commit or print it.

For a separate but same-site client/API origin, set `CORS_ORIGIN` to the exact client origin and retain credentialed requests. The server's fallback origin is `http://localhost:5173`; do not rely on that default for a remote client. For a same-origin proxy, CORS is not needed for the browser's same-origin calls, though setting the actual origin explicitly remains clear operational configuration.

## 6. Health, readiness, errors, and logs

- `GET /api/health` is liveness. It returns API process information and does not query PostgreSQL.
- `GET /api/ready` runs a minimal `SELECT 1`. It returns HTTP 200 `{ "status": "ready" }` on success and HTTP 503 `{ "status": "not_ready" }` on failure, without exposing database error details.
- Use `/api/health` for process liveness and `/api/ready` for traffic readiness. Check both through the same proxy path the client uses.
- API errors return generic messages for unhandled server failures. Structured request logs use route templates and operational metadata; raw exception messages are omitted.

No reverse proxy, TLS termination, or hosting health-check configuration is included in the repository. Configure those in the selected staging environment.

## 7. Upload handling

The API accepts up to five JPEG/PNG/WebP files per upload request, 5 MB each, re-encodes images, and stores them under `server/uploads`. Give the API process write access only to that persistent directory. Back it up according to staging retention needs. On multiple API instances, a shared filesystem is required or upload retrieval can fail when a request reaches another instance. No cloud object store is configured.

Orphan cleanup is a separate script and is not part of normal startup. Its default is a dry run; `--apply` deletes eligible old unlinked uploads and writes audit rows. Do not run the apply mode as a deployment hook.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Client requests go to the wrong host | Inspect the built client's request URL. Check build-time `VITE_API_URL`; otherwise verify the client origin proxies `/api`. Rebuild after changing Vite variables. |
| Browser reports CORS errors | For separate origins, set `CORS_ORIGIN` to the exact scheme/host/port of the client. Ensure the client uses credentials and the API returns credentials-enabled CORS. Prefer a same-origin proxy. |
| Login/register reports server unavailable | Check `JWT_SECRET`, `DATABASE_URL`, `/api/ready`, and API logs. Do not place secret values in support reports. |
| `/api/health` succeeds but API data routes fail | `/api/health` is liveness only; check `/api/ready`, database network access, and migration status. |
| Authentication works locally but not in production | Confirm HTTPS, `NODE_ENV=production`, browser cookie acceptance, exact CORS origin for cross-origin same-site use, and same-site hostnames. |
| Images disappear after restart or vary by request | Check persistent writable storage at `server/uploads` and ensure every API instance sees the same upload files. |
| Server exits before listening in production | Configure a nonblank `JWT_SECRET`; production startup now checks it before loading the API app. |

## 9. Staging demonstration checklist

Use a disposable staging database with migrations already reviewed/applied by the staging operator. Use synthetic accounts and non-sensitive images only. Keep `GEMINI_API_KEY` unset for this test so AI code uses its local fallback and cannot call Gemini.

### Accounts and setup

- [ ] Verify `/api/health` and `/api/ready` through the deployed client origin.
- [ ] Use a pre-provisioned staging administrator. For a new disposable database only, the existing `server/prisma/seed.ts` can create seven synthetic departments and optionally a development bootstrap admin. It upserts matching departments (including status) and must not be run against production or an existing user database. Bootstrap admin is disabled when `NODE_ENV=production`; if used for initial staging setup, keep it isolated, use a unique account, then disable it and start the app with production cookie settings.
- [ ] As admin, verify departments and provision an authority through the existing admin UI/API.
- [ ] Register a citizen through the application.

### Citizen report and AI consent

- [ ] Log in as citizen and submit a valid report with synthetic details and optional safe image evidence.
- [ ] Verify upload type/size validation and that processed files persist after server restart.
- [ ] Exercise the no-AI path and confirm the report is submitted with local rules and no external AI request.
- [ ] Exercise preview consent and the separate submission-consent step with `GEMINI_API_KEY` unset. Confirm grants are required and bound to the correct operation/report text; local fallback should be used. Do not configure a live key for this staging check.
- [ ] Attempt direct AI opt-in without a grant and confirm rejection.
- [ ] Submit one public and one private report. Confirm only the public report appears in `GET /api/incidents/public`; check public details for approximate location, redacted text, and public uploads only.
- [ ] Confirm an address-like public search is rejected and unrelated users cannot view private reports/evidence.

### Authority operations and resolution

- [ ] Log in as authority and view its department queue.
- [ ] Accept/assign an incident using `POST /api/authority/incidents/:id/assign`; as admin, verify assignment/reassignment with `PATCH /api/authority/incidents/:id/assignment`.
- [ ] Confirm an authority from another department cannot view or update that incident.
- [ ] Advance status through `ACKNOWLEDGED` and `IN_PROGRESS` with `PATCH /api/authority/incidents/:id/status`.
- [ ] Upload synthetic resolution evidence with `POST /api/uploads`, then submit via `POST /api/authority/incidents/:id/resolution`.
- [ ] Verify the incident enters verification and is not marked resolved merely because the authority submitted evidence.

### Citizen verification, dispute, and public result

- [ ] As the reporting citizen, load `GET /api/verification/me` and respond through `POST /api/verification/cases/:id/respond` with confirmation. Verify public state reports the outcome as verified only after the workflow records it.
- [ ] On a separate incident, submit a dispute with an explanation and optional private evidence.
- [ ] As an independent admin, inspect `GET /api/verification/review-queue`, assign a reviewer if needed, and decide via `POST /api/verification/cases/:id/decision`.
- [ ] Exercise the reopen decision and verify the public incident indicates `REOPENED`; ensure private dispute evidence and internal notes are not public.
- [ ] Confirm only admins can access independent review and that case/evidence access follows reporter and department boundaries.

### Admin and authorization checks

- [ ] Create/activate a staging department and provision an authority; verify role/status changes are reflected in access checks.
- [ ] Check non-admin calls to admin and review operations are rejected.
- [ ] Check unrelated-citizen, cross-department, private-image, and unauthorized incident-detail requests are rejected.
- [ ] Verify rejected upload formats, oversized files, and excessive file counts do not create accessible records.
- [ ] Inspect browser Network requests to ensure the client uses the intended API origin and cookies are sent only under the configured same-site HTTPS arrangement.

The checklist describes the existing routes. None of these live staging operations were performed while preparing this guide.
