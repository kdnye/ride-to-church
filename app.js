import { autoAssignRides, nearestDrivers } from './logic.js';
import { createClient } from '@supabase/supabase-js';
import { apiClient } from './src/apiClient.js';
import { isGeolocationDenialOrTimeout } from './src/geolocation.js';

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
  destinations: [],
};

// Safely load user from localStorage to prevent JSON.parse crashes
let savedUser = null;
try {
  const raw = localStorage.getItem('rtc-user');
  if (raw && raw !== 'undefined') {
    savedUser = JSON.parse(raw);
  }
} catch (err) {
  console.warn('Cleared corrupted auth state');
  localStorage.removeItem('rtc-user');
}

const state = {
  ...defaultState,
  settings: loadSettings(),
  currentUser: savedUser,
};

// DOM Elements
const memberSelect = document.querySelector('#member-select');
const driverSelect = document.querySelector('#driver-select');
const requestedRides = document.querySelector('#requested-rides');
const assignedRides = document.querySelector('#assigned-rides');
const driverQueue = document.querySelector('#driver-queue');
const assignResult = document.querySelector('#assign-result');
const requestForm = document.querySelector('#request-form');
const autoAssignBtn = document.querySelector('#auto-assign-btn');
const adminPanel = document.querySelector('#view-admin');
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

let publicConfigCache = null;
async function getPublicConfig() {
  if (publicConfigCache) return publicConfigCache;
  try {
    const response = await fetch('/api/public-config');
    publicConfigCache = response.ok ? await response.json() : {};
  } catch {
    publicConfigCache = {};
  }
  return publicConfigCache;
}

