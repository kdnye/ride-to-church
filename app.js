import { autoAssignRides, nearestDrivers } from './logic.js';
import { createClient } from '@supabase/supabase-js';
import { apiClient } from './src/apiClient.js';

const SETTINGS_STORAGE_KEY = 'rtc-settings-v3';

const defaultState = {
  users: [],
  rides: [],
  settings: {
    maxRidesPerDriver: 3,
    emergencyBroadcastDraft: '',
    lastBroadcastAt: null,
    lastBroadcastBy: null,
  },
  auditLogs: [],
};

const state = {
  ...defaultState,
  settings: loadSettings(),
};

const actorSelect = document.querySelector('#actor-select');
const actorStatus = document.querySelector('#actor-status');
const memberSelect = document.querySelector('#member-select');
const driverSelect = document.querySelector('#driver-select');
const requestedRides = document.querySelector('#requested-rides');
const assignedRides = document.querySelector('#assigned-rides');
const driverQueue = document.querySelector('#driver-queue');
const assignResult = document.querySelector('#assign-result');
const requestForm = document.querySelector('#request-form');
const autoAssignBtn = document.querySelector('#auto-assign-btn');
const adminPanel = document.querySelector('#admin-users');
const pendingUsersEl = document.querySelector('#pending-users');
const adminHint = document.querySelector('#admin-hint');
const maxRidesInput = document.querySelector('#max-rides-per-driver');
const broadcastDraft = document.querySelector('#broadcast-draft');
const broadcastStatus = document.querySelector('#broadcast-status');
const auditLogEl = document.querySelector('#audit-log');

const ROLE_LABELS = {
  member: 'Member',
  volunteer_driver: 'Volunteer Driver',
  volunteer_dispatcher: 'Volunteer Dispatcher',
  people_manager: 'People Manager',
  super_admin: 'Super Admin',
};

const BOARD_RELEVANT_STATUSES = new Set(['requested', 'assigned', 'cancelled']);
const REALTIME_REFRESH_DEBOUNCE_MS = 200;

const realtime = {
  client: null,
  channel: null,
  debounceHandle: null,
  isRefreshQueued: false,
};

boot();

async function boot() {
  document.querySelector('#pickup-date').value = nextSunday();
  requestForm.addEventListener('submit', onCreateRideRequest);
  document.querySelector('#auto-assign-btn').addEventListener('click', onAutoAssign);
  driverSelect.addEventListener('change', renderDriverQueue);
  actorSelect.addEventListener('change', refreshAll);
  document.querySelector('#save-settings-btn').addEventListener('click', onSaveSettings);
  document.querySelector('#send-broadcast-btn').addEventListener('click', onSendBroadcast);
  pendingUsersEl.addEventListener('click', onUserApprovalAction);

  try {
    await hydrateState();
    renderActorSelect();
    refreshAll();
    await initRideRealtimeSubscription();
  } catch (error) {
    assignResult.textContent = `Failed to load data: ${error.message}`;
  }
}

async function initRideRealtimeSubscription() {
  if (typeof window !== 'undefined' && typeof window.__rtcRealtimeCleanup === 'function') {
    window.__rtcRealtimeCleanup();
  }

  const config = await loadPublicSupabaseConfig();
  if (!config) return;

  realtime.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const onRideChange = (payload) => {
    if (!isDispatcherBoardRelevantChange(payload)) return;
    queueRealtimeRefresh();
  };

  realtime.channel = realtime.client
    .channel('public:rides:dispatcher-board')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rides' }, onRideChange)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rides' }, onRideChange)
    .subscribe();

  window.addEventListener('beforeunload', cleanupRealtimeSubscription, { once: true });
  window.addEventListener('pagehide', cleanupRealtimeSubscription, { once: true });
  window.__rtcRealtimeCleanup = cleanupRealtimeSubscription;
}

