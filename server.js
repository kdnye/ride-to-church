import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { autoAssignRides, optimizeDriverQueue } from './logic.js';
import { getNewlyAssignedRidesForPersistence } from './src/autoAssignPersistence.js';
import { canAccessDriverQueue } from './src/authz.js';
import { getRouteMatrixDurationsSeconds } from './src/services/routing/googleRoutesMatrix.js';
import { buildTravelTimeLookup } from './src/services/routing/travelTimeCache.js';
import { buildMemberDriverTravelTimes as buildMemberDriverTravelTimesFromMatrix } from './src/services/routing/memberDriverTravelTimes.js';
import {
  createSession,
  deleteExpiredSessions,
  deleteSessionsByUserId,
  deleteSessionById,
  extendSessionExpiry,
  fetchSessionById,
  sbRequest,
} from './src/supabaseClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distRoot = path.join(__dirname, 'dist');
const sourceRoot = path.join(__dirname);
const NODE_ENV = process.env.NODE_ENV ?? 'development';
const hasDistBuild = existsSync(path.join(distRoot, 'index.html'));
if (NODE_ENV === 'production' && !hasDistBuild) {
  throw new Error('Production build requires dist/ assets. Run `npm run build:client` during image build.');
}
const publicRoot = hasDistBuild ? distRoot : sourceRoot;
const FALLBACK_PUBLIC_FILES = new Set([
  'index.html',
  'app.js',
  'styles.css',
  'logic.js',
  'src/apiClient.js',
  'src/geolocation.js',
]);
const FALLBACK_PUBLIC_DIRS = ['assets', 'public', 'images', 'fonts']
  .filter((dir) => existsSync(path.join(sourceRoot, dir)));
const PORT = Number(process.env.PORT || 4173);
const SESSION_SECRET = process.env.SESSION_SECRET;
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 8);
const SESSION_EXTEND_THRESHOLD_MS = Number(process.env.SESSION_EXTEND_THRESHOLD_MS || 1000 * 60 * 30);
const SESSION_CLEANUP_INTERVAL_MS = Number(process.env.SESSION_CLEANUP_INTERVAL_MS || 1000 * 60 * 15);
const TRUST_PROXY = (process.env.TRUST_PROXY ?? 'true') === 'true';
const ALLOW_DEV_AUTH_BYPASS = (process.env.ALLOW_DEV_AUTH_BYPASS ?? 'false') === 'true';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const ENABLE_ROUTE_MATRIX = (process.env.ENABLE_ROUTE_MATRIX ?? 'true') === 'true';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? '';
const POSTGRES_INT_MAX = 2147483647;
const MAX_RIDES_PER_DRIVER = readPositiveIntEnv('MAX_RIDES_PER_DRIVER', POSTGRES_INT_MAX);

if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required.');
}

const VALID_USER_ROLES = new Set(['member', 'volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin']);
const VALID_APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'deactivated']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, POSTGRES_INT_MAX);
}

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
    if (error?.status) {
      return json(res, error.status, { error: error.message, ...(error.details ? { details: error.details } : {}) });
    }
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Ride to Church listening on http://localhost:${PORT}`);
  if (!hasDistBuild) {
    console.warn('[static] Dist build not found; running in source fallback mode with strict asset allowlist.');
    console.warn(`[static] Allowed files: ${Array.from(FALLBACK_PUBLIC_FILES).join(', ')}`);
    if (FALLBACK_PUBLIC_DIRS.length > 0) {
      console.warn(`[static] Allowed directories: ${FALLBACK_PUBLIC_DIRS.join(', ')}`);
    }
  }
});

scheduleExpiredSessionCleanup();