let googleMapsLoaderPromise = null;
async function loadGoogleMaps() {
  if (window.google?.maps) return true;

  const config = await getPublicConfig();
  if (!config?.googleMapsApiKey) return false;

  if (!googleMapsLoaderPromise) {
    googleMapsLoaderPromise = new Promise((resolve, reject) => {
      const existingScript = document.querySelector('script[data-google-maps-loader="true"]');
      if (existingScript) {
        existingScript.addEventListener('load', () => resolve(true), { once: true });
        existingScript.addEventListener('error', () => reject(new Error('Google Maps failed to load.')), { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(config.googleMapsApiKey)}&libraries=places,geometry`;
      script.async = true;
      script.defer = true;
      script.dataset.googleMapsLoader = 'true';
      script.onload = () => resolve(true);
      script.onerror = () => reject(new Error('Google Maps failed to load.'));
      document.head.appendChild(script);
    }).catch((error) => {
      googleMapsLoaderPromise = null;
      console.error(error);
      return false;
    });
  }

  return googleMapsLoaderPromise;
}

const mapState = {
  dispatchMap: null,
  driverMap: null,
  markers: { dispatch: [], driver: [] },
  polylines: { driver: [] },
};

function normalizeCoordinates(rawCoordinates) {
  if (!rawCoordinates || typeof rawCoordinates !== 'object') return null;
  const lat = Number(rawCoordinates.lat);
  const lon = Number(rawCoordinates.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function effectiveCapacity(driver) {
  if (!driver || typeof driver !== 'object') return state.settings.maxRidesPerDriver;
  const raw = driver.daily_ride_capacity ?? driver.dailyRideCapacity;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : state.settings.maxRidesPerDriver;
}

function clearMap(layerKey) {
  mapState.markers[layerKey].forEach((marker) => marker.setMap(null));
  mapState.markers[layerKey] = [];

  if (layerKey === 'driver') {
    mapState.polylines.driver.forEach((polyline) => polyline.setMap(null));
    mapState.polylines.driver = [];
  }
}

async function initMap(containerId, stateKey) {
  if (mapState[stateKey]) return mapState[stateKey];

  const mapEl = document.getElementById(containerId);
  if (!mapEl) return null;

  const loaded = await loadGoogleMaps();
  if (!loaded || !window.google?.maps) return null;

  const map = new google.maps.Map(mapEl, {
    center: { lat: 32.2226, lng: -110.9747 },
    zoom: 11,
    mapTypeControl: false,
    streetViewControl: false,
  });

  mapState[stateKey] = map;
  return map;
}

function invalidateVisibleMap(hash = window.location.hash || '#/profile') {
  if (hash === '#/dispatch' && mapState.dispatchMap && window.google?.maps?.event) {
    setTimeout(() => google.maps.event.trigger(mapState.dispatchMap, 'resize'), 0);
  }
  if (hash === '#/drive' && mapState.driverMap && window.google?.maps?.event) {
    setTimeout(() => google.maps.event.trigger(mapState.driverMap, 'resize'), 0);
  }
}

// --- ROUTING ---
const routes = [
  { path: '#/login', viewId: 'view-login', label: 'Login', public: true },
  { path: '#/register', viewId: 'view-register', label: 'Register', public: true },
  { path: '#/profile', viewId: 'view-profile', label: 'Profile', auth: () => true },
  { path: '#/request', viewId: 'view-request', label: 'Request Ride', auth: canRequestRide },
  { path: '#/dispatch', viewId: 'view-dispatch', label: 'Dispatch Board', auth: canDispatch },
  { path: '#/drive', viewId: 'view-driver', label: 'Driver View', auth: canDrive },
  { path: '#/admin', viewId: 'view-admin', label: 'User Admin', auth: canManageUsers },
  { path: '#/settings', viewId: 'view-settings', label: 'System Settings', auth: isSuperAdmin },
];

window.addEventListener('hashchange', navigate);

function navigate() {
  const hash = window.location.hash || '#/profile';
  const actor = currentActor();
  let route = routes.find(r => r.path === hash);

  if (!actor && (!route || !route.public)) {
    window.location.hash = '#/login';
    return;
  }

  if (actor && route && !route.public && !route.auth(actor)) {
    window.location.hash = '#/profile';
    return;
  }

  if (actor && route && route.public) {
    window.location.hash = '#/profile';
    return;
  }

  document.querySelectorAll('.page-view').forEach(el => el.classList.remove('active'));
  const activeView = document.getElementById(route ? route.viewId : 'view-profile');
  if (activeView) activeView.classList.add('active');

  document.querySelectorAll('nav#main-nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === hash);
  });

  invalidateVisibleMap(hash);
}

function renderNav() {
  const actor = currentActor();
  const navEl = document.querySelector('#main-nav');
  
  if (!actor) {
    navEl.innerHTML = ''; 
    return;
  }

  navEl.innerHTML = routes
    .filter(r => !r.public && r.auth(actor))
    .map(r => `<a href="${r.path}">${r.label}</a>`)
    .join('');
}

// --- Safe Listener Helper ---
function safeAddListener(selector, event, handler) {
  const el = document.querySelector(selector);
  if (el) {
    el.addEventListener(event, handler);
  } else {
    console.warn(`Warning: Could not find DOM element ${selector} to attach ${event} listener.`);
  }
}

// --- INITIALIZATION ---
boot();

async function boot() {
  const pickupDate = document.querySelector('#pickup-date');
  if (pickupDate) pickupDate.value = nextSunday();
  
  safeAddListener('#request-form', 'submit', onCreateRideRequest);
  safeAddListener('#auto-assign-btn', 'click', onAutoAssign);
  safeAddListener('#driver-select', 'change', renderDriverQueue);
  safeAddListener('#save-settings-btn', 'click', onSaveSettings);
  safeAddListener('#send-broadcast-btn', 'click', onSendBroadcast);

  safeAddListener('#add-destination-form', 'submit', async (event) => {
    event.preventDefault();
    const actor = currentActor();
    if (!actor || !canManageUsers(actor)) return;

    const feedbackEl = document.querySelector('#dest-feedback');
    const nameInput = document.querySelector('#new-dest-name');
    const addressInput = document.querySelector('#new-dest-address');

    if (!feedbackEl || !nameInput || !addressInput) return;

    const name = nameInput.value.trim();
    const address = addressInput.value.trim();

    feedbackEl.textContent = 'Looking up address coordinates...';
    feedbackEl.style.color = 'inherit';

    try {
      const geoResponse = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`);
      if (!geoResponse.ok) {
        throw new Error('Address lookup failed. Please try again.');
      }

      const geoData = await geoResponse.json();
      if (!Array.isArray(geoData) || geoData.length === 0) {
        throw new Error('Could not find GPS coordinates for that address. Try adding a ZIP code.');
      }

      const coordinates = {
        lat: Number.parseFloat(geoData[0].lat),
        lon: Number.parseFloat(geoData[0].lon),
      };

      if (!Number.isFinite(coordinates.lat) || !Number.isFinite(coordinates.lon)) {
        throw new Error('Address lookup returned invalid coordinates.');
      }

      feedbackEl.textContent = 'Saving destination...';
      const createdDestination = await apiClient.createDestination({ name, address, coordinates });
      state.destinations.push(createdDestination);
      state.destinations.sort((a, b) => a.name.localeCompare(b.name));
      renderDestinations();
      event.target.reset();
      feedbackEl.textContent = '✅ Destination added successfully!';
      feedbackEl.style.color = '#2e7d32';
    } catch (error) {
      feedbackEl.textContent = error.message;
      feedbackEl.style.color = '#d32f2f';
    }
  });


  safeAddListener('#login-form', 'submit', onLogin);
  safeAddListener('#register-form', 'submit', onRegister);
  safeAddListener('#logout-btn', 'click', onLogout);

  // Initialize routing immediately to display the correct view
  navigate();
  renderNav();

  // Only fetch protected data if we actually have a logged-in user
  if (currentActor()) {
    try {
      await hydrateState();
      refreshAll();
      await initRideRealtimeSubscription();
    } catch (error) {
      console.error('Boot data load failed:', error);
    }
  }
}

// --- AUTHENTICATION ACTIONS ---
async function onLogin(event) {
  event.preventDefault();
  const email = document.querySelector('#login-email').value;
  const password = document.querySelector('#login-password').value;
  const errorEl = document.querySelector('#login-error');
  errorEl.textContent = '';

  try {
    const res = await apiClient.login({ email, password });
    state.currentUser = res.user;
    localStorage.setItem('rtc-user', JSON.stringify(res.user));
    
    await hydrateState(); 
    refreshAll();
    window.location.hash = '#/profile';
  } catch (error) {
    errorEl.textContent = error.details?.error || 'Login failed. Check credentials.';
  }
}

async function onRegister(event) {
  event.preventDefault();
  const payload = {
    fullName: document.querySelector('#reg-name').value,
    email: document.querySelector('#reg-email').value,
    phone: document.querySelector('#reg-phone').value,
    password: document.querySelector('#reg-password').value,
  };
  
  const statusEl = document.querySelector('#reg-status');
  statusEl.style.color = 'inherit';
  statusEl.textContent = 'Registering...';

  try {
    await apiClient.register(payload);
    statusEl.style.color = '#2e7d32'; 
    statusEl.textContent = 'Success! Please log in (account requires admin approval).';
    event.target.reset();
  } catch (error) {
    statusEl.style.color = '#d32f2f'; 
    statusEl.textContent = error.details?.error || 'Registration failed.';
  }
}

async function onLogout() {
  try {
    await apiClient.logout();
  } catch(e) {}
  
  state.currentUser = null;
  localStorage.removeItem('rtc-user');
  window.location.hash = '#/login';
  refreshAll();
}

// --- REALTIME ---
async function initRideRealtimeSubscription() {
  if (typeof window !== 'undefined' && typeof window.__rtcRealtimeCleanup === 'function') {
    window.__rtcRealtimeCleanup();
  }

  const config = await getPublicConfig();
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return;

  realtime.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
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

function hasActiveRideForDate(memberId, scheduledFor) {
  return state.rides.some((ride) => (
    ride.memberId === memberId
    && ride.scheduledFor === scheduledFor
    && (ride.status === 'requested' || ride.status === 'assigned')
  ));
}

// --- APP ACTIONS ---
async function hydrateState() {
  const [users, rides, destinations] = await Promise.all([
    apiClient.getUsers(),
    apiClient.getRides(),
    apiClient.getDestinations(),
  ]);
  state.users = users;
  state.rides = rides;
  state.destinations = destinations;
}

async function onCreateRideRequest(event) {
  event.preventDefault();
  const actor = currentActor();

  if (!canRequestRide(actor)) {
    assignResult.textContent = 'Only approved members can request rides.';
    return;
  }

  const isDispatcher = ['volunteer_dispatcher', 'people_manager', 'super_admin'].includes(actor.role);
  const targetMemberId = isDispatcher ? memberSelect.value : actor.id;

  let notes = document.querySelector('#pickup-notes').value.trim();
  const locationChoice = document.querySelector('#pickup-location').value;

  if (locationChoice === 'gps') {
    if (!navigator.geolocation) {
      alert('GPS is not supported in this browser. Defaulting to home address.');
    } else {
      try {
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
        });
        notes = `[GPS Pickup: ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}] ${notes}`.trim();
      } catch (err) {
        if (isGeolocationDenialOrTimeout(err)) {
          alert('Could not get GPS location due to permission denial or timeout. Defaulting to home address.');
        } else {
          console.warn('GPS lookup failed for a non-permission reason; using home address fallback.', err);
        }
      }
    }
  }

  const scheduledFor = document.querySelector('#pickup-date').value;
  if (hasActiveRideForDate(targetMemberId, scheduledFor)) {
    assignResult.textContent = 'You already have an active ride request for that date.';
    return;
  }

  const optimisticRide = {
    id: `temp-${Date.now()}`,
    memberId: targetMemberId,
    scheduledFor,
    pickupNotes: notes,
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
    if (error.status === 409) {
      assignResult.textContent = error.details?.error || 'An active ride already exists for that date.';
    } else {
      assignResult.textContent = `Ride request failed: ${error.message}`;
    }
  }
  refreshAll();
}

