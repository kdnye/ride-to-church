import { autoAssignRides, nearestDrivers, queueForDriver } from './logic.js';

const users = [
  { id: 'm1', fullName: 'Sarah Johnson', role: 'member', status: 'approved', coordinates: { lat: 35.1495, lon: -90.049 } },
  { id: 'm2', fullName: 'Marcus Reed', role: 'member', status: 'approved', coordinates: { lat: 35.133, lon: -90.02 } },
  { id: 'm3', fullName: 'Elena Brooks', role: 'member', status: 'approved', coordinates: { lat: 35.182, lon: -90.08 } },
  { id: 'd1', fullName: 'James Driver', role: 'volunteer_driver', status: 'approved', coordinates: { lat: 35.12, lon: -90.04 } },
  { id: 'd2', fullName: 'Tonya Driver', role: 'volunteer_driver', status: 'approved', coordinates: { lat: 35.18, lon: -90.01 } },
  { id: 'd3', fullName: 'Ben Driver', role: 'volunteer_driver', status: 'approved', coordinates: { lat: 35.11, lon: -90.09 } },
];

const rides = [
  { id: 'r1', memberId: 'm1', scheduledFor: nextSunday(), pickupNotes: 'Wheelchair friendly entrance', status: 'requested' },
  { id: 'r2', memberId: 'm3', scheduledFor: nextSunday(), pickupNotes: 'Call on arrival', status: 'requested' },
];

const memberSelect = document.querySelector('#member-select');
const driverSelect = document.querySelector('#driver-select');
const requestedRides = document.querySelector('#requested-rides');
const assignedRides = document.querySelector('#assigned-rides');
const driverQueue = document.querySelector('#driver-queue');
const assignResult = document.querySelector('#assign-result');

renderSelects();
renderBoard();
renderDriverQueue();

document.querySelector('#pickup-date').value = nextSunday();

document.querySelector('#request-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const memberId = memberSelect.value;
  const scheduledFor = document.querySelector('#pickup-date').value;
  const pickupNotes = document.querySelector('#pickup-notes').value.trim();

  rides.push({
    id: `r${rides.length + 1}`,
    memberId,
    scheduledFor,
    pickupNotes,
    status: 'requested',
  });

  event.target.reset();
  document.querySelector('#pickup-date').value = nextSunday();
  assignResult.textContent = 'Ride request created.';
  renderBoard();
  renderDriverQueue();
});

document.querySelector('#auto-assign-btn').addEventListener('click', () => {
  const assignments = autoAssignRides({ rides, users });
  assignResult.textContent = assignments.length
    ? `Assigned ${assignments.length} ride(s).`
    : 'No requested rides were available for assignment.';
  renderBoard();
  renderDriverQueue();
});

driverSelect.addEventListener('change', renderDriverQueue);

function renderSelects() {
  memberSelect.innerHTML = users
    .filter((u) => u.role === 'member')
    .map((u) => `<option value="${u.id}">${u.fullName}</option>`)
    .join('');

  driverSelect.innerHTML = users
    .filter((u) => u.role === 'volunteer_driver')
    .map((u) => `<option value="${u.id}">${u.fullName}</option>`)
    .join('');
}

function renderBoard() {
  const queueLoads = Object.fromEntries(
    users
      .filter((u) => u.role === 'volunteer_driver')
      .map((d) => [d.id, rides.filter((r) => r.driverId === d.id && r.status === 'assigned').length]),
  );

  requestedRides.innerHTML = rides
    .filter((r) => r.status === 'requested')
    .map((r) => {
      const member = users.find((u) => u.id === r.memberId);
      const nearest = nearestDrivers(member, users.filter((u) => u.role === 'volunteer_driver'), queueLoads)
        .map((d) => `${d.fullName} (${d.distanceKm.toFixed(1)}km)`)
        .join(', ');

      return `<li><strong>${member.fullName}</strong> - ${r.scheduledFor}<br/><span class="muted">Closest drivers: ${nearest}</span></li>`;
    })
    .join('') || '<li class="muted">No requested rides.</li>';

  assignedRides.innerHTML = rides
    .filter((r) => r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999))
    .map((r) => {
      const member = users.find((u) => u.id === r.memberId);
      const driver = users.find((u) => u.id === r.driverId);
      return `<li><span class="badge">Assigned</span> ${member.fullName} → ${driver.fullName} (Stop ${r.queueOrder})</li>`;
    })
    .join('') || '<li class="muted">No assigned rides.</li>';
}

function renderDriverQueue() {
  const driverId = driverSelect.value;
  const queue = queueForDriver(driverId, rides, users);

  driverQueue.innerHTML = queue
    .map((item) => {
      const { lat, lon } = item.member.coordinates;
      const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
      return `<li><strong>${item.member.fullName}</strong> — ${item.pickupNotes || 'No notes'}<br/><a href="${navUrl}" target="_blank" rel="noreferrer">Start navigation</a></li>`;
    })
    .join('') || '<li class="muted">No active stops for this driver.</li>';
}

function nextSunday() {
  const now = new Date();
  const day = now.getDay();
  const distance = (7 - day) % 7 || 7;
  now.setDate(now.getDate() + distance);
  return now.toISOString().split('T')[0];
}
