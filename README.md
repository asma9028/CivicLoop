# CivicLoop
<<<<<<< HEAD

CivicLoop is a civic accountability application with public incident discovery, citizen reporting, transparency, maps, and citizen, authority, and admin interfaces.

## Run locally

```powershell
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:4000
- Health: http://localhost:4000/api/health

## Scripts

- `npm run dev` - run the frontend and API
- `npm run build` - build both workspaces
- `npm run lint` - lint the frontend
- `npm run test` - run client and server tests
- `npm run db:generate` - generate the Prisma client
- `npm run db:migrate` - create or apply a local development migration

## Environment

Copy `.env.example` to `server/.env` and configure `DATABASE_URL` for PostgreSQL. The API requires a database connection.

### Client and API origins

The client reads `VITE_API_URL` at build time. It must be an HTTP(S) origin only, with no `/api` path. When it is blank or unset, the client calls relative `/api/...` paths on its own origin; it does not fall back to a visitor's `localhost`.

- **Local development:** `npm run dev` starts Vite and the API. Vite proxies `/api` requests to `http://localhost:4000`, so the client needs no API URL setting. Keep `CORS_ORIGIN=http://localhost:5173` in `server/.env`.
- **Same-origin deployment:** Serve the client and proxy `/api` to the server. Leave `VITE_API_URL` blank.
- **Separate API origin:** Copy `client/.env.example` to `client/.env.local`, set `VITE_API_URL` to the deployed API origin, and build the client after setting it. Vite embeds this value in the built files; changing it after the build has no effect. Set the server's `CORS_ORIGIN` to the exact client origin. Production session cookies are `Secure` and `SameSite=Strict`, so deploy the client and API on the same site (for example, sibling subdomains) or use a same-origin proxy; cross-site hosting is not compatible with the current session-cookie policy.

The server's `.env.example` lists backend settings. Set a production-unique `JWT_SECRET`, `DATABASE_URL`, `NODE_ENV=production`, and the correct `CORS_ORIGIN` in the deployment environment. Configure `GEMINI_API_KEY` only if optional external AI is intentionally enabled; it is not required for ordinary reporting. Do not put backend secrets in client environment files.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the deployment architecture, PostgreSQL migration procedure, persistent upload storage requirements, production startup configuration, troubleshooting, and staging checklist.

To check the configured API origin, open `/api/health` (server liveness) and `/api/ready` (database readiness) through the same origin/proxy used by the client, or append those paths to `VITE_API_URL` when using a separate same-site API origin. In browser developer tools, API requests should target that configured origin or the client origin's `/api` path. A non-JSON response from an API request now points to the API-origin/proxy configuration in its error message.

## Module 01

Module 01 established the public landing page, incident explorer and detail views, transparency dashboard, OpenStreetMap view, and citizen, authority, and admin interface shells.

## Module 02

Module 02 adds the database-backed authentication foundation:

- Zod-validated citizen registration and login
- bcrypt password hashing
- HttpOnly, SameSite JWT session cookies
- 30-minute access sessions
- Logout and `/api/auth/me`
- Protected frontend routes and role guards
- Database-backed profile updates
- Admin user role/status management
- Admin department create/edit/activate/deactivate operations
- Secure authority account provisioning
- Prisma audit logging
- Express login and registration rate limiting

Copy `.env.example` to `server/.env`, set a production-unique `JWT_SECRET`, and set `DATABASE_URL` for PostgreSQL. The migration SQL is available at `server/prisma/migrations/20261122_module02/migration.sql`. PostgreSQL must be running before Prisma migrate or seed commands can succeed.

Development bootstrap admin:

```text
BOOTSTRAP_ADMIN_ENABLED=false
BOOTSTRAP_ADMIN_EMAIL=...
BOOTSTRAP_ADMIN_PASSWORD=...
```

Bootstrap provisioning is disabled in production and is never seeded with a hardcoded password.

## Module 03: Citizen reporting

Module 03 adds authenticated citizen reports, image evidence, assisted classification and prioritization, duplicate suggestions, public/private visibility, and database-backed public and personal incident views.