async function onAutoAssign() {
  if (!canDispatch(currentActor())) {
    assignResult.textContent = 'Unauthorized to run dispatch.';
    return;
  }

  const before = snapshot(state.rides);
  const optimistic = snapshot(state.rides);
  
  // Predict the assignments locally for immediate UI feedback
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
    const destinationId = document.querySelector('#dispatch-destination')?.value;
    const selectedDestination = state.destinations.find((d) => d.id === destinationId);
    const destinationCoordinates = selectedDestination?.coordinates
      ? {
          lat: Number(selectedDestination.coordinates.lat),
          lon: Number(selectedDestination.coordinates.lon),
        }
      : null;

    // Send it to the backend!
    const response = await apiClient.autoAssign({
      actorId: currentActor().id,
      maxRidesPerDriver: state.settings.maxRidesPerDriver,
      destinationCoordinates,
    });
    
    state.rides = response.rides;
    assignResult.textContent = `Assigned ${response.assignments.length} ride(s).`;
  } catch (error) {
    state.rides = error.details?.rides ?? before;
    assignResult.textContent = `Auto-assign failed: ${error.message}`;
  }
  refreshAll();
}

function onSaveSettings() {
  if (!isSuperAdmin(currentActor())) return;
  state.settings.maxRidesPerDriver = Math.max(1, Number(maxRidesInput.value) || 1);
  state.settings.emergencyBroadcastDraft = broadcastDraft.value.trim();
  persistSettings();
  broadcastStatus.textContent = 'Settings saved.';
}

