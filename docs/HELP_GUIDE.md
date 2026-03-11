# Ride to Church — Tiered Help Guide by User Type

This guide explains exactly how each role should use the app today.

## Before you begin (all users)

1. Confirm your account is approved.
2. Sign in with your email and password. New registrations remain pending until approved by an admin.
3. Verify your role from the **Session User** card.
4. If your role is wrong or pending, contact a people manager or super admin.

---

## Tier 1: Members (request riders)

### What you can do

- Create ride requests.
- View requested/assigned outcomes on the board.

### How to request a ride

1. In **Session User**, choose your account.
2. Open **Member Request**.
3. Select your name in **Member**.
4. Choose pickup date.
5. Add pickup notes (gate code, apartment, etc.).
6. Click **Create Ride Request**.

### Tips for best results

- Use clear, short pickup notes.
- Submit requests early so dispatch can balance routes.
- If your pickup requires extra time, ensure dispatcher knows your mobility needs.

### If something goes wrong

- “Only approved members can request rides.” → account approval is pending.
- “Ride request failed …” → temporary API/data issue; retry and notify dispatcher.

---

## Tier 2: Volunteer Drivers

### What you can do

- View your queue in **Driver Mobile View**.
- Start navigation for each stop.

### How to run your queue

1. Switch to your driver account in **Session User**.
2. In **Driver Mobile View**, choose your name in **Driver**.
3. Review ordered stops.
4. Click **Start navigation** for each stop as you progress.

### Operational guidance

- Follow queue order unless dispatcher gives explicit changes.
- Watch pickup notes for access constraints.
- Communicate delays quickly so dispatch can adjust assignments.

### If something goes wrong

- “Only approved drivers can access this queue.” → approval/role issue.
- “Failed to load queue …” → API issue; refresh and report if persistent.

---

## Tier 3: Volunteer Dispatchers

### What you can do

- Run auto-assignment.
- Monitor requested vs assigned rides.

### Auto-assign workflow

1. Switch actor to your dispatcher account.
2. Open **Dispatcher Board**.
3. Click **Run Auto-Assign**.
4. Validate the assignment message and review **Assigned Rides**.

### Dispatch best practices

- Re-run auto-assign after new requests arrive.
- Monitor driver workload to avoid overload.
- Coordinate manually when special constraints are known (time windows, mobility).

### Conflict handling

If you encounter stale update errors (409 conflicts), refresh board state and retry based on latest ride version.

---

## Tier 4: People Managers

### What you can do

- Everything dispatchers can do.
- View pending users in **Admin /users**.

### User governance flow

1. Use your manager account.
2. Open **Admin /users**.
3. Review pending approvals and coordinate with leadership for decisions.

> Current UI displays pending users; full approve/deny write actions are reserved for backend-admin expansion.

---

## Tier 5: Super Admins

### What you can do

- Full dispatch/manager capabilities.
- Configure global settings.
- Send emergency broadcast drafts.

### Settings workflow

1. Open **Super Admin Settings**.
2. Set **Max rides per driver**.
3. Maintain **Emergency broadcast draft**.
4. Click **Save Settings**.

### Broadcast workflow

1. Confirm emergency message text.
2. Click **Send Broadcast**.
3. Confirm timestamped success status.

### Notification provider policy

- Email communications are controlled via **Postmark**.
- Keep Postmark API credentials in server secret storage only.

---

## Quick troubleshooting matrix

- **Can’t see admin/super-admin panels**
  - Cause: wrong role or approval status.
  - Fix: verify actor selection and account approval.
- **No drivers in dropdown**
  - Cause: no approved `volunteer_driver` users.
  - Fix: complete approvals and ensure coordinates are set.
- **Auto-assign says no rides available**
  - Cause: no `requested` rides or all drivers at capacity.
  - Fix: adjust max rides per driver or assign manually.
- **Queue order looks odd after updates**
  - Cause: optimization/reorder just ran.
  - Fix: reload queue and use latest ordering as source of truth.

---

## Operational playbook by shift

- **Before service day**: validate approvals, driver availability, and max rides setting.
- **During dispatch window**: process new requests, run auto-assign iteratively, monitor queue health.
- **During active pickups**: track driver delays and adjust assignments if needed.
- **After service**: review audit timeline and unresolved operational issues.