async function loadPublicSupabaseConfig() {
  try {
    const response = await fetch('/api/public-config');
    if (!response.ok) return null;
    const config = await response.json();
    if (!config?.supabaseUrl || !config?.supabaseAnonKey) return null;
    return config;
  } catch {
    return null;
  }
}

function isDispatcherBoardRelevantChange(payload) {
  const oldStatus = payload.old?.status;
  const newStatus = payload.new?.status;
  return BOARD_RELEVANT_STATUSES.has(newStatus) || BOARD_RELEVANT_STATUSES.has(oldStatus);
}

function queueRealtimeRefresh() {
  if (realtime.isRefreshQueued) return;
  realtime.isRefreshQueued = true;
  realtime.debounceHandle = setTimeout(async () => {
    realtime.isRefreshQueued = false;
    realtime.debounceHandle = null;
    try {
      await hydrateState();
      refreshAll();
    } catch (error) {
      assignResult.textContent = `Realtime refresh failed: ${error.message}`;
    }
  }, REALTIME_REFRESH_DEBOUNCE_MS);
}

function cleanupRealtimeSubscription() {
  if (realtime.debounceHandle) {
    clearTimeout(realtime.debounceHandle);
    realtime.debounceHandle = null;
    realtime.isRefreshQueued = false;
  }
  if (realtime.channel && realtime.client) {
    realtime.client.removeChannel(realtime.channel);
  }
  realtime.channel = null;
  realtime.client = null;
}

async function hydrateState() {
  const [users, rides] = await Promise.all([apiClient.getUsers(), apiClient.getRides()]);
  state.users = users;
  state.rides = rides;
}

async function onCreateRideRequest(event) {
  event.preventDefault();
  if (!canRequestRide(currentActor())) {
    assignResult.textContent = 'Only approved members can request rides.';
    return;
  }

  const optimisticRide = {
    id: `temp-${Date.now()}`,
    memberId: memberSelect.value,
    scheduledFor: document.querySelector('#pickup-date').value,
    pickupNotes: document.querySelector('#pickup-notes').value.trim(),
    status: 'requested',
  };

  const before = snapshot(state.rides);
  state.rides = [...state.rides, optimisticRide];
  refreshAll();

  try {
    const created = await apiClient.createRide(optimisticRide);
    state.rides = state.rides.map((ride) => (ride.id === optimisticRide.id ? created : ride));
    assignResult.textContent = 'Ride request created.';
    event.target.reset();
    document.querySelector('#pickup-date').value = nextSunday();
  } catch (error) {
    state.rides = before;
    assignResult.textContent = `Ride request failed: ${error.message}`;
  }
  refreshAll();
}

async function onAutoAssign() {
  if (!canDispatch(currentActor())) {
    assignResult.textContent = 'Only approved volunteer dispatchers, people managers, or super admins can run dispatch actions.';
    return;
  }

  const before = snapshot(state.rides);
  const optimistic = snapshot(state.rides);
  const assignments = autoAssignRides({
    rides: optimistic,
    users: state.users,
    maxRidesPerDriver: state.settings.maxRidesPerDriver,
  });
  state.rides = optimistic;
  assignResult.textContent = assignments.length
    ? `Assigning ${assignments.length} ride(s)...`
    : 'No requested rides were available for assignment.';
  refreshAll();

  if (!assignments.length) return;

  try {
    const response = await apiClient.autoAssign({
      actorId: currentActor().id,
      maxRidesPerDriver: state.settings.maxRidesPerDriver,
    });
    state.rides = response.rides;
    assignResult.textContent = `Assigned ${response.assignments.length} ride(s).`;
  } catch (error) {
    state.rides = error.details?.rides ?? before;
    assignResult.textContent = `Auto-assign failed: ${error.message}`;
  }
  refreshAll();
}

function onUserApprovalAction() {
  // Approval UI is retained for parity, but user writes are managed via backend admin APIs in future work.
}