function onSendBroadcast() {
  if (!isSuperAdmin(currentActor())) return;
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
  broadcastStatus.textContent = `Emergency broadcast sent.`;
  refreshAll();
}

// --- RENDERING ---
function refreshAll() {
  renderNav();
  navigate(); 

  const actor = currentActor();
  if (actor) {
    document.querySelector('#profile-info').innerHTML = `Logged in as <strong>${escapeHtml(actor.fullName) || escapeHtml(actor.email) || 'User'}</strong><br>Role: ${escapeHtml(roleLabel(actor.role))}<br>Status: ${escapeHtml(actor.approvalStatus)}`;
  }

  renderSelects();
  renderBoard();
  renderDestinations();
  renderDriverQueue();
  renderAdminPanel();
  renderSettings();
  renderAuditLog();
}

function renderSelects() {
  const actor = currentActor();
  const approvedMembers = state.users.filter((u) => u.role === 'member' && u.approval_status === 'approved');
  const approvedDrivers = state.users.filter((u) => u.role === 'volunteer_driver' && u.approval_status === 'approved');

  memberSelect.innerHTML = approvedMembers.map((u) => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`).join('');
  driverSelect.innerHTML = approvedDrivers.map((u) => `<option value="${u.id}">${escapeHtml(u.fullName)}</option>`).join('');

  const memberSelectWrapper = document.querySelector('#member-select-wrapper');
  if (actor && ['volunteer_dispatcher', 'people_manager', 'super_admin'].includes(actor.role)) {
    memberSelectWrapper.style.display = 'block';
  } else {
    memberSelectWrapper.style.display = 'none';
  }

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
          .map((d) => `${escapeHtml(d.fullName)} (${d.distanceKm.toFixed(1)}km)`)
          .join(', ')
        : '';
      return `<li><strong>${escapeHtml(member?.fullName ?? 'Unknown member')}</strong> - ${r.scheduledFor}<br/><span class="muted">Closest approved drivers: ${nearest || 'none'}</span></li>`;
    })
    .join('') || '<li class="muted">No requested rides.</li>';

  assignedRides.innerHTML = state.rides
    .filter((r) => r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999))
    .map((r) => {
      const member = state.users.find((u) => u.id === r.memberId);
      const driver = state.users.find((u) => u.id === r.driverId);
      return `<li><span class="badge">Assigned</span> ${escapeHtml(member?.fullName ?? 'Unknown')} → ${escapeHtml(driver?.fullName ?? 'Unassigned')} (Stop ${r.queueOrder ?? '-'})</li>`;
    })
    .join('') || '<li class="muted">No assigned rides.</li>';

  renderDispatchMap();
}

async function renderDispatchMap() {
  const map = await initMap('dispatch-map', 'dispatchMap');
  if (!map || !window.google?.maps) return;

  clearMap('dispatch');
  const bounds = new google.maps.LatLngBounds();

  const approvedDrivers = state.users.filter((u) => u.role === 'volunteer_driver' && u.approval_status === 'approved');
  approvedDrivers.forEach((driver) => {
    const coordinates = normalizeCoordinates(driver.coordinates);
    if (!coordinates) return;

    const position = { lat: coordinates.lat, lng: coordinates.lon };
    const marker = new google.maps.Marker({
      position,
      map,
      title: driver.fullName || 'Driver',
      icon: 'https://maps.google.com/mapfiles/ms/icons/blue-dot.png',
    });
    const infoWindow = new google.maps.InfoWindow({
      content: `<strong>${escapeHtml(driver.fullName || 'Driver')}</strong><br/>Status: Approved driver<br/>Effective capacity: ${effectiveCapacity(driver)}`,
    });
    marker.addListener('click', () => infoWindow.open({ map, anchor: marker }));
    mapState.markers.dispatch.push(marker);
    bounds.extend(position);
  });

  const boardRides = state.rides.filter((ride) => ride.status === 'requested' || ride.status === 'assigned');
  boardRides.forEach((ride) => {
    const member = state.users.find((u) => u.id === ride.memberId);
    const coordinates = normalizeCoordinates(member?.coordinates);
    if (!coordinates) return;

    const assignedDriver = state.users.find((u) => u.id === ride.driverId);
    const position = { lat: coordinates.lat, lng: coordinates.lon };
    const marker = new google.maps.Marker({
      position,
      map,
      title: member?.fullName || 'Unknown member',
      icon: ride.status === 'assigned'
        ? 'https://maps.google.com/mapfiles/ms/icons/green-dot.png'
        : 'https://maps.google.com/mapfiles/ms/icons/red-dot.png',
    });
    const infoWindow = new google.maps.InfoWindow({
      content: `<strong>${escapeHtml(member?.fullName || 'Unknown member')}</strong><br/>Status: ${escapeHtml(ride.status)}<br/>Effective capacity: ${effectiveCapacity(assignedDriver)}`,
    });
    marker.addListener('click', () => infoWindow.open({ map, anchor: marker }));
    mapState.markers.dispatch.push(marker);
    bounds.extend(position);
  });

  if (!bounds.isEmpty()) map.fitBounds(bounds);
}

function renderDestinations() {
  const actor = currentActor();
  const dispatchSelect = document.querySelector('#dispatch-destination');
  const adminList = document.querySelector('#admin-destinations-list');

  if (dispatchSelect) {
    dispatchSelect.innerHTML = state.destinations
      .map((destination) => `<option value="${destination.id}">${escapeHtml(destination.name)}</option>`)
      .join('');
  }

  if (!adminList) return;

  if (!actor || !canManageUsers(actor)) {
    adminList.innerHTML = '';
    return;
  }

  adminList.innerHTML = state.destinations
    .map((destination) => `
      <li style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; gap: 0.5rem;">
        <span><strong>${escapeHtml(destination.name)}</strong> (${escapeHtml(destination.address)})</span>
        <button type="button" onclick="window.deleteDestination('${destination.id}')" style="background: #d32f2f; padding: 0.2rem 0.5rem; font-size: 0.8em; width: auto;">Remove</button>
      </li>
    `)
    .join('') || '<li class="muted">No destinations configured.</li>';
}

window.deleteDestination = async (id) => {
  if (!confirm('Are you sure you want to remove this destination?')) return;
  const feedbackEl = document.querySelector('#dest-feedback');
  if (feedbackEl) {
    feedbackEl.textContent = 'Removing destination...';
    feedbackEl.style.color = 'inherit';
  }

  try {
    await apiClient.deleteDestination(id);
    state.destinations = state.destinations.filter((destination) => destination.id !== id);
    renderDestinations();
    if (feedbackEl) {
      feedbackEl.textContent = 'Destination removed.';
      feedbackEl.style.color = '#2e7d32';
    }
  } catch (error) {
    if (feedbackEl) {
      feedbackEl.textContent = error.message;
      feedbackEl.style.color = '#d32f2f';
    }
  }
};

async function renderDriverQueue() {
  const actor = currentActor();
  if (!actor || !canDrive(actor)) return;

  const driverId = driverSelect.value;
  if (!driverId) {
    driverQueue.innerHTML = '<li class="muted">No approved drivers available.</li>';
    return;
  }

  try {
    const queue = await apiClient.getDriverQueue(driverId);
    if (!Array.isArray(queue) || queue.length === 0) {
      driverQueue.innerHTML = '<li class="muted">No active stops for this driver.</li>';
      await renderDriverMap(driverId);
      return;
    }

    driverQueue.innerHTML = queue
      .map((item) => {
        const coordinates = normalizeCoordinates(item?.member?.coordinates);
        const navUrl = coordinates
          ? `https://www.google.com/maps/dir/?api=1&destination=${coordinates.lat},${coordinates.lon}`
          : null;
        const navLink = navUrl
          ? `<br/><a href="${navUrl}" target="_blank" rel="noreferrer">Start navigation</a>`
          : '<br/><span class="muted">No coordinates available for navigation.</span>';
        return `<li><span class="badge">Stop ${item.queueOrder}</span> <strong>${escapeHtml(item?.member?.fullName || 'Unknown member')}</strong> — ${escapeHtml(item.pickupNotes) || 'No notes'}${navLink}</li>`;
      })
      .join('') || '<li class="muted">No active stops for this driver.</li>';
    await renderDriverMap(driverId, queue);
  } catch (error) {
    driverQueue.innerHTML = `<li class="muted">Failed to load queue: ${error.message}</li>`;
    await renderDriverMap(driverId);
  }
}

