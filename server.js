import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { autoAssignRides, optimizeDriverQueue } from './logic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4173);
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 8);
const BOOTSTRAP_AUTH_TOKEN = process.env.BOOTSTRAP_AUTH_TOKEN;
const TRUST_PROXY = (process.env.TRUST_PROXY ?? 'true') === 'true';

const sessions = new Map();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SESSION_SECRET || !BOOTSTRAP_AUTH_TOKEN) {
  throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET, and BOOTSTRAP_AUTH_TOKEN are required.');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    if (!isSecureRequest(req)) {
      const host = req.headers.host;
      if (!host) return json(res, 400, { error: 'Host header required' });
      const redirect = `https://${host}${req.url}`;
      res.writeHead(308, { Location: redirect, ...securityHeaders() });
      res.end();
      return;
    }

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
  const url = new URL(req.url, `https://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    return login(res, body);
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = await resolveSession(req, res);
    if (!session) return;
    sessions.delete(session.id);
    return json(res, 200, { ok: true }, {
      'Set-Cookie': clearSessionCookie(),
    });
  }

  const session = await resolveSession(req, res);
  if (!session) return;

  if (req.method === 'GET' && url.pathname === '/api/users') {
    if (!requireRole(res, session, ['dispatcher', 'manager', 'admin'])) return;
    return json(res, 200, { users: await fetchUsers() });
  }
  if (req.method === 'GET' && url.pathname === '/api/rides') {
    if (!requireRole(res, session, ['member', 'volunteer_driver', 'dispatcher', 'manager', 'admin'])) return;
    return json(res, 200, { rides: await fetchRides() });
  }
  if (req.method === 'POST' && url.pathname === '/api/rides') {
    if (!requireRole(res, session, ['member', 'dispatcher', 'manager', 'admin'])) return;
    const body = await readJson(req);
    return json(res, 201, { ride: await createRide({ ...body, actorId: session.userId }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/rides/auto-assign') {
    if (!requireRole(res, session, ['dispatcher', 'manager', 'admin'])) return;
    const body = await readJson(req);
    return json(res, 200, await autoAssign(session.userId, body.maxRidesPerDriver ?? Infinity));
  }

  const assignMatch = url.pathname.match(/^\/api\/rides\/([^/]+)\/assign$/);
  if (req.method === 'POST' && assignMatch) {
    if (!requireRole(res, session, ['dispatcher', 'manager', 'admin'])) return;
    const body = await readJson(req);
    return assignRide(res, assignMatch[1], { ...body, actorId: session.userId });
  }

  const cancelMatch = url.pathname.match(/^\/api\/rides\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    if (!requireRole(res, session, ['dispatcher', 'manager', 'admin'])) return;
    const body = await readJson(req);
    return cancelRide(res, cancelMatch[1], { ...body, actorId: session.userId });
  }

  const reorderMatch = url.pathname.match(/^\/api\/drivers\/([^/]+)\/queue\/reorder$/);
  if (req.method === 'POST' && reorderMatch) {
    if (!requireRole(res, session, ['dispatcher', 'manager', 'admin'])) return;
    const body = await readJson(req);
    return reorderDriverQueue(res, reorderMatch[1], { ...body, actorId: session.userId });
  }

  const queueMatch = url.pathname.match(/^\/api\/drivers\/([^/]+)\/queue$/);
  if (req.method === 'GET' && queueMatch) {
    if (!requireRole(res, session, ['volunteer_driver', 'dispatcher', 'manager', 'admin'])) return;
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
  const rows = await sbRequest('/rest/v1/rides?select=id,member_id,scheduled_for,pickup_notes,status,updated_at,revision,wheelchair_pickup_buffer_minutes,pickup_window_start,pickup_window_end,ride_assignments(driver_id,queue_position)&order=scheduled_for.asc,created_at.asc');
  return rows.map((row) => ({
    id: row.id,
    memberId: row.member_id,
    scheduledFor: row.scheduled_for,
    pickupNotes: row.pickup_notes,
    status: row.status,
    updatedAt: row.updated_at,
    revision: row.revision,
    wheelchairPickupBufferMinutes: row.wheelchair_pickup_buffer_minutes ?? 0,
    pickupWindowStart: row.pickup_window_start ?? null,
    pickupWindowEnd: row.pickup_window_end ?? null,
    driverId: row.ride_assignments?.driver_id ?? null,
    queueOrder: row.ride_assignments?.queue_position ?? null,
  }));
}

async function createRide({ memberId, scheduledFor, pickupNotes, wheelchairPickupBufferMinutes, pickupWindowStart, pickupWindowEnd }) {
  if (!memberId || !scheduledFor) throw new Error('memberId and scheduledFor are required');
  const rows = await sbRequest('/rest/v1/rides', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      member_id: memberId,
      scheduled_for: scheduledFor,
      pickup_notes: pickupNotes ?? null,
      wheelchair_pickup_buffer_minutes: Math.max(0, Number(wheelchairPickupBufferMinutes) || 0),
      pickup_window_start: pickupWindowStart ?? null,
      pickup_window_end: pickupWindowEnd ?? null,
      status: 'requested',
    }),
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
    wheelchairPickupBufferMinutes: row.wheelchair_pickup_buffer_minutes ?? 0,
    pickupWindowStart: row.pickup_window_start ?? null,
    pickupWindowEnd: row.pickup_window_end ?? null,
  };
}

function requireRole(res, session, allowedRoles) {
  if (allowedRoles.includes(session.role)) return true;
  json(res, 403, { error: 'Forbidden for current role' });
  return false;
}



async function resolveSession(req, res) {
  if (NODE_ENV !== 'production') {
    return { userId: 'dev-admin', role: 'admin', approvalStatus: 'approved' };
  }
  return requireSession(req, res);
}
function requireSession(req, res) {
  const cookieHeader = req.headers.cookie;
  const sessionCookie = parseCookies(cookieHeader).session_id;
  const signature = req.headers['x-session-signature'];
  if (!sessionCookie || !signature || !timingSafeCompare(signSessionId(sessionCookie), signature)) {
    json(res, 401, { error: 'Authentication required' });
    return null;
  }

  const session = sessions.get(sessionCookie);
  if (!session || Date.now() > session.expiresAt) {
    sessions.delete(sessionCookie);
    json(res, 401, { error: 'Session expired' }, { 'Set-Cookie': clearSessionCookie() });
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { ...session, id: sessionCookie };
}

async function login(res, { bootstrapToken, userId }) {
  if (!bootstrapToken || bootstrapToken !== BOOTSTRAP_AUTH_TOKEN) {
    return json(res, 401, { error: 'Invalid bootstrap token' });
  }
  if (!userId) {
    return json(res, 400, { error: 'userId is required' });
  }

  const user = await fetchAuthUser(userId);
  if (!user || user.approval_status !== 'approved') {
    return json(res, 403, { error: 'User is not approved for system access' });
  }

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, {
    userId: user.id,
    role: user.role,
    approvalStatus: user.approval_status,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });

  return json(res, 200, {
    user: {
      id: user.id,
      role: user.role,
      approvalStatus: user.approval_status,
    },
    sessionSignature: signSessionId(sessionId),
    expiresInMs: SESSION_TTL_MS,
  }, {
    'Set-Cookie': buildSessionCookie(sessionId),
  });
}

async function fetchAuthUser(userId) {
  const rows = await sbRequest(`/rest/v1/users?id=eq.${userId}&select=id,role,approval_status&limit=1`);
  return rows[0] ?? null;
}

async function assignRide(res, rideId, { driverId, actorId, expectedRevision, expectedUpdatedAt }) {
  if (!driverId || Number.isNaN(Number(expectedRevision))) {
    return json(res, 400, { error: 'driverId and expectedRevision are required' });
  }

  const previousRide = await fetchRideById(rideId);

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

  const latestRide = await fetchRideById(rideId);
  await optimizeAndPersistDriverQueues([previousRide?.driverId, latestRide?.driverId]);

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

  await optimizeAndPersistDriverQueues([driverId]);
  return json(res, 200, { rides: await fetchRides(), queue: await fetchDriverQueue(driverId) });
}

async function fetchRideById(rideId) {
  const rows = await sbRequest(`/rest/v1/rides?id=eq.${rideId}&select=id,member_id,scheduled_for,pickup_notes,status,updated_at,revision,wheelchair_pickup_buffer_minutes,pickup_window_start,pickup_window_end,ride_assignments(driver_id,queue_position)&limit=1`);
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
    wheelchairPickupBufferMinutes: row.wheelchair_pickup_buffer_minutes ?? 0,
    pickupWindowStart: row.pickup_window_start ?? null,
    pickupWindowEnd: row.pickup_window_end ?? null,
    driverId: row.ride_assignments?.driver_id ?? null,
    queueOrder: row.ride_assignments?.queue_position ?? null,
  };
}

async function autoAssign(actorId, maxRidesPerDriver) {
  const users = await fetchUsers();
  const rides = await fetchRides();
  const assignments = autoAssignRides({ rides, users, maxRidesPerDriver });

  const touchedDriverIds = new Set();
  await Promise.all(rides
    .filter((r) => r.status === 'assigned' && r.driverId)
    .map(async (ride) => {
      touchedDriverIds.add(ride.driverId);
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

  await optimizeAndPersistDriverQueues([...touchedDriverIds]);
  return { assignments, rides: await fetchRides() };
}

async function fetchDriverQueue(driverId) {
  const rows = await sbRequest(`/rest/v1/ride_assignments?driver_id=eq.${driverId}&select=queue_position,driver:users!ride_assignments_driver_id_fkey(id,coordinates),ride:rides(id,member_id,scheduled_for,pickup_notes,status,wheelchair_pickup_buffer_minutes,pickup_window_start,pickup_window_end,member:users!rides_member_id_fkey(id,full_name,coordinates))&order=queue_position.asc`);

  return rows
    .filter((row) => row.ride?.status === 'assigned')
    .map((row) => ({
      id: row.ride.id,
      memberId: row.ride.member_id,
      scheduledFor: row.ride.scheduled_for,
      pickupNotes: row.ride.pickup_notes,
      status: row.ride.status,
      wheelchairPickupBufferMinutes: row.ride.wheelchair_pickup_buffer_minutes ?? 0,
      pickupWindowStart: row.ride.pickup_window_start ?? null,
      pickupWindowEnd: row.ride.pickup_window_end ?? null,
      queueOrder: row.queue_position,
      member: {
        id: row.ride.member.id,
        fullName: row.ride.member.full_name,
        coordinates: pointToCoordinates(row.ride.member.coordinates),
      },
    }));
}

async function cancelRide(res, rideId, { actorId, expectedRevision, expectedUpdatedAt }) {
  if (Number.isNaN(Number(expectedRevision))) {
    return json(res, 400, { error: 'expectedRevision is required' });
  }

  const current = await fetchRideById(rideId);
  if (!current) return json(res, 404, { error: 'Ride not found' });
  if (current.revision !== Number(expectedRevision)
    || (expectedUpdatedAt && current.updatedAt !== expectedUpdatedAt)) {
    return json(res, 409, {
      error: 'Ride was updated by another dispatcher. Please refresh and retry.',
      code: 'stale_ride_version',
      latestRide: current,
      rides: await fetchRides(),
    });
  }

  await sbRequest(`/rest/v1/rides?id=eq.${rideId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'cancelled' }),
  });
  await sbRequest(`/rest/v1/ride_assignments?ride_id=eq.${rideId}`, { method: 'DELETE' });

  await optimizeAndPersistDriverQueues([current.driverId]);
  return json(res, 200, { ride: await fetchRideById(rideId), rides: await fetchRides(), actorId: actorId ?? null });
}