function onSaveSettings() {
  if (!isSuperAdmin(currentActor())) {
    broadcastStatus.textContent = 'Only super admins can update settings.';
    return;
  }
  state.settings.maxRidesPerDriver = Math.max(1, Number(maxRidesInput.value) || 1);
  state.settings.emergencyBroadcastDraft = broadcastDraft.value.trim();
  persistSettings();
  broadcastStatus.textContent = 'Settings saved.';
}

function onSendBroadcast() {
  if (!isSuperAdmin(currentActor())) {
    broadcastStatus.textContent = 'Only super admins can send broadcasts.';
    return;
  }

  const message = broadcastDraft.value.trim();
  if (!message) {
    broadcastStatus.textContent = 'Broadcast draft is empty.';
    return;
  }

  state.settings.lastBroadcastAt = new Date().toISOString();
  state.settings.lastBroadcastBy = currentActor().id;

  writeAudit({
    type: 'broadcast.sent',
    actorId: currentActor().id,
    before: null,
    after: snapshot(state.settings),
    metadata: { channel: 'postmark', draft: message },
  });

  persistSettings();
  broadcastStatus.textContent = `Emergency broadcast sent at ${new Date(state.settings.lastBroadcastAt).toLocaleString()}.`;
  refreshAll();
}

function refreshAll() {
  renderActorStatus();
  renderSelects();
  renderBoard();
  renderDriverQueue();
  renderAdminPanel();
  renderSettings();
  renderAuditLog();
}

function renderActorSelect() {
  actorSelect.innerHTML = state.users
    .map((u) => `<option value="${u.id}">${u.fullName} (${roleLabel(u.role)})</option>`)
    .join('');
}

function renderActorStatus() {
  const actor = currentActor();
  actorStatus.textContent = actor ? `${actor.fullName}: ${roleLabel(actor.role)} / ${actor.approval_status}` : 'No users available';
}

function renderSelects() {
  const actor = currentActor();
  const approvedMembers = state.users.filter((u) => u.role === 'member' && u.approval_status === 'approved');
  const approvedDrivers = state.users.filter((u) => u.role === 'volunteer_driver' && u.approval_status === 'approved');

  memberSelect.innerHTML = approvedMembers.map((u) => `<option value="${u.id}">${u.fullName}</option>`).join('');
  driverSelect.innerHTML = approvedDrivers.map((u) => `<option value="${u.id}">${u.fullName}</option>`).join('');

  requestForm.querySelector('button[type="submit"]').disabled = !actor || !canRequestRide(actor);
  autoAssignBtn.disabled = !actor || !canDispatch(actor);
}

function renderBoard() {
  const approvedDrivers = state.users.filter((u) => u.role === 'volunteer_driver' && u.approval_status === 'approved');
  const queueLoads = Object.fromEntries(
    approvedDrivers.map((d) => [d.id, state.rides.filter((r) => r.driverId === d.id && r.status === 'assigned').length]),
  );

  requestedRides.innerHTML = state.rides
    .filter((r) => r.status === 'requested')
    .map((r) => {
      const member = state.users.find((u) => u.id === r.memberId);
      const nearest = member?.coordinates
        ? nearestDrivers(member, approvedDrivers.filter((d) => d.coordinates), queueLoads)
          .map((d) => `${d.fullName} (${d.distanceKm.toFixed(1)}km)`)
          .join(', ')
        : '';
      return `<li><strong>${member?.fullName ?? 'Unknown member'}</strong> - ${r.scheduledFor}<br/><span class="muted">Closest approved drivers: ${nearest || 'none'}</span></li>`;
    })
    .join('') || '<li class="muted">No requested rides.</li>';

  assignedRides.innerHTML = state.rides
    .filter((r) => r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999))
    .map((r) => {
      const member = state.users.find((u) => u.id === r.memberId);
      const driver = state.users.find((u) => u.id === r.driverId);
      return `<li><span class="badge">Assigned</span> ${member?.fullName ?? 'Unknown'} → ${driver?.fullName ?? 'Unassigned'} (Stop ${r.queueOrder ?? '-'})</li>`;
    })
    .join('') || '<li class="muted">No assigned rides.</li>';
}