- Report and upload APIs require an active citizen session. Uploads are limited to five JPEG, PNG, or WebP images, up to 5 MB each; the server verifies file signatures and stores files under `server/uploads`.
- Image retrieval enforces visibility and ownership: public incident images are viewable publicly; private report images require the reporter, an admin, or an authority in the assigned department. Unattached draft images are accessible only to their uploader.
- `POST /api/incidents/analyze` returns classification, priority, department recommendation, and possible duplicate matches. Gemini is optional (`GEMINI_API_KEY`, with optional `GEMINI_MODEL`); rule-based classification is used when the provider is not configured or does not return a valid result.
- `POST /api/incidents` revalidates the submitted report and evidence, then persists the incident and its activity. Possible duplicates are suggestions; an incident is linked as a duplicate only when the citizen confirms a suggested match.
- Public reports and aggregate data are available at `GET /api/incidents/public`. The authenticated citizen feed is `GET /api/incidents/my`; incident detail access observes report visibility.
- Public report coordinates are rounded and the submitted location text is withheld. Public text is screened for common contact details, street addresses, and coordinate strings; uploaded images are restricted to records marked public.
- Orphaned uploads are retained for 30 days. `npm run uploads:cleanup -w server` performs a dry run; `npm run uploads:cleanup -w server -- --apply` deletes only expired, unlinked, unreferenced uploads and records each deletion in the audit log. Cleanup is never run during ordinary API requests.
- `npm run db:migrate -w server -- --name <migration-name>` creates and applies development schema migrations. `npm run db:seed` idempotently provisions seven synthetic departments; optional development admin bootstrap is disabled unless explicitly enabled in the environment.

The AI classification, department, duplicate, and priority outputs are assistive estimates; they do not automatically dispatch government services or make a final safety determination.

## Module 04: Authority operations

Module 04 adds a database-backed authority workspace. Authorities can only access incidents in their active assigned department. Administrators can operate across departments and can assign incidents to eligible authority users.

- Dashboard: `GET /api/authority/dashboard`
- Filtered/paginated incident queue: `GET /api/authority/incidents`
- Authorized detail and activity: `GET /api/authority/incidents/:id` and `GET /api/authority/incidents/:id/activity`
- Assign to self/admin assignment: `POST /api/authority/incidents/:id/assign` and `PATCH /api/authority/incidents/:id/assignment`
- Validated status changes: `PATCH /api/authority/incidents/:id/status`
- Public operational updates/internal notes: `POST /api/authority/incidents/:id/updates`
- Resolution submission: `POST /api/authority/incidents/:id/resolution`
- Department performance: `GET /api/authority/analytics`

Resolution submissions record `IN_PROGRESS` → `RESOLUTION_SUBMITTED` → `VERIFICATION_PENDING` lifecycle events in one transaction; they never mark incidents resolved automatically. Public incident details include public activity only. Internal notes and resolution handoff notes are restricted to authority/admin operations endpoints. Resolution evidence reuses the authenticated image upload and secure retrieval flow.

The additive migrations `20261122175840_module04_authority_operations` and `20261122180746_module04_assignment_history` add activity visibility/types, explicit unassignment history, incident lifecycle timestamps/reasons, and resolution metadata without deleting existing incident data. `AUTHORITY_OVERDUE_HOURS` (default `72`) and `AUTHORITY_UNACKNOWLEDGED_HOURS` (default `24`) configure operational alert thresholds; each must be a whole number from 1 to 8760.

Authority resolution submissions require a separate citizen or independent decision before an incident can become `RESOLVED`.

## Module 05: Verification, trust, and accountability

Each new authority resolution submission creates an immutable verification history for that resolution, with a configurable citizen response deadline. Citizen confirmation records a final decision; disagreement, incomplete work, further-action requests, and evidence mismatch are sent to independent administrator review. Silence never approves or resolves an incident. The authenticated `POST /api/verification/process-deadlines` operation performs an idempotent due-case sweep; client verification views invoke it explicitly before fetching their read-only lists.