async function handleApi(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/public-config') {
    return json(res, 200, {
      supabaseUrl: SUPABASE_URL || null,
      supabaseAnonKey: SUPABASE_ANON_KEY || null,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req);
    return login(res, body);
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const body = await readJson(req);
    return registerUser(res, body);
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const session = await resolveSession(req, res);
    if (!session) return;
    await deleteSessionById(session.id);
    return json(res, 200, { ok: true }, {
      'Set-Cookie': clearSessionCookie(),
    });
  }

  const session = await resolveSession(req, res);
  if (!session) return;

  if (req.method === 'GET' && url.pathname === '/api/users') {
    if (!requireRole(res, session, ['member', 'volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    return json(res, 200, { users: await fetchUsers() });
  }

  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === 'PATCH' && userMatch) {
    if (!requireRole(res, session, ['people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    return updateUser(res, userMatch[1], body);
  }
  if (req.method === 'GET' && url.pathname === '/api/rides') {
    if (!requireRole(res, session, ['member', 'volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    return json(res, 200, { rides: await fetchRides() });
  }

  if (req.method === 'GET' && url.pathname === '/api/destinations') {
    if (!requireRole(res, session, ['member', 'volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    return json(res, 200, { destinations: await fetchDestinations() });
  }

  if (req.method === 'POST' && url.pathname === '/api/destinations') {
    if (!requireRole(res, session, ['people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    try {
      return json(res, 201, await createDestination(body));
    } catch (error) {
      if (error?.status === 400) {
        return json(res, 400, { error: error.message });
      }
      throw error;
    }
  }

  const destinationMatch = url.pathname.match(/^\/api\/destinations\/([^/]+)$/);
  if (req.method === 'DELETE' && destinationMatch) {
    if (!requireRole(res, session, ['people_manager', 'super_admin'])) return;
    await deleteDestination(destinationMatch[1]);
    return json(res, 200, { success: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/rides') {
    if (!requireRole(res, session, ['member', 'volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    try {
      const ride = await createRide({ ...body, actorId: session.userId });
      return json(res, 201, { ride });
    } catch (error) {
      if (isActiveRideConflict(error)) {
        return json(res, 409, { error: 'Active ride already exists for that date' });
      }
      throw error;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/rides/auto-assign') {
    if (!requireRole(res, session, ['volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    return json(res, 200, await autoAssign(
      session.userId,
      body.maxRidesPerDriver ?? Infinity,
      body.destinationCoordinates ?? null,
    ));
  }

  const assignMatch = url.pathname.match(/^\/api\/rides\/([^/]+)\/assign$/);
  if (req.method === 'POST' && assignMatch) {
    if (!requireRole(res, session, ['volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    return assignRide(res, assignMatch[1], { ...body, actorId: session.userId });
  }

  const cancelMatch = url.pathname.match(/^\/api\/rides\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    if (!requireRole(res, session, ['volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    return cancelRide(res, cancelMatch[1], { ...body, actorId: session.userId });
  }

  const reorderMatch = url.pathname.match(/^\/api\/drivers\/([^/]+)\/queue\/reorder$/);
  if (req.method === 'POST' && reorderMatch) {
    if (!requireRole(res, session, ['volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    const body = await readJson(req);
    return reorderDriverQueue(res, reorderMatch[1], { ...body, actorId: session.userId });
  }

  const queueMatch = url.pathname.match(/^\/api\/drivers\/([^/]+)\/queue$/);
  if (req.method === 'GET' && queueMatch) {
    if (!requireRole(res, session, ['volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin'])) return;
    const requestedDriverId = queueMatch[1];
    if (!canAccessDriverQueue(session, requestedDriverId)) {
      return json(res, 403, { error: 'Forbidden for current role' });
    }
    return json(res, 200, { queue: await fetchDriverQueue(requestedDriverId) });
  }

  return json(res, 404, { error: 'Not found' });
}

async function fetchUsers() {
  // Added ::text to the coordinates selection
  const rows = await sbRequest('/rest/v1/users?select=id,full_name,email,role,approval_status,approved_by,approved_at,coordinates::text&order=full_name.asc');
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email ?? null,
    role: row.role,
    approvalStatus: row.approval_status ?? row.approvalStatus ?? null,
    approval_status: row.approval_status ?? row.approvalStatus ?? null,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    coordinates: pointToCoordinates(row.coordinates),
  }));
}

async function fetchRides() {
  // Added ::text to the embedded member coordinates selection
  const rows = await sbRequest('/rest/v1/rides?select=id,member_id,scheduled_for,pickup_notes,status,updated_at,revision,wheelchair_pickup_buffer_minutes,pickup_window_start,pickup_window_end,ride_assignments(driver_id,queue_position,travel_time_seconds,estimated_arrival_time,route_polyline),member:users!rides_member_id_fkey(id,full_name,coordinates::text)&order=scheduled_for.asc');

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
    
    driverId: row.ride_assignments?.[0]?.driver_id ?? null,
    queueOrder: row.ride_assignments?.[0]?.queue_position ?? null,
    travelTimeSeconds: row.ride_assignments?.[0]?.travel_time_seconds ?? null,
    estimatedArrival: row.ride_assignments?.[0]?.estimated_arrival_time ?? null,
    routePolyline: row.ride_assignments?.[0]?.route_polyline ?? null,
    
    member: {
      id: row.member?.id,
      fullName: row.member?.full_name,
      coordinates: pointToCoordinates(row.member?.coordinates),
    },
  }));
}

async function fetchDestinations() {
  const rows = await sbRequest('/rest/v1/destinations?select=id,name,address,coordinates,created_at&order=name.asc');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    address: row.address,
    coordinates: normalizeDestinationCoordinates(row.coordinates),
    createdAt: row.created_at,
  }));
}

async function createDestination({ name, address, coordinates }) {
  const sanitizedName = `${name ?? ''}`.trim();
  const sanitizedAddress = `${address ?? ''}`.trim();
  const normalizedCoordinates = normalizeDestinationCoordinates(coordinates);

  if (!sanitizedName || !sanitizedAddress) {
    throw badRequest('name and address are required');
  }

  if (!Number.isFinite(normalizedCoordinates?.lat) || !Number.isFinite(normalizedCoordinates?.lon)) {
    throw badRequest('coordinates.lat and coordinates.lon are required numeric values');
  }

  const rows = await sbRequest('/rest/v1/destinations', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      name: sanitizedName,
      address: sanitizedAddress,
      coordinates: normalizedCoordinates,
    }),
  });

  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    coordinates: normalizeDestinationCoordinates(row.coordinates),
    createdAt: row.created_at,
  };
}

async function deleteDestination(destinationId) {
  await sbRequest(`/rest/v1/destinations?id=eq.${encodeURIComponent(destinationId)}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
}

function normalizeDestinationCoordinates(coordinates) {
  if (!coordinates || typeof coordinates !== 'object') return null;
  const lat = Number(coordinates.lat);
  const lon = Number(coordinates.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function isActiveRideConflict(error) {
  return error?.status === 409 && error?.code === '23505';
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
  if (ALLOW_DEV_AUTH_BYPASS && NODE_ENV === 'development') {
    return { userId: 'dev-admin', role: 'super_admin', approvalStatus: 'approved' };
  }
  return requireSession(req, res);
}
async function requireSession(req, res) {
  const cookieHeader = req.headers.cookie;
  const sessionCookie = parseCookies(cookieHeader).session_id;
  const signature = req.headers['x-session-signature'];
  if (!sessionCookie || !signature || !timingSafeCompare(signSessionId(sessionCookie), signature)) {
    json(res, 401, { error: 'Authentication required' }, { 'Set-Cookie': clearSessionCookie() });
    return null;
  }

  const session = await fetchSessionById(sessionCookie);
  const now = Date.now();
  if (!session || now > Date.parse(session.expires_at)) {
    await deleteSessionById(sessionCookie);
    json(res, 401, { error: 'Session expired' }, { 'Set-Cookie': clearSessionCookie() });
    return null;
  }

  const nextExpiryMs = now + SESSION_TTL_MS;
  const currentExpiryMs = Date.parse(session.expires_at);
  if ((currentExpiryMs - now) <= SESSION_EXTEND_THRESHOLD_MS) {
    extendSessionExpiry({
      sessionId: sessionCookie,
      expiresAt: new Date(nextExpiryMs).toISOString(),
    }).catch((error) => {
      console.error('Failed to extend session TTL', error);
    });
  }

  return {
    id: session.id,
    userId: session.user_id,
    role: session.role,
    approvalStatus: session.approval_status,
  };
}

async function login(res, { email, password }) {
  if (!email || !password) {
    return json(res, 400, { error: 'Email and password are required' });
  }

  const rows = await sbRequest('/rest/v1/rpc/verify_user_password', {
    method: 'POST',
    body: JSON.stringify({ p_email: email, p_password: password })
  });

  const user = rows[0];
  if (!user) {
    return json(res, 401, { error: 'Invalid credentials' });
  }
  if (user.approval_status !== 'approved') {
    return json(res, 403, { error: 'Account pending admin approval' });
  }

  const sessionId = crypto.randomUUID();
  await createSession({
    id: sessionId,
    userId: user.id,
    role: user.role,
    approvalStatus: user.approval_status,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
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

async function registerUser(res, { fullName, email, password, phone }) {
  if (!email || !password || !fullName) return json(res, 400, { error: 'Required fields missing' });

  try {
    await sbRequest('/rest/v1/rpc/register_user', {
      method: 'POST',
      body: JSON.stringify({ p_full_name: fullName, p_email: email, p_password: password, p_phone: phone || null })
    });
    return json(res, 201, { message: 'Registration successful.' });
  } catch (error) {
    return json(res, 409, { error: 'Registration failed. Email may already exist.' });
  }
}

async function updateUser(res, targetUserId, { role, approval_status }) {
  const updates = {};

  if (role !== undefined) {
    if (!VALID_USER_ROLES.has(role)) {
      return json(res, 400, { error: 'Invalid role value' });
    }
    updates.role = role;
  }

  if (approval_status !== undefined) {
    if (!VALID_APPROVAL_STATUSES.has(approval_status)) {
      return json(res, 400, { error: 'Invalid approval_status value' });
    }
    updates.approval_status = approval_status;
  }

  if (!Object.keys(updates).length) {
    return json(res, 400, { error: 'At least one update field is required' });
  }

  await sbRequest(`/rest/v1/users?id=eq.${targetUserId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(updates),
  });

  await deleteSessionsByUserId(targetUserId);
  return json(res, 200, { ok: true });
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
      p_max_rides_per_driver: MAX_RIDES_PER_DRIVER,
      p_expected_revision: Number(expectedRevision),
      p_expected_updated_at: expectedUpdatedAt ?? null,
    }),
  });

  const row = result[0];
  if (row?.conflict) {
    const conflictMessage = row.conflict_reason === 'driver_at_capacity'
      ? 'Selected driver is at capacity. Choose another driver or increase the ride limit.'
      : 'Ride was updated by another dispatcher. Please refresh and retry.';
    return json(res, 409, {
      error: conflictMessage,
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
  const rows = await sbRequest(`/rest/v1/rides?id=eq.${rideId}&select=id,member_id,scheduled_for,pickup_notes,status,updated_at,revision,wheelchair_pickup_buffer_minutes,pickup_window_start,pickup_window_end,ride_assignments(driver_id,queue_position,travel_time_seconds,estimated_arrival_time,route_polyline)&limit=1`);
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
    travelTimeSeconds: row.ride_assignments?.travel_time_seconds ?? null,
    estimatedArrival: row.ride_assignments?.estimated_arrival_time ?? null,
    routePolyline: row.ride_assignments?.route_polyline ?? null,
  };
}


async function buildMemberDriverTravelTimes(rides, users) {
  return buildMemberDriverTravelTimesFromMatrix({
    rides,
    users,
    apiKey: GOOGLE_MAPS_API_KEY,
    routeMatrixEnabled: ENABLE_ROUTE_MATRIX,
    getRouteMatrixDurationsSeconds,
  });
}

async function hydrateDriverTravelTimes(driverCoordinates, queue) {
  if (!ENABLE_ROUTE_MATRIX || !GOOGLE_MAPS_API_KEY) return;
  const origins = [];
  if (driverCoordinates) origins.push(driverCoordinates);
  queue.forEach((ride) => {
    if (ride.member?.coordinates) origins.push(ride.member.coordinates);
  });

  const destinations = queue
    .map((ride) => ride.member?.coordinates)
    .filter(Boolean);

  if (!origins.length || !destinations.length) return;
  await getRouteMatrixDurationsSeconds({
    origins,
    destinations,
    apiKey: GOOGLE_MAPS_API_KEY,
  });
}

async function autoAssign(actorId, maxRidesPerDriver, destinationCoordinates) {
  const users = await fetchUsers();
  const rides = await fetchRides();
  const travelTimeSecondsByMemberDriver = await buildMemberDriverTravelTimes(rides, users);
  const assignments = autoAssignRides({
    rides,
    users,
    maxRidesPerDriver,
    travelTimeSecondsByMemberDriver,
  });

  const ridesToPersist = getNewlyAssignedRidesForPersistence({ rides, assignments });
  const touchedDriverIds = new Set();
  await Promise.all(ridesToPersist
    .map(async (ride) => {
      touchedDriverIds.add(ride.driverId);
      await sbRequest(`/rest/v1/rides?id=eq.${ride.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
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
          travel_time_seconds: ride.travelTimeSeconds ?? null,
          estimated_arrival_time: ride.estimatedArrival ?? null,
          route_polyline: ride.routePolyline ?? null,
        }),
      });
    }));

  await optimizeAndPersistDriverQueues([...touchedDriverIds], destinationCoordinates);
  return { assignments, rides: await fetchRides() };
}

async function fetchDriverQueue(driverId) {
  // Added ::text to the driver and member embedded coordinates
  const rows = await sbRequest(`/rest/v1/ride_assignments?driver_id=eq.${driverId}&select=queue_position,travel_time_seconds,estimated_arrival_time,route_polyline,driver:users!ride_assignments_driver_id_fkey(id,coordinates::text),ride:rides(id,member_id,scheduled_for,pickup_notes,status,wheelchair_pickup_buffer_minutes,pickup_window_start,pickup_window_end,member:users!rides_member_id_fkey(id,full_name,coordinates::text))&order=queue_position.asc`);

  return rows
    .filter((row) => row.ride?.status === 'assigned')
    .map((row) => ({
      id: row.ride.id,
      memberId: row.ride.member_id,
      scheduledFor: row.ride.scheduled_for,
      pickupNotes: row.ride.pickup_notes,
      status: row.ride.status,
      wheelchairPickupBufferMinutes: row.ride.wheelchair_pickup_buffer_minutes ?? 0,
      pickupWindowStart: row.pickup_window_start ?? null,
      pickupWindowEnd: row.pickup_window_end ?? null,
      queueOrder: row.queue_position,
      travelTimeSeconds: row.travel_time_seconds ?? null,
      estimatedArrival: row.estimated_arrival_time ?? null,
      routePolyline: row.route_polyline ?? null,
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

async function optimizeAndPersistDriverQueues(driverIds, destinationCoordinates) {
  const uniqueDriverIds = [...new Set((driverIds || []).filter(Boolean))];
  await Promise.all(uniqueDriverIds.map(async (driverId) => {
    const queue = await fetchDriverQueue(driverId);
    if (!queue.length) return;
    const driver = await fetchUserById(driverId);
    const driverCoordinates = driver?.coordinates ?? null;

    await hydrateDriverTravelTimes(driverCoordinates, queue);
    const travelTimeLookup = buildTravelTimeLookup();

    const optimized = optimizeDriverQueue({
      rides: queue,
      driverCoordinates,
      destinationCoordinates,
      travelTimeLookup,
    });

    let current = driverCoordinates;
    for (const ride of optimized) {
      const next = ride.member?.coordinates;
      const travelTimeSeconds = next ? travelTimeLookup(current, next) : null;
      current = next ?? current;

      await sbRequest('/rest/v1/ride_assignments', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          ride_id: ride.id,
          driver_id: driverId,
          queue_position: ride.queueOrder,
          travel_time_seconds: Number.isFinite(travelTimeSeconds) ? Math.round(travelTimeSeconds) : null,
          estimated_arrival_time: ride.estimatedArrival ?? null,
          route_polyline: ride.routePolyline ?? null,
        }),
      });
    }
  }));
}

async function fetchUserById(userId) {
  // Added ::text to the coordinates selection
  const rows = await sbRequest(`/rest/v1/users?id=eq.${userId}&select=id,coordinates::text&limit=1`);
  const row = rows[0];
  if (!row) return null;
  return { id: row.id, coordinates: pointToCoordinates(row.coordinates) };
}

function pointToCoordinates(value) {
  if (!value) return null;

  // Failsafe: Catch stringified JSON objects
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { value = JSON.parse(value); } catch (e) {}
  }

  let lat, lon;

  // --- Phase 1: Extraction ---
  if (typeof value === 'string') {
    const str = value.trim();
    
    // NEW: Check for PostGIS Binary Hex String (50 chars for a 2D Point)
    if (/^[0-9A-Fa-f]{50}$/.test(str)) {
      try {
        const buffer = Buffer.from(str, 'hex');
        const isLittleEndian = buffer[0] === 1;
        // Float values are 8 bytes long. Lon starts at byte 9, Lat starts at byte 17
        lon = isLittleEndian ? buffer.readDoubleLE(9) : buffer.readDoubleBE(9);
        lat = isLittleEndian ? buffer.readDoubleLE(17) : buffer.readDoubleBE(17);
      } catch (e) {
        console.error("Failed to parse Hex coordinates:", e);
      }
    } 
    // Legacy WKT string fallback
    else {
      const match = str.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
      if (match) {
        lon = match[1];
        lat = match[2];
      }
    }
  } 
  else if (typeof value === 'object' && value !== null) {
    if (value.type === 'Point' && Array.isArray(value.coordinates)) {
      // GeoJSON Point
      [lon, lat] = value.coordinates;
    } else if ('lat' in value && 'lon' in value) {
      // Plain object
      lat = value.lat;
      lon = value.lon;
    }
  }

  // --- Phase 2: Validation ---
  const numLat = Number(lat);
  const numLon = Number(lon);

  if (Number.isFinite(numLat) && Number.isFinite(numLon)) {
    return { lat: numLat, lon: numLon };
  }

  return null;
}

function scheduleExpiredSessionCleanup() {
  const runCleanup = () => {
    deleteExpiredSessions().catch((error) => {
      console.error('Failed to cleanup expired sessions', error);
    });
  };

  runCleanup();
  const timer = setInterval(runCleanup, SESSION_CLEANUP_INTERVAL_MS);
  timer.unref?.();
}

async function serveStatic(req, res) {
  const rawPath = req.url === '/' ? '/index.html' : req.url ?? '/index.html';
  const pathWithoutQuery = rawPath.split('#')[0].split('?')[0];

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathWithoutQuery);
  } catch {
    return json(res, 400, { error: 'Invalid URL path encoding' });
  }

  const slashNormalizedPath = decodedPath.replace(/\\/g, '/');
  if (slashNormalizedPath.split('/').includes('..')) {
    return json(res, 403, { error: 'Forbidden' });
  }

  const normalizedPath = path.posix.normalize(slashNormalizedPath);
  const relativePath = normalizedPath.replace(/^\/+/, '');

  if (!hasDistBuild && !isAllowedFallbackAsset(relativePath)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  const fullPath = path.resolve(publicRoot, relativePath);
  if (!fullPath.startsWith(publicRoot + path.sep)) {
    return json(res, 403, { error: 'Forbidden' });
  }

  try {
    const ext = path.extname(fullPath);
    const body = await readFile(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      ...securityHeaders(),
    });
    res.end(body);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') {
      return json(res, 404, { error: 'Not found' });
    }
    throw error;
  }
}

function isAllowedFallbackAsset(relativePath) {
  if (FALLBACK_PUBLIC_FILES.has(relativePath)) {
    return true;
  }

  return FALLBACK_PUBLIC_DIRS.some((dir) => {
    return relativePath === dir || relativePath.startsWith(`${dir}/`);
  });
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
  if (chunks.length === 0) return {};

  const bodyText = Buffer.concat(chunks).toString('utf8').trim();
  if (!bodyText) return {};

  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const parseError = badRequest(`Malformed JSON payload: ${error.message}`);
    parseError.details = { bodyText };
    throw parseError;
  }
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self' wss: https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
    'Cache-Control': 'no-store',
  };
}