async function renderDriverQueue() {
  const actor = currentActor();
  if (!actor || !canDrive(actor)) {
    driverQueue.innerHTML = '<li class="muted">Only approved drivers can access this queue.</li>';
    return;
  }

  const driverId = driverSelect.value;
  if (!driverId) {
    driverQueue.innerHTML = '<li class="muted">No approved drivers available.</li>';
    return;
  }

  try {
    const queue = await apiClient.getDriverQueue(driverId);
    driverQueue.innerHTML = queue
      .map((item) => {
        const { lat, lon } = item.member.coordinates;
        const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
        return `<li><span class="badge">Stop ${item.queueOrder}</span> <strong>${item.member.fullName}</strong> — ${item.pickupNotes || 'No notes'}<br/><a href="${navUrl}" target="_blank" rel="noreferrer">Start navigation</a></li>`;
      })
      .join('') || '<li class="muted">No active stops for this driver.</li>';
  } catch (error) {
    driverQueue.innerHTML = `<li class="muted">Failed to load queue: ${error.message}</li>`;
  }
}

function renderAdminPanel() {
  const actor = currentActor();
  const canAdmin = actor && canManageUsers(actor);
  adminPanel.hidden = !canAdmin;
  adminHint.hidden = canAdmin;

  const pending = state.users.filter((u) => u.approval_status === 'pending');
  pendingUsersEl.innerHTML = pending
    .map((u) => `<li>${u.fullName} (${roleLabel(u.role)})</li>`)
    .join('') || '<li class="muted">No pending users.</li>';
}

function renderSettings() {
  const actor = currentActor();
  const isSA = actor && isSuperAdmin(actor);
  document.querySelector('#super-admin-settings').hidden = !isSA;
  document.querySelector('#super-admin-hint').hidden = isSA;
  maxRidesInput.value = state.settings.maxRidesPerDriver;
  broadcastDraft.value = state.settings.emergencyBroadcastDraft;
}

function renderAuditLog() {
  auditLogEl.innerHTML = state.auditLogs
    .slice()
    .reverse()
    .map((log) => `<li><strong>${log.type}</strong> by ${displayName(log.actorId)} at ${new Date(log.timestamp).toLocaleString()}</li>`)
    .join('') || '<li class="muted">No audit records yet.</li>';
}

function writeAudit({ type, actorId, before, after, metadata = {} }) {
  state.auditLogs.push({
    id: `a${state.auditLogs.length + 1}`,
    type,
    actorId,
    timestamp: new Date().toISOString(),
    before,
    after,
    metadata,
  });
}

function currentActor() {
  return state.users.find((u) => u.id === actorSelect.value) ?? state.users[0] ?? null;
}

function canRequestRide(user) {
  return user.role === 'member' && user.approval_status === 'approved';
}

function canDrive(user) {
  return user.role === 'volunteer_driver' && user.approval_status === 'approved';
}

function canDispatch(user) {
  return ['volunteer_dispatcher', 'people_manager', 'super_admin'].includes(user.role)
    && user.approval_status === 'approved';
}

function canManageUsers(user) {
  return ['people_manager', 'super_admin'].includes(user.role) && user.approval_status === 'approved';
}

function isSuperAdmin(user) {
  return user.role === 'super_admin' && user.approval_status === 'approved';
}

function roleLabel(role) {
  return ROLE_LABELS[role] ?? role;
}

function displayName(userId) {
  return state.users.find((u) => u.id === userId)?.fullName ?? userId;
}

function snapshot(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function persistSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return snapshot(defaultState.settings);
  try {
    return { ...snapshot(defaultState.settings), ...JSON.parse(raw) };
  } catch {
    return snapshot(defaultState.settings);
  }
}

function nextSunday() {
  const now = new Date();
  const day = now.getDay();
  const distance = (7 - day) % 7 || 7;
  now.setDate(now.getDate() + distance);
  return now.toISOString().split('T')[0];
}
