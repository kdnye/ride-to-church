## Ride to Church (Supabase-backed MVP)

Production-oriented Node server for dispatch + notifications. This service is designed for **managed hosting with TLS termination at the edge** and enforces HTTPS + secure defaults in production.

> Email delivery is Postmark-first. Configure and operate all email notification flows through Postmark credentials and templates.

## Quickstart (Ride to Church MVP)

### 1) Prerequisites

- Node.js (LTS)
- npm
- Supabase project with SQL Editor access

### 2) Database initialization (Supabase)

In Supabase SQL Editor:

1. Enable required extensions:
   - `pgcrypto`
   - `postgis`
2. Run migrations in order:
   1. `migrations/001_init_schema.sql`
   2. `migrations/002_indexes.sql`
   3. `migrations/003_dispatch_concurrency.sql`
   4. `migrations/004_queue_optimizer_inputs.sql`
   5. `migrations/005_sessions.sql`
   6. `migrations/006_add_travel_time_seconds.sql`
   7. `migrations/007_add_solver_output_columns.sql`
   8. `migrations/008_auth_and_superadmin.sql`

### 3) Environment configuration

Create `.env` in the project root (or configure host-managed secrets). You can copy `.env.example` and fill in secrets.

Required values:

- `SUPABASE_URL=https://nwojorirnvquctowiolq.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY=<service_role key>`
- `SUPABASE_ANON_KEY=<anon/public key used by browser realtime subscription>`
- `SESSION_SECRET=<secure random value>`
- `POSTMARK_API_TOKEN=<postmark server token>`

### 4) Install and run

```bash
npm install
npm start
```

App default URL: `http://localhost:4173`.

### 5) Verify

```bash
npm test
```

### 6) Production

Use:

```bash
npm run start:prod
```

In production, deploy behind managed TLS termination and keep secrets in managed secret storage.

---

## Documentation map

- **Architecture + function reference:** `docs/ARCHITECTURE.md`
- **Tiered user help guide:** `docs/HELP_GUIDE.md`

### Environment variables

Required in production:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY` (public browser key for Supabase Realtime subscriptions)
- `SESSION_SECRET` (HMAC signing key for session integrity)
- `NODE_ENV=production`

Optional:

- `PORT` (defaults to `4173`)
- `SESSION_TTL_MS` (defaults to 8 hours)
- `TRUST_PROXY=true` (default; trust `x-forwarded-proto` from managed edge)
- `ENABLE_ROUTE_MATRIX=true` (default; when true, uses Google Routes Matrix for assignment/queue optimization)
- `GOOGLE_MAPS_API_KEY` (required only when `ENABLE_ROUTE_MATRIX=true`)

Notifications (server-side secret storage only):

- `POSTMARK_API_TOKEN`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

> Never expose these values to browser bundles. Configure them in managed host secret storage (e.g., Render/Fly/Railway encrypted environment variables or secret manager integrations).

### Run locally

```bash
npm start
```

### Production start / deployment targets

```bash
npm run start:prod
npm run deploy:managed
npm run deploy:tls
```

- Managed hosting should terminate TLS at the edge and forward traffic over trusted internal links.
- Application enforces HTTPS in production (redirects non-HTTPS requests) and returns hardened security headers.

### Security controls implemented

- HTTPS-only behavior in production (`308` redirect to `https://...` when request is not secure).
- Secure headers on static + API responses:
  - `Strict-Transport-Security`
  - `Content-Security-Policy`
  - `X-Frame-Options: DENY`
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy`
  - `Cache-Control: no-store`
- Server-managed session cookies (`HttpOnly`, `Secure`, `SameSite=Strict`) for authenticated API access.
- Server-side RBAC checks for privileged operations (dispatch/admin actions).

### API surface (backend data-access layer)

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/logout`
- `GET /api/users`
- `GET /api/rides`
- `POST /api/rides`
- `POST /api/rides/auto-assign`
- `GET /api/drivers/:driverId/queue`
- `POST /api/rides/:rideId/assign` (optimistic concurrency via revision/updatedAt)
- `POST /api/rides/:rideId/cancel`
- `POST /api/drivers/:driverId/queue/reorder` (atomic queue reorder + concurrency checks)
- `PATCH /api/admin/users/:userId` (people_manager/super_admin only; updates role/status and invalidates sessions)

