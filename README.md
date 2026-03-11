

## System Architecture & Data Schema

To support auto-assignment logic and real-time dispatching, the database must prioritize geographic relationships.

### Core Data Entities

| Entity | Key Attributes |
| --- | --- |
| **Users** | Name, Phone, Home Address (Lat/Long), Role, Approval Status |
| **Rides** | Member ID, Date, Pickup Time, Status (Pending, Assigned, Completed), Dispatcher ID |
| **Queues** | Driver ID, List of Ride IDs, Sequence Order |

### Role Permissions Matrix

* **Member:** Create/View own requests.
* **Volunteer Driver:** View assigned queue, update ride status (e.g., "Picked Up"), navigation.
* **Volunteer Dispatcher:** CRUD (Create, Read, Update, Delete) on all rides; drag-and-drop queue management.
* **Role Manager:** Manage user accounts and permissions (User CRUD).
* **Super Admin:** Global system settings, audit logs, and override capabilities.

---

## Technical Implementation Options

### Option 1: The "No-Code" Fast Track (Quick Win)

Using tools like **Glide Apps** or **Softr** connected to a **Google Sheets** or **Airtable** backend.

* **Pros:** Extremely fast to deploy; native Google Maps integration for the dispatcher; simple "Status" toggles for drivers.
* **Cons:** Limited custom logic for complex auto-assignment; performance may lag as the member list grows.

### Option 2: The "Low-Code" Professional Build (Strategic Alignment)

Using **FlutterFlow** or **Bubble** with a **Firebase** or **Supabase** backend.

* **Pros:** Supports complex "Auto-Assign" logic using PostGIS or custom Cloud Functions; handles real-time updates (driver sees a new ride immediately without refreshing).
* **Cons:** Higher learning curve; requires setup of Google Maps API keys for "Navigate to Next" functionality.

---

## Logistics & Optimization Logic

To enhance workflow efficiency, implement a **Clustering Algorithm** for the auto-assign feature.

1. **Geocoding:** Convert all home addresses into $(latitude, longitude)$ coordinates during registration.
2. **Proximity Check:** Use the **Haversine Formula** to calculate the great-circle distance between a member's home and available drivers.

$$d = 2r \arcsin\left(\sqrt{\sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_1)\cos(\phi_2)\sin^2\left(\frac{\Delta\lambda}{2}\right)}\right)$$


3. **Queue Sorting:** Sort the driver’s queue by the shortest path (Traveling Salesperson Problem logic) to ensure the driver isn't doubling back across town.

---

## Implementation Roadmap

1. **Phase 1: Registration & Auth:** Build the self-service sign-up with an "Awaiting Approval" state.
2. **Phase 2: The Dispatch Board:** Create the list and map view. Use a Mapbox or Google Maps overlay to plot "Pending" pins.
3. **Phase 3: Driver Interface:** Build the simple "Next Task" view with a deep link to Google Maps/Apple Maps for navigation.
4. **Phase 4: Automation:** Script the Saturday night "Auto-Assign" that groups members by zip code or neighborhood and pushes them to driver queues.

Would you like me to draft a specific database schema for the **Users** and **Rides** tables to get your backend started?
