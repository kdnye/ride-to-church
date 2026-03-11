# Ride to Church — Architecture & Function Reference

This document is a full architecture refresh for the current codebase, including runtime boundaries, API behavior, dispatch logic, queue optimization, and operational stats that can be derived from current state.

## 1) System overview

### Runtime components

- **Node HTTP server (`server.js`)**
  - Serves static assets (`index.html`, `app.js`, `styles.css`).
  - Exposes REST APIs under `/api/*`.
  - Enforces production HTTPS redirect + hardened security headers.
  - Handles login/session lifecycle and role-based authorization.
  - Reads/writes ride/user data from Supabase PostgREST + RPC.
- **Browser app (`app.js`)**
  - Renders role-based workflow screens for member, driver, volunteer dispatcher, people manager, and super admin actors.
  - Calls the API via `src/apiClient.js`.
  - Executes optimistic updates and fallback refresh behavior.
  - Stores non-authoritative local UI settings in localStorage (`rtc-settings-v3`).
- **Dispatch/route logic module (`logic.js`)**
  - Distance computation (`haversineDistanceKm`).
  - Auto-assignment and nearest-driver ranking.
  - Event-aware assignment variant.
  - Concurrency-safe in-memory assignment/reorder helpers.
  - Driver queue optimization (nearest-neighbor seed + 2-opt refinement).
- **Data tier (Supabase)**
  - `users`, `rides`, `ride_assignments` tables + RPC functions for transactional assignment and reorder.
  - Migrations are in `migrations/001..004_*.sql`.

### High-level request flow

1. Browser sends API request to Node server.
2. Server validates session (production) and role authorization.
3. Server performs Supabase REST/RPC operations.
4. For assignment/cancel/reorder changes, server re-optimizes impacted driver queue(s).
5. Response returns normalized ride/queue payloads to browser UI.

---

## 2) Data model and states

## Users

Core mapped fields:

- `id`
- `fullName` (`full_name` in DB)
- `role` (`member`, `volunteer_driver`, `volunteer_dispatcher`, `people_manager`, `super_admin`)
- `approval_status` (`approved`, `pending`, etc.)
- `coordinates` (POINT parsed to `{ lat, lon }`)

## Rides

Core mapped fields:

- `id`
- `memberId`
- `scheduledFor`
- `pickupNotes`
- `status` (`requested`, `assigned`, `cancelled`)
- `revision`, `updatedAt` (for optimistic concurrency)
- `wheelchairPickupBufferMinutes`
- `pickupWindowStart`, `pickupWindowEnd`
- `driverId`, `queueOrder` (from `ride_assignments`)

## Queue records

From `ride_assignments`:

- `driver_id`
- `ride_id`
- `queue_position`
- `assigned_by` (when set on create/assign paths)

---

## 3) API catalog (current)

## Public/health

- `GET /api/health`
  - Returns `{ ok: true }`.

## Auth

- `POST /api/auth/login`
  - Body: `{ email, password }`
  - Validates password via Postgres `pgcrypto` RPC and enforces approved status.
  - Creates server session and sets secure cookie.
  - Returns `sessionSignature` (HMAC-based) + expiration.
- `POST /api/auth/register`
  - Body: `{ fullName, email, password, phone? }`
  - Creates a pending member account with hashed password via RPC.
- `POST /api/auth/logout`
  - Requires authenticated session.
  - Clears cookie and deletes server session entry.

## User and ride read paths

- `GET /api/users`
  - Roles: volunteer_dispatcher/people_manager/super_admin
- `GET /api/rides`
  - Roles: member/volunteer_driver/volunteer_dispatcher/people_manager/super_admin
- `GET /api/drivers/:driverId/queue`
  - Roles: volunteer_driver/volunteer_dispatcher/people_manager/super_admin

## Admin write paths

- `PATCH /api/admin/users/:userId`
  - Roles: people_manager/super_admin
  - Allows updates to `role` and/or `approval_status`.
  - Invalidates active sessions for the target user so RBAC changes apply immediately.

## Ride write paths

- `POST /api/rides`
  - Roles: member/volunteer_dispatcher/people_manager/super_admin
  - Creates a `requested` ride.
- `POST /api/rides/auto-assign`
  - Roles: volunteer_dispatcher/people_manager/super_admin
  - Runs `autoAssignRides` and persists assignments.
- `POST /api/rides/:rideId/assign`
  - Roles: volunteer_dispatcher/people_manager/super_admin
  - Transactional assignment via Supabase RPC with revision checks.
- `POST /api/rides/:rideId/cancel`
  - Roles: volunteer_dispatcher/people_manager/super_admin
  - Validates expected revision/timestamp, marks cancelled, deletes assignment row.
- `POST /api/drivers/:driverId/queue/reorder`
  - Roles: volunteer_dispatcher/people_manager/super_admin
  - Transactional reorder RPC with stale version detection.

## Error conventions

- `400`: missing required request fields
- `401`: auth required / expired session / invalid signature
- `403`: forbidden by role or approval status
- `404`: resource/route not found
- `409`: stale concurrency version conflicts