async function renderDriverMap(driverId, prefetchedQueue = null) {
  const map = await initMap('driver-map', 'driverMap');
  if (!map || !window.google?.maps) return;

  clearMap('driver');

  if (!driverId) return;

  let queue = prefetchedQueue;
  if (!Array.isArray(queue)) {
    try {
      queue = await apiClient.getDriverQueue(driverId);
    } catch {
      return;
    }
  }

  if (!Array.isArray(queue) || queue.length === 0) return;

  const bounds = new google.maps.LatLngBounds();
  for (const item of queue) {
    const coordinates = normalizeCoordinates(item?.member?.coordinates);
    if (!coordinates) continue;

    const position = { lat: coordinates.lat, lng: coordinates.lon };
    const marker = new google.maps.Marker({
      position,
      map,
      label: String(item?.queueOrder ?? ''),
      title: item?.member?.fullName || 'Unknown member',
    });
    const infoWindow = new google.maps.InfoWindow({
      content: `<strong>Stop ${escapeHtml(item?.queueOrder ?? '-')}: ${escapeHtml(item?.member?.fullName || 'Unknown member')}</strong><br/>${escapeHtml(item?.pickupNotes) || 'No notes'}`,
    });
    marker.addListener('click', () => infoWindow.open({ map, anchor: marker }));
    mapState.markers.driver.push(marker);
    bounds.extend(position);

    if (typeof item.routePolyline === 'string' && window.google?.maps?.geometry?.encoding) {
      const path = google.maps.geometry.encoding.decodePath(item.routePolyline);
      if (path.length > 1) {
        const polyline = new google.maps.Polyline({
          path,
          geodesic: true,
          strokeColor: '#0b3a75',
          strokeOpacity: 0.8,
          strokeWeight: 4,
          map,
        });
        mapState.polylines.driver.push(polyline);

        path.forEach((point) => bounds.extend(point));
      }
    }
  }

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds);
    const zoom = map.getZoom();
    if (zoom > 16) map.setZoom(16);
  }
}