- Citizen verification center: `GET /api/verification/me`
- Authorized verification details: `GET /api/verification/cases/:id`
- Citizen response: `POST /api/verification/cases/:id/respond`
- Citizen dispute evidence: `POST /api/verification/cases/:id/evidence`
- AI evidence analysis: `POST /api/verification/cases/:id/analyze`
- Independent review queue: `GET /api/verification/review-queue`
- Assign/unassign an independent administrator: `PATCH /api/verification/cases/:id/reviewer`
- Independent decision: `POST /api/verification/cases/:id/decision`
- Department metrics (authenticated): `GET /api/verification/analytics`
- Public aggregate department metrics: `GET /api/verification/public/departments/:departmentId/metrics`
- Controlled deadline processing: `POST /api/verification/process-deadlines`

Module 05 adds the additive migration `20261123100000_module05_verification`. It creates resolution-scoped verification cases, immutable action and AI-analysis history, deadlines, reviewer assignments, queue indexes, and per-upload public/private visibility. Existing incidents awaiting verification are backfilled without deleting or resetting Module 01–04 data.

`VERIFICATION_RESPONSE_HOURS` defaults to `72`, `VERIFICATION_DISPUTE_ESCALATION_HOURS` to `48`, and `VERIFICATION_REVIEW_OVERDUE_HOURS` to `72`; values must be whole hours from 1 to 8760. Gemini analysis reuses `GEMINI_API_KEY` and `GEMINI_MODEL`; report and resolution text are screened for common contact details, the exact location field is omitted, and the UI discloses that unmodified evidence images may contain embedded location metadata. Unavailable or invalid AI results become an explicit uncertain/manual-review advisory and never block human decisions.

Public pages expose only safe verified summaries, public resolution images, and generic review/reopen statuses. Citizen dispute uploads are private to the reporter, administrators, and authorities in the active responsible department. Trust metrics use publicly shared incidents; only final verified/reopened outcomes contribute to the department outcome indicator, which is marked `Insufficient data` below five decisions. Deadline escalation is performed by the controlled processing operation, not by GET requests. Authority profiles remain single-department.

## Module 06: City intelligence and predictive insights

Module 06 adds deterministic city reporting trends, geographic hotspot and recurrence analysis, an explainable Civic Risk Index, and auditable proactive inspection recommendations. It does not create incidents, change incident status, dispatch work, or claim to predict causation or future events. Admins can view city-wide data or filter by department; authority accounts are restricted to their active assigned department.

- Public privacy-safe aggregates: `GET /api/intelligence/public`
- Authenticated admin/department overview: `GET /api/intelligence/overview`
- Scoped hotspot and recurrence detail: `GET /api/intelligence/hotspots` and `GET /api/intelligence/recurrences`
- Optional AI narrative from aggregate metrics: `POST /api/intelligence/summary`
- Recommendation list, generation, transition, and audit history: `GET /api/intelligence/recommendations`, `POST /api/intelligence/recommendations/refresh`, `PATCH /api/intelligence/recommendations/:id`, and `GET /api/intelligence/recommendations/:id/history`

The admin console and department portal provide period, category, severity, and (for admins) department filters, trend charts, a geographic risk map, recurrence groups, and recommendation assignment/review. Public City Insights only includes public reports, suppresses hotspots and recurrence groups below five reports, rounds hotspot coordinates, and excludes incident identifiers, exact coordinates, titles, descriptions, internal recommendations, and personal data. Empty datasets display empty states rather than fabricated values. Analysis is capped at 5,000 incidents per query; responses identify truncation and invalid coordinates.

Hotspot clustering uses a 500 m default radius and requires three reports internally. Recurrence groups require the same category, reports within 250 m and a 365-day maximum group window; confirmed duplicate links are shown separately from independent reports. The configurable overdue threshold defaults to 72 hours. The 0–100 Civic Risk Index uses density 30%, mean severity 25% (LOW 20, MEDIUM 45, HIGH 70, CRITICAL 100), recurrence 20%, overdue unresolved reports 15%, and dispute/reopen history 10%; weights must total 100. Scores are operational signals derived from submitted reports, not safety assessments or causal predictions.

