import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoAssignRides } from './logic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4173);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url.startsWith('/api/')) {
      await handleApi(req, res);
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Ride to Church listening on http://localhost:${PORT}`);
});

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/users') {
    return json(res, 200, { users: await fetchUsers() });
  }
  if (req.method === 'GET' && url.pathname === '/api/rides') {
    return json(res, 200, { rides: await fetchRides() });
  }
  if (req.method === 'POST' && url.pathname === '/api/rides') {
    const body = await readJson(req);
    return json(res, 201, { ride: await createRide(body) });
  }
  if (req.method === 'POST' && url.pathname === '/api/rides/auto-assign') {
    const body = await readJson(req);
    return json(res, 200, await autoAssign(body.actorId ?? null, body.maxRidesPerDriver ?? Infinity));
  }

  const assignMatch = url.pathname.match(/^\/api\/rides\/([^/]+)\/assign$/);
  if (req.method === 'POST' && assignMatch) {
    const body = await readJson(req);
    return assignRide(res, assignMatch[1], body);
  }

  const reorderMatch = url.pathname.match(/^\/api\/drivers\/([^/]+)\/queue\/reorder$/);
  if (req.method === 'POST' && reorderMatch) {
    const body = await readJson(req);
    return reorderDriverQueue(res, reorderMatch[1], body);
  }

  const queueMatch = url.pathname.match(/^\/api\/drivers\/([^/]+)\/queue$/);
  if (req.method === 'GET' && queueMatch) {
    return json(res, 200, { queue: await fetchDriverQueue(queueMatch[1]) });
  }

  return json(res, 404, { error: 'Not found' });
}

async function fetchUsers() {
  const rows = await sbRequest('/rest/v1/users?select=id,full_name,role,approval_status,approved_by,approved_at,coordinates&order=full_name.asc');
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    role: row.role,
    approval_status: row.approval_status,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    coordinates: pointToCoordinates(row.coordinates),
  }));
}

async function fetchRides() {
  const rows = await sbRequest('/rest/v1/rides?select=id,member_id,scheduled_for,pickup_notes,status,updated_at,revision,ride_assignments(driver_id,queue_position)&order=scheduled_for.asc,created_at.asc');
  return rows.map((row) => ({
    id: row.id,
    memberId: row.member_id,
    scheduledFor: row.scheduled_for,
    pickupNotes: row.pickup_notes,
    status: row.status,
    updatedAt: row.updated_at,
    revision: row.revision,
    driverId: row.ride_assignments?.driver_id ?? null,
    queueOrder: row.ride_assignments?.queue_position ?? null,
  }));
}

