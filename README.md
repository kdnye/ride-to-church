## Ride to Church (Supabase-backed MVP)

This app now runs as a lightweight Node server that serves the frontend and exposes a backend API layer for users/rides/assignments backed by Supabase Postgres.

### Environment variables

- `SUPABASE_URL`: Your project URL (e.g. `https://xyzcompany.supabase.co`)
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key used by the backend API layer
- `PORT` (optional): defaults to `4173`

### Run locally

```bash
npm start
```

### Database migrations

Run these in order inside Supabase SQL editor (or your migration runner):

1. `migrations/001_init_schema.sql`
2. `migrations/002_indexes.sql`
3. `migrations/003_dispatch_concurrency.sql`

### API surface (backend data-access layer)

- `GET /api/users`
- `GET /api/rides`
- `POST /api/rides`
- `POST /api/rides/auto-assign`
- `GET /api/drivers/:driverId/queue`
- `POST /api/rides/:rideId/assign` (optimistic concurrency via revision/updatedAt)
- `POST /api/drivers/:driverId/queue/reorder` (atomic queue reorder + concurrency checks)

The frontend consumes these endpoints through `src/apiClient.js` and uses optimistic updates with rollback for request creation + auto-assign.