---

## 4) Function-by-function reference

## `logic.js` exports

- `haversineDistanceKm(a, b)`
  - Great-circle distance between two coordinates in kilometers.
- `nearestDrivers(member, drivers, queueLoads)`
  - Ranks by shortest distance, then lowest queue load, returns top 3.
- `autoAssignRides({ rides, users, maxRidesPerDriver })`
  - In-place assignment of `requested` rides to approved drivers respecting max load.
- `autoAssignRidesWithEvents({ rides, users, maxRidesPerDriver, emitEvent })`
  - Same assignment behavior plus event emission:
    - `ride.assigned`
    - `ride.status_changed`
    - `ride.driver_eta_10m` (conditional)
- `queueForDriver(driverId, rides, users)`
  - Returns assigned rides for one driver ordered by `queueOrder`, with member details attached.
- `assignRideWithVersionCheck(...)`
  - In-memory optimistic concurrency helper for assignment; increments version on success.
- `reorderQueueAtomicallyWithVersionCheck(...)`
  - In-memory reorder + stale check helper; returns updated queue positions.
- `getRideServiceMinutes(ride)`
  - Baseline stop time + wheelchair buffer minutes.
- `optimizeDriverQueue({ rides, driverCoordinates, speedKmh })`
  - Filters to assigned rides with coordinates, seeds nearest-neighbor ordering, then improves route with 2-opt.

## Server internals of note (`server.js`)

- Session/auth utilities:
  - `resolveSession`, `requireSession`, `login`, `buildSessionCookie`, `signSessionId`, `timingSafeCompare`
- Role/authorization:
  - `requireRole`
- Supabase adapters:
  - `sbRequest`, `fetchUsers`, `fetchRides`, `fetchRideById`, `fetchDriverQueue`
- Ride mutation handlers:
  - `createRide`, `assignRide`, `cancelRide`, `reorderDriverQueue`, `autoAssign`
- Queue optimizer integration:
  - `optimizeAndPersistDriverQueues`
- Security:
  - `isSecureRequest`, `securityHeaders`

## Frontend workflow functions (`app.js`)

- Boot + hydration:
  - `boot`, `hydrateState`
- User actions:
  - `onCreateRideRequest`, `onAutoAssign`, `onSaveSettings`, `onSendBroadcast`
- Render pipeline:
  - `refreshAll`, `renderActorSelect`, `renderActorStatus`, `renderSelects`, `renderBoard`, `renderDriverQueue`, `renderAdminPanel`, `renderSettings`, `renderAuditLog`
- Access helpers:
  - `canRequestRide`, `canDrive`, `canDispatch`, `canManageUsers`, `isSuperAdmin`

---

## 5) Current operational stats coverage

The app does not currently expose a dedicated `/api/stats` endpoint, but it already supports the following **derived stats** from existing payloads and UI state.

## Ride demand and execution stats

Derived from `GET /api/rides`:

- Total rides
- Requested rides count
- Assigned rides count
- Cancelled rides count
- Assignment ratio (`assigned / total`)
- Cancellation ratio (`cancelled / total`)

## Driver utilization stats

Derived from rides + approved drivers from `GET /api/users`:

- Active drivers (approved volunteer drivers)
- Assigned rides per driver
- Driver load variance (max-min queue length)
- Unassigned requested rides (dispatch backlog)

## Queue quality/complexity stats

Derived from driver queue payload (`GET /api/drivers/:driverId/queue`) and ride fields:

- Stops per queue
- Count of rides with pickup windows
- Count of rides with wheelchair service buffer
- Predicted service minutes sum via `getRideServiceMinutes`

## Admin/audit stats (client-side)

Derived from `state.auditLogs` and user list:

- Number of audit entries by type
- Last broadcast timestamp
- Pending approvals count

> Recommendation: add `/api/stats/overview` as a server-generated aggregate endpoint for consistent dashboarding and alerting across clients.

---

## 6) Security and compliance notes

- Production transport security:
  - HTTPS redirect on insecure requests.
  - HSTS + strict CSP + anti-clickjacking headers.
- Session security:
  - Cookie is `HttpOnly`, `Secure`, `SameSite=Strict`.
  - Signature must match HMAC of `session_id`.
- Privilege enforcement:
  - Role checks performed per route.
- Secrets:
  - Environment-based secrets only; no browser exposure.
  - Email provider should be managed through Postmark credentials.

---

## 7) Architecture gaps and recommended next steps

1. **Centralized stats endpoint**
   - Add `/api/stats/overview` with explicit schema and historical snapshots.
2. **Persistent sessions**
   - Replace in-memory sessions with Redis or managed session store for horizontal scale.
3. **Notification abstraction**
   - Introduce `NotificationService` with Postmark as default email provider and optional SMS adapter.
4. **Audit persistence**
   - Move `state.auditLogs` from client-only to durable server-side audit trail.
5. **Role naming consistency**
   - Ensure role names remain aligned with canonical database enums (`member`, `volunteer_driver`, `volunteer_dispatcher`, `people_manager`, `super_admin`).