async function createRide({ memberId, scheduledFor, pickupNotes }) {
  if (!memberId || !scheduledFor) throw new Error('memberId and scheduledFor are required');
  const rows = await sbRequest('/rest/v1/rides', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ member_id: memberId, scheduled_for: scheduledFor, pickup_notes: pickupNotes ?? null, status: 'requested' }),
  });
  const row = rows[0];
  return {
    id: row.id,
    memberId: row.member_id,
    scheduledFor: row.scheduled_for,
    pickupNotes: row.pickup_notes,
    status: row.status,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

async function assignRide(res, rideId, { driverId, actorId, expectedRevision, expectedUpdatedAt }) {
  if (!driverId || Number.isNaN(Number(expectedRevision))) {
    return json(res, 400, { error: 'driverId and expectedRevision are required' });
  }

  const result = await sbRequest('/rest/v1/rpc/assign_ride_transactional', {
    method: 'POST',
    body: JSON.stringify({
      p_ride_id: rideId,
      p_driver_id: driverId,
      p_actor_id: actorId ?? null,
      p_expected_revision: Number(expectedRevision),
      p_expected_updated_at: expectedUpdatedAt ?? null,
    }),
  });

  const row = result[0];
  if (row?.conflict) {
    return json(res, 409, {
      error: 'Ride was updated by another dispatcher. Please refresh and retry.',
      code: row.conflict_reason,
      latestRide: await fetchRideById(rideId),
      rides: await fetchRides(),
    });
  }

  return json(res, 200, { ride: await fetchRideById(rideId), rides: await fetchRides() });
}

async function reorderDriverQueue(res, driverId, { rideId, newPosition, actorId, expectedRevision, expectedUpdatedAt }) {
  if (!rideId || Number.isNaN(Number(newPosition)) || Number.isNaN(Number(expectedRevision))) {
    return json(res, 400, { error: 'rideId, newPosition, and expectedRevision are required' });
  }

  const result = await sbRequest('/rest/v1/rpc/reorder_driver_queue_transactional', {
    method: 'POST',
    body: JSON.stringify({
      p_driver_id: driverId,
      p_ride_id: rideId,
      p_new_position: Number(newPosition),
      p_actor_id: actorId ?? null,
      p_expected_revision: Number(expectedRevision),
      p_expected_updated_at: expectedUpdatedAt ?? null,
    }),
  });

  const row = result[0];
  if (row?.conflict) {
    return json(res, 409, {
      error: 'Queue changed before your move was applied. Board was refreshed.',
      code: row.conflict_reason,
      latestRide: await fetchRideById(rideId),
      rides: await fetchRides(),
    });
  }

  return json(res, 200, { rides: await fetchRides(), queue: await fetchDriverQueue(driverId) });
}

async function fetchRideById(rideId) {
  const rows = await sbRequest(`/rest/v1/rides?id=eq.${rideId}&select=id,member_id,scheduled_for,pickup_notes,status,updated_at,revision,ride_assignments(driver_id,queue_position)&limit=1`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    memberId: row.member_id,
    scheduledFor: row.scheduled_for,
    pickupNotes: row.pickup_notes,
    status: row.status,
    updatedAt: row.updated_at,
    revision: row.revision,
    driverId: row.ride_assignments?.driver_id ?? null,
    queueOrder: row.ride_assignments?.queue_position ?? null,
  };
}

async function autoAssign(actorId, maxRidesPerDriver) {
  const users = await fetchUsers();
  const rides = await fetchRides();
  const assignments = autoAssignRides({ rides, users, maxRidesPerDriver });

  await Promise.all(rides
    .filter((r) => r.status === 'assigned' && r.driverId)
    .map(async (ride) => {
      await sbRequest(`/rest/v1/rides?id=eq.${ride.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'assigned' }),
      });

      await sbRequest('/rest/v1/ride_assignments', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          ride_id: ride.id,
          driver_id: ride.driverId,
          queue_position: ride.queueOrder,
          assigned_by: actorId,
        }),
      });
    }));

  return { assignments, rides: await fetchRides() };
}

async function fetchDriverQueue(driverId) {
  const rows = await sbRequest(`/rest/v1/ride_assignments?driver_id=eq.${driverId}&select=queue_position,ride:rides(id,member_id,scheduled_for,pickup_notes,status,member:users!rides_member_id_fkey(id,full_name,coordinates))&order=queue_position.asc`);

  return rows
    .filter((row) => row.ride?.status === 'assigned')
    .map((row) => ({
      id: row.ride.id,
      memberId: row.ride.member_id,
      scheduledFor: row.ride.scheduled_for,
      pickupNotes: row.ride.pickup_notes,
      status: row.ride.status,
      queueOrder: row.queue_position,
      member: {
        id: row.ride.member.id,
        fullName: row.ride.member.full_name,
        coordinates: pointToCoordinates(row.ride.member.coordinates),
      },
    }));
}

function pointToCoordinates(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
  if (!match) return null;
  return { lon: Number(match[1]), lat: Number(match[2]) };
}

async function sbRequest(endpoint, options = {}) {
  const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message ?? `Supabase request failed (${response.status})`);
  }
  return data;
}

async function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url;
  const safePath = path.normalize(requestPath).replace(/^\.\.(\/|\\|$)/, '');
  const fullPath = path.join(__dirname, safePath);
  const ext = path.extname(fullPath);
  const body = await readFile(fullPath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
  res.end(body);
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