async function optimizeAndPersistDriverQueues(driverIds) {
  const uniqueDriverIds = [...new Set((driverIds || []).filter(Boolean))];
  await Promise.all(uniqueDriverIds.map(async (driverId) => {
    const queue = await fetchDriverQueue(driverId);
    if (!queue.length) return;
    const driver = await fetchUserById(driverId);
    const optimized = optimizeDriverQueue({
      rides: queue,
      driverCoordinates: driver?.coordinates ?? null,
    });

    await Promise.all(optimized.map((ride) => sbRequest('/rest/v1/ride_assignments', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        ride_id: ride.id,
        driver_id: driverId,
        queue_position: ride.queueOrder,
      }),
    })));
  }));
}

async function fetchUserById(userId) {
  const rows = await sbRequest(`/rest/v1/users?id=eq.${userId}&select=id,coordinates&limit=1`);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, coordinates: pointToCoordinates(row.coordinates) };
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
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
    ...securityHeaders(),
  });
  res.end(body);
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders(),
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .reduce((acc, pair) => {
      const [key, ...rest] = pair.split('=');
      acc[key] = decodeURIComponent(rest.join('='));
      return acc;
    }, {});
}

function buildSessionCookie(sessionId) {
  return [
    `session_id=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Secure',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ].join('; ');
}

function clearSessionCookie() {
  return 'session_id=; HttpOnly; Path=/; SameSite=Strict; Secure; Max-Age=0';
}

function signSessionId(sessionId) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(sessionId)
    .digest('hex');
}

function timingSafeCompare(a, b) {
  const one = Buffer.from(a);
  const two = Buffer.from(b);
  if (one.length !== two.length) return false;
  return crypto.timingSafeEqual(one, two);
}

function isSecureRequest(req) {
  if (NODE_ENV !== 'production') return true;
  if (req.socket.encrypted) return true;
  if (!TRUST_PROXY) return false;
  return (req.headers['x-forwarded-proto'] ?? '').toString().split(',')[0].trim() === 'https';
}

function securityHeaders() {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
  };
}
