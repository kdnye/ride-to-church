import { autoAssignRides, nearestDrivers, queueForDriver } from './logic.js';

const STORAGE_KEY = 'rtc-state-v2';

const defaultState = {
  users: [
    {
      id: 'sa1',
      fullName: 'Grace Admin',
      role: 'super_admin',
      approval_status: 'approved',
      approved_by: 'system',
      approved_at: new Date().toISOString(),
      coordinates: { lat: 35.1495, lon: -90.049 },
    },
    {
      id: 'pm1',
      fullName: 'Helen Manager',
      role: 'people_manager',
      approval_status: 'approved',
      approved_by: 'sa1',
      approved_at: new Date().toISOString(),
      coordinates: { lat: 35.133, lon: -90.02 },
    },
    { id: 'm1', fullName: 'Sarah Johnson', role: 'member', approval_status: 'approved', approved_by: 'pm1', approved_at: new Date().toISOString(), coordinates: { lat: 35.1495, lon: -90.049 } },
    { id: 'm2', fullName: 'Marcus Reed', role: 'member', approval_status: 'pending', approved_by: null, approved_at: null, coordinates: { lat: 35.133, lon: -90.02 } },
    { id: 'm3', fullName: 'Elena Brooks', role: 'member', approval_status: 'approved', approved_by: 'pm1', approved_at: new Date().toISOString(), coordinates: { lat: 35.182, lon: -90.08 } },
    { id: 'd1', fullName: 'James Driver', role: 'volunteer_driver', approval_status: 'approved', approved_by: 'pm1', approved_at: new Date().toISOString(), coordinates: { lat: 35.12, lon: -90.04 } },
    { id: 'd2', fullName: 'Tonya Driver', role: 'volunteer_driver', approval_status: 'pending', approved_by: null, approved_at: null, coordinates: { lat: 35.18, lon: -90.01 } },
    { id: 'd3', fullName: 'Ben Driver', role: 'volunteer_driver', approval_status: 'approved', approved_by: 'pm1', approved_at: new Date().toISOString(), coordinates: { lat: 35.11, lon: -90.09 } },
  ],
  rides: [
    { id: 'r1', memberId: 'm1', scheduledFor: nextSunday(), pickupNotes: 'Wheelchair friendly entrance', status: 'requested' },
    { id: 'r2', memberId: 'm3', scheduledFor: nextSunday(), pickupNotes: 'Call on arrival', status: 'requested' },
  ],
  settings: {
    maxRidesPerDriver: 3,
    emergencyBroadcastDraft: '',
    lastBroadcastAt: null,
    lastBroadcastBy: null,
  },
  auditLogs: [],
};

const state = loadState();

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

boot();

function boot() {
  renderActorSelect();
  document.querySelector('#pickup-date').value = nextSunday();
  requestForm.addEventListener('submit', onCreateRideRequest);
  document.querySelector('#auto-assign-btn').addEventListener('click', onAutoAssign);
  driverSelect.addEventListener('change', renderDriverQueue);
  actorSelect.addEventListener('change', refreshAll);
  document.querySelector('#save-settings-btn').addEventListener('click', onSaveSettings);
  document.querySelector('#send-broadcast-btn').addEventListener('click', onSendBroadcast);
  pendingUsersEl.addEventListener('click', onUserApprovalAction);
  refreshAll();
}

function onCreateRideRequest(event) {
  event.preventDefault();
  if (!canRequestRide(currentActor())) {
    assignResult.textContent = 'Only approved members can request rides.';
    return;
  }

  const memberId = memberSelect.value;
  state.rides.push({
    id: `r${state.rides.length + 1}`,
    memberId,
    scheduledFor: document.querySelector('#pickup-date').value,
    pickupNotes: document.querySelector('#pickup-notes').value.trim(),
    status: 'requested',
  });

  event.target.reset();
  document.querySelector('#pickup-date').value = nextSunday();
  assignResult.textContent = 'Ride request created.';
  persist();
  refreshAll();
}

function onAutoAssign() {
  if (!canDispatch(currentActor())) {
    assignResult.textContent = 'Only approved dispatchers/managers/admins can run dispatch actions.';
    return;
  }

  const assignments = autoAssignRides({
    rides: state.rides,
    users: state.users,
    maxRidesPerDriver: state.settings.maxRidesPerDriver,
  });
  assignResult.textContent = assignments.length
    ? `Assigned ${assignments.length} ride(s).`
    : 'No requested rides were available for assignment.';
  persist();
  refreshAll();
}

function onUserApprovalAction(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  if (!canManageUsers(currentActor())) return;

  const userId = button.dataset.userId;
  const action = button.dataset.action;
  const target = state.users.find((u) => u.id === userId);
  if (!target) return;

  const before = snapshot(target);
  if (action === 'approve') {
    target.approval_status = 'approved';
    target.approved_by = currentActor().id;
    target.approved_at = new Date().toISOString();
  } else if (action === 'reject') {
    target.approval_status = 'rejected';
    target.approved_by = currentActor().id;
    target.approved_at = new Date().toISOString();
  }

  writeAudit({
    type: 'user.approval_status.changed',
    actorId: currentActor().id,
    before,
    after: snapshot(target),
  });

  persist();
  refreshAll();
}