function renderAdminPanel() {
  const actor = currentActor();
  const listEl = document.querySelector('#user-management-list');
  const destinationListEl = document.querySelector('#admin-destinations-list');
  const destinationFeedbackEl = document.querySelector('#dest-feedback');
  
  if (!actor || !canManageUsers(actor)) {
    const resetButton = document.querySelector('#reset-test-data');
    if (resetButton) resetButton.remove();
    if (listEl) listEl.innerHTML = '';
    if (destinationListEl) destinationListEl.innerHTML = '';
    if (destinationFeedbackEl) destinationFeedbackEl.textContent = '';
    return;
  }

  if (listEl && !document.querySelector('#reset-test-data')) {
    listEl.insertAdjacentHTML('beforebegin', `
      <button id="reset-test-data" style="background: #f57c00; margin-bottom: 1rem;">
        Reset &amp; Load Dummy Rides
      </button>
    `);
  }

  const resetButton = document.querySelector('#reset-test-data');
  if (resetButton) {
    resetButton.onclick = async () => {
      if (!confirm('Wipe all rides and load test data?')) return;
      resetButton.disabled = true;
      resetButton.textContent = 'Resetting...';
      try {
        await apiClient.resetRides();
        await hydrateState();
        refreshAll();
      } catch (error) {
        window.alert(error.message || 'Failed to reset test data');
      } finally {
        resetButton.disabled = false;
        resetButton.textContent = 'Reset & Load Dummy Rides';
      }
    };
  }

  if (listEl) {
      listEl.innerHTML = state.users.map(u => `
        <div class="user-row" style="margin-bottom: 1rem; padding: 0.5rem; border: 1px solid #eee;">
          <strong>${escapeHtml(u.fullName)}</strong> (${escapeHtml(u.email) || 'No email'})
          <div style="display: flex; gap: 0.5rem; margin-top: 0.5rem;">
            <select onchange="window.updateUserStatus('${u.id}', this.value)">
              <option value="pending" ${u.approval_status === 'pending' ? 'selected' : ''}>Pending</option>
              <option value="approved" ${u.approval_status === 'approved' ? 'selected' : ''}>Approved</option>
              <option value="rejected" ${u.approval_status === 'rejected' ? 'selected' : ''}>Rejected</option>
            </select>
            <select onchange="window.updateUserRole('${u.id}', this.value)">
              <option value="member" ${u.role === 'member' ? 'selected' : ''}>Member</option>
              <option value="volunteer_driver" ${u.role === 'volunteer_driver' ? 'selected' : ''}>Driver</option>
              <option value="volunteer_dispatcher" ${u.role === 'volunteer_dispatcher' ? 'selected' : ''}>Dispatcher</option>
              <option value="people_manager" ${u.role === 'people_manager' ? 'selected' : ''}>Manager</option>
              <option value="super_admin" ${u.role === 'super_admin' ? 'selected' : ''}>Super Admin</option>
            </select>
          </div>
        </div>
      `).join('');
  }
}