### Database migrations

Run in order:

1. `migrations/001_init_schema.sql`
2. `migrations/002_indexes.sql`
3. `migrations/003_dispatch_concurrency.sql`
4. `migrations/004_queue_optimizer_inputs.sql`
5. `migrations/005_sessions.sql`
6. `migrations/006_add_travel_time_seconds.sql`
7. `migrations/007_add_solver_output_columns.sql`
8. `migrations/008_auth_and_superadmin.sql`

## Production runbook

### 1) Certificates & TLS termination

1. Use managed hosting edge certificates (ACME-managed auto-renew preferred).
2. Enforce HTTPS redirect at edge and application layer.
3. Keep HSTS enabled (`max-age=31536000; includeSubDomains; preload`) only after verifying HTTPS coverage for all subdomains.
4. Validate with:
   - SSL Labs scan
   - `curl -I http://<domain>` returns redirect to HTTPS
   - `curl -I https://<domain>` returns HSTS header

### 2) Secret Management & Rotation

All production secrets must live in the managed host secret manager (for example: Render/Fly/Railway encrypted secrets or cloud secret manager integrations). Do **not** commit secrets to git, `.env` files in production, CI logs, or dashboards.

Rotate `SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `POSTMARK_API_TOKEN`, and Twilio credentials every 90 days (or sooner after incidents). Email is Postmark-managed in this system; treat `POSTMARK_API_TOKEN` and Postmark template/config credentials as high-priority secrets and rotate/validate them in the same operational window.

#### Session secret rollover (multi-key verification)

Use a controlled rollover window so existing sessions remain valid until TTL expiration:

- Signing key: `SESSION_SECRET_CURRENT`
- Verification keys: `[SESSION_SECRET_CURRENT, ...SESSION_SECRET_PREVIOUS]`
- `SESSION_SECRET_PREVIOUS` should be a delimiter-separated list from the secret manager (example: comma-delimited)

```js
import crypto from 'node:crypto';

const SESSION_SECRET_CURRENT = process.env.SESSION_SECRET_CURRENT;
const SESSION_SECRET_PREVIOUS = (process.env.SESSION_SECRET_PREVIOUS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!SESSION_SECRET_CURRENT) {
  throw new Error('Missing SESSION_SECRET_CURRENT');
}

const VERIFY_KEYS = [SESSION_SECRET_CURRENT, ...SESSION_SECRET_PREVIOUS];

export function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET_CURRENT)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;

  for (const key of VERIFY_KEYS) {
    const expected = crypto
      .createHmac('sha256', key)
      .update(body)
      .digest('base64url');

    const sigBuf = Buffer.from(sig);
    const expectedBuf = Buffer.from(expected);
    if (
      sigBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    }
  }

  return null;
}
```

Rollover procedure:

1. Generate and store new `SESSION_SECRET_CURRENT`; move old current secret into `SESSION_SECRET_PREVIOUS`.
2. Deploy and verify active users remain authenticated during the `SESSION_TTL_MS` window.
3. After at least one full TTL window passes, remove retired keys from `SESSION_SECRET_PREVIOUS`.
4. Redeploy and confirm tokens signed with retired keys fail verification.
5. Log rotation timestamp, owner, and tracking ticket.

### 3) PII incident response

1. **Detect**: trigger alert on suspicious access patterns, auth failures, or anomalous exports.
2. **Contain**: revoke leaked keys/secrets immediately; block compromised sessions.
3. **Eradicate**: patch root cause, redeploy hardened config.
4. **Recover**: validate data integrity and re-enable traffic progressively.
5. **Notify**: execute legal/regulatory notification flow per jurisdiction.
6. **Review**: complete post-incident RCA and update controls/runbook.

### 4) Logging and audit expectations

- Log authentication failures, role authorization failures, and privileged writes.
- Avoid logging raw PII/secrets in application logs.
- Retain security/audit logs according to compliance requirements.