function onSaveSettings() {
  if (!isSuperAdmin(currentActor())) {
    broadcastStatus.textContent = 'Only super admins can update settings.';
    return;
  }

  const before = snapshot(state.settings);
  state.settings.maxRidesPerDriver = Math.max(1, Number(maxRidesInput.value) || 1);
  state.settings.emergencyBroadcastDraft = broadcastDraft.value.trim();

  writeAudit({
    type: 'settings.updated',
    actorId: currentActor().id,
    before,
    after: snapshot(state.settings),
  });

  persist();
  broadcastStatus.textContent = 'Settings saved.';
  refreshAll();
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

  const before = snapshot(state.settings);
  state.settings.lastBroadcastAt = new Date().toISOString();
  state.settings.lastBroadcastBy = currentActor().id;

  // Postmark is the email provider of record; in this MVP we store audit + trigger metadata only.
  writeAudit({
    type: 'broadcast.sent',
    actorId: currentActor().id,
    before,
    after: snapshot(state.settings),
    metadata: { channel: 'postmark', draft: message },
  });

  persist();
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
    .map((u) => `<option value="${u.id}">${u.fullName} (${u.role})</option>`)
    .join('');
}

function renderActorStatus() {
  const actor = currentActor();
  actorStatus.textContent = `${actor.fullName}: ${actor.role} / ${actor.approval_status}`;
}

function renderSelects() {
  const actor = currentActor();
  const approvedMembers = state.users.filter((u) => u.role === 'member' && u.approval_status === 'approved');
  const approvedDrivers = state.users.filter((u) => u.role === 'volunteer_driver' && u.approval_status === 'approved');

  memberSelect.innerHTML = approvedMembers
    .map((u) => `<option value="${u.id}">${u.fullName}</option>`)
    .join('');
  driverSelect.innerHTML = approvedDrivers
    .map((u) => `<option value="${u.id}">${u.fullName}</option>`)
    .join('');

  requestForm.querySelector('button[type="submit"]').disabled = !canRequestRide(actor);
  autoAssignBtn.disabled = !canDispatch(actor);
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
      const nearest = nearestDrivers(member, approvedDrivers, queueLoads)
        .map((d) => `${d.fullName} (${d.distanceKm.toFixed(1)}km)`)
        .join(', ');
      return `<li><strong>${member.fullName}</strong> - ${r.scheduledFor}<br/><span class="muted">Closest approved drivers: ${nearest || 'none'}</span></li>`;
    })
    .join('') || '<li class="muted">No requested rides.</li>';

  assignedRides.innerHTML = state.rides
    .filter((r) => r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999))
    .map((r) => {
      const member = state.users.find((u) => u.id === r.memberId);
      const driver = state.users.find((u) => u.id === r.driverId);
      return `<li><span class="badge">Assigned</span> ${member.fullName} → ${driver.fullName} (Stop ${r.queueOrder})</li>`;
    })
    .join('') || '<li class="muted">No assigned rides.</li>';
}

function renderDriverQueue() {
  const actor = currentActor();
  if (!canDrive(actor)) {
    driverQueue.innerHTML = '<li class="muted">Only approved drivers can access this queue.</li>';
    return;
  }

  const queue = queueForDriver(driverSelect.value, state.rides, state.users);
  driverQueue.innerHTML = queue
    .map((item) => {
      const { lat, lon } = item.member.coordinates;
      const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
      return `<li><strong>${item.member.fullName}</strong> — ${item.pickupNotes || 'No notes'}<br/><a href="${navUrl}" target="_blank" rel="noreferrer">Start navigation</a></li>`;
    })
    .join('') || '<li class="muted">No active stops for this driver.</li>';
}

function renderAdminPanel() {
  const actor = currentActor();
  const canAdmin = canManageUsers(actor);
  adminPanel.hidden = !canAdmin;
  adminHint.hidden = canAdmin;

  const pending = state.users.filter((u) => u.approval_status === 'pending');
  pendingUsersEl.innerHTML = pending
    .map((u) => `<li>${u.fullName} (${u.role})
      <button data-action="approve" data-user-id="${u.id}">Approve</button>
      <button data-action="reject" data-user-id="${u.id}">Reject</button>
    </li>`)
    .join('') || '<li class="muted">No pending users.</li>';
}

function renderSettings() {
  const isSA = isSuperAdmin(currentActor());
  document.querySelector('#super-admin-settings').hidden = !isSA;
  document.querySelector('#super-admin-hint').hidden = isSA;
  maxRidesInput.value = state.settings.maxRidesPerDriver;
  broadcastDraft.value = state.settings.emergencyBroadcastDraft;
}

function renderAuditLog() {
  auditLogEl.innerHTML = state.auditLogs
    .slice()
    .reverse()
    .map((log) => `<li><strong>${log.type}</strong> by ${displayName(log.actorId)} at ${new Date(log.timestamp).toLocaleString()}<br/><span class="muted">before=${JSON.stringify(log.before)} | after=${JSON.stringify(log.after)}</span></li>`)
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
  return state.users.find((u) => u.id === actorSelect.value) ?? state.users[0];
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

function displayName(userId) {
  return state.users.find((u) => u.id === userId)?.fullName ?? userId;
}

function snapshot(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return snapshot(defaultState);
  try {
    return { ...snapshot(defaultState), ...JSON.parse(raw) };
  } catch {
    return snapshot(defaultState);
  }
}

function nextSunday() {
  const now = new Date();
  const day = now.getDay();
  const distance = (7 - day) % 7 || 7;
  now.setDate(now.getDate() + distance);
  return now.toISOString().split('T')[0];
}