window.updateUserStatus = async (id, status) => {
  await apiClient.updateUser(id, { approval_status: status });
  queueRealtimeRefresh();
};

window.updateUserRole = async (id, role) => {
  await apiClient.updateUser(id, { role });
  queueRealtimeRefresh();
};

function renderSettings() {
  const actor = currentActor();
  if (actor && isSuperAdmin(actor)) {
    maxRidesInput.value = state.settings.maxRidesPerDriver;
    broadcastDraft.value = state.settings.emergencyBroadcastDraft;
  }
}

function renderAuditLog() {
  auditLogEl.innerHTML = state.auditLogs
    .slice()
    .reverse()
    .map((log) => `<li><strong>${escapeHtml(log.type)}</strong> by ${escapeHtml(displayName(log.actorId))} at ${new Date(log.timestamp).toLocaleString()}</li>`)
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

// --- BULLETPROOF HTML ESCAPE ---
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  const textNode = document.createTextNode(String(value));
  const div = document.createElement('div');
  div.appendChild(textNode);
  return div.innerHTML;
}

function currentActor() { return state.currentUser; }
function canRequestRide(user) { return user.role === 'member' && user.approvalStatus === 'approved'; }
function canDrive(user) { return user.role === 'volunteer_driver' && user.approvalStatus === 'approved'; }
function canDispatch(user) { return ['volunteer_dispatcher', 'people_manager', 'super_admin'].includes(user.role) && user.approvalStatus === 'approved'; }
function canManageUsers(user) { return ['people_manager', 'super_admin'].includes(user.role) && user.approvalStatus === 'approved'; }
function isSuperAdmin(user) { return user.role === 'super_admin' && user.approvalStatus === 'approved'; }

function roleLabel(role) { return ROLE_LABELS[role] ?? role; }
function displayName(userId) { return state.users.find((u) => u.id === userId)?.fullName ?? userId; }
function snapshot(obj) { return JSON.parse(JSON.stringify(obj)); }

function persistSettings() { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings)); }
function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return snapshot(defaultState.settings);
  try { return { ...snapshot(defaultState.settings), ...JSON.parse(raw) }; } 
  catch { return snapshot(defaultState.settings); }
}

function nextSunday() {
  const now = new Date();
  const day = now.getDay();
  const distance = (7 - day) % 7 || 7;
  now.setDate(now.getDate() + distance);
  return now.toISOString().split('T')[0];
}