`INTELLIGENCE_HOTSPOT_RADIUS_METERS`, `INTELLIGENCE_HOTSPOT_MIN_INCIDENTS`, `INTELLIGENCE_PUBLIC_HOTSPOT_MIN_INCIDENTS`, `INTELLIGENCE_RECURRENCE_RADIUS_METERS`, `INTELLIGENCE_RECURRENCE_WINDOW_DAYS`, `INTELLIGENCE_OVERDUE_HOURS`, and the `INTELLIGENCE_RISK_WEIGHT_*` variables configure analysis. The Module 06 migration `20261123153000_module06_city_intelligence` is additive and stores recommendation state/history; deploy it with the existing Prisma migration workflow without resetting the database. AI summaries use Gemini only when configured and receive aggregate metrics without incident titles or IDs; unavailable or invalid summaries are reported as unavailable rather than used to make operational decisions.

## Module 07: Community engagement and impact

Module 07 adds public community issue support, private citizen-defined circular areas, civic campaigns, a verified impact ledger, participation history, and optional in-app notifications. It does not change incident priority or fabricate campaign, report, or impact data.

- Public community feed and safe issue detail: `GET /api/community/incidents` and `GET /api/community/incidents/:id`
- Citizen support state: `PUT` and `DELETE /api/community/incidents/:id/support`. One active support per citizen/report is counted; support is not a priority vote.
- Followed areas and recent activity: `GET/POST /api/community/areas`, `DELETE /api/community/areas/:id`, and `GET /api/community/areas/:id/activity`. Areas are user-defined circles (100–10,000 m, maximum 20 active areas); they are not represented as official neighborhood boundaries.
- Public campaigns: `GET /api/community/campaigns` and `GET /api/community/campaigns/:id`; citizen participation uses `POST/DELETE /api/community/campaigns/:id/join`.
- Admin/authority campaign oversight: `GET /api/community/campaigns/manage`, `POST /api/community/campaigns`, `PATCH /api/community/campaigns/:id`, and `PUT/DELETE /api/community/campaigns/:id/incidents/:incidentId`. Authorities are scoped to their assigned active department; only public incident records can be linked.
- Public verified impact ledger and aggregate filters: `GET /api/community/impact`. Only public incidents in `RESOLVED` state with verified resolution records count as completed impact; private evidence is excluded, locations are rounded, verification rates are withheld below five final decisions, and average resolution time below three records.
- Citizen participation and notification inbox: `GET /api/community/me/dashboard`, `GET /api/community/me/participation`, `GET /api/community/notifications`, `POST /api/community/notifications/read-all`, and `POST /api/community/notifications/:id/read`. Notifications are in-app only, idempotently materialized from recent public activity, and are not email or push delivery.
- Explicit notification refresh: `POST /api/community/notifications/materialize`. Dashboard and inbox GET requests are read-only; notification records use stable source keys and duplicate-safe insertion.

The explainable community signal combines community support (40%), recurrence (20%), severity (15%), time open (10%), reopen history (10%), and dispute history (5%). It is presented separately from authority priority. Public serializers omit submitted location text and exact coordinates, redact common contact/address patterns, omit internal notes, and filter private uploads. Impact date filters use resolved dates for verified impact, verification-case creation dates for verification outcomes, and event dates for reopen counts. Campaign progress reports participation and verified linked reports without claiming the campaign caused an incident resolution.

The additive migration `20261123160000_module07_community_engagement` adds support, followed-area, campaign, participation-event, audit, and notification tables and indexes. Apply it with `npm exec --workspace server -- prisma migrate deploy`; do not reset the database. No synthetic campaign, incident, or impact records are seeded.

The additive remediation migration `20261123165000_upload_cleanup_audit` adds the `UPLOAD_CLEANUP` audit action used by the manual orphan-upload cleanup command.
=======
CivicLoop — An AI-powered civic-tech platform that connects citizens and municipal authorities to report, track, prioritize, and resolve civic issues through transparent, data-driven governance.
>>>>>>> 3ddba72fb3c6dcac629c8106db4d7cb649c11ebe
