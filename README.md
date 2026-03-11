

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

## Database Schema & Logic

To build this efficiently, you need a relational structure that supports real-time updates and geographic queries. Using a PostgreSQL database with a PostGIS extension is the standard for handling location-based data.

### 1. **Users Table**

This table manages identity and role-based access control (RBAC).

* **UserID:** UUID (Primary Key)
* **Name:** String
* **Phone:** String (Verified via SMS for drivers)
* **HomeAddress:** String
* **Coordinates:** Point (Lat/Long) — *Used for proximity logic*
* **Role:** Enum (Member, Driver, Dispatcher, Manager, Admin)
* **Status:** Enum (Pending, Approved, Deactivated)

### 2. **Rides Table**

This table tracks the lifecycle of each transport request.

* **RideID:** UUID (Primary Key)
* **MemberID:** UUID (Foreign Key to Users)
* **DriverID:** UUID (Foreign Key to Users, Nullable until assigned)
* **RequestDate:** Timestamp
* **ScheduledTime:** Timestamp (Sunday Morning Window)
* **Status:** Enum (Requested, Assigned, In_Progress, Completed, Cancelled)
* **QueuePosition:** Integer (Defines the stop order for the driver)

---

## Technical Integration & Logic

### Geographic Proximity Logic

To automate the assignment, use a **Bounding Box** or **Radial Search**. When a ride is requested, the system should:

1. Identify the Member's `Coordinates`.
2. Query the **Users Table** for all `Drivers` where `Status = 'Approved'`.
3. Calculate the distance.

### Auto-Assign Workflow

For a Sunday morning "Quick Win," run a batch script on Saturday night:

* **Step 1:** Group all "Requested" rides by Neighborhood/Zip Code.
* **Step 2:** Match clusters to the nearest available Driver's `HomeAddress`.
* **Step 3:** Order the `QueuePosition` based on the most efficient route from the Driver's home to the Church.

---

## Interface Requirements

### Dispatcher Map View

The dispatcher needs a real-time dashboard.

* **Map Markers:** Red for unassigned, Green for assigned, Blue for drivers in motion.
* **Action:** Clicking a Red marker opens a sidebar showing the 3 closest drivers based on current queue load.

### Driver Mobile View

A focused, "No-Distraction" interface:

* **Current Stop:** Large text address with a "Start Navigation" button.
* **Action Button:** "Member Picked Up" (Updates status to `In_Progress` and notifies Dispatch).
* **Queue View:** A simple list of the next 2-3 stops to help them plan.

---

## Next Steps for Execution

1. **Define Your Tech Stack:** Are you leaning toward a No-Code solution (Glide/Softr) for speed, or a Custom Build (Flutter/Firebase) for scalability?
2. **Geocoding:** You will need a Google Maps or Mapbox API key to turn text addresses into coordinates.

To get your backend infrastructure started, I have provided a SQL script using standard PostgreSQL syntax. This includes the `PostGIS` extension for spatial calculations, which is essential for your "nearby pick-up" auto-assign logic.

### Database Setup Script

```sql
-- Enable spatial features
CREATE EXTENSION IF NOT EXISTS postgis;

-- 1. Create User Roles
CREATE TYPE user_role AS ENUM ('member', 'volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin');
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'deactivated');

-- 2. Users Table (Core Identity)
CREATE TABLE users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    phone TEXT,
    home_address TEXT NOT NULL,
    coordinates GEOGRAPHY(POINT, 4326), -- Longitude/Latitude for spatial queries
    role user_role DEFAULT 'member',
    status approval_status DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Ride Requests Table
CREATE TYPE ride_status AS ENUM ('requested', 'assigned', 'in_progress', 'completed', 'cancelled');

CREATE TABLE rides (
    ride_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID REFERENCES users(user_id),
    driver_id UUID REFERENCES users(user_id),
    dispatcher_id UUID REFERENCES users(user_id),
    scheduled_for DATE NOT NULL, -- Specifically for the upcoming Sunday
    status ride_status DEFAULT 'requested',
    queue_order INT, -- The sequence in the driver's route
    pickup_notes TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

```

---

## Proximity Query Logic

When a dispatcher looks for a driver, you can use the following logic to find the 5 closest approved drivers to a specific member's home:

```sql
SELECT full_name, home_address, 
       ST_Distance(coordinates, (SELECT coordinates FROM users WHERE user_id = '[MEMBER_ID]')) AS distance_meters
FROM users
WHERE role = 'volunteer_driver' 
  AND status = 'approved'
ORDER BY coordinates <-> (SELECT coordinates FROM users WHERE user_id = '[MEMBER_ID]')
LIMIT 5;

```

---

## User Flow & Approval Logic

To ensure the "Admin Approval" step is robust, the application logic should follow this state machine:

1. **Registration:** User signs up, enters address, and selects a role (e.g., Driver).
2. **Geocoding:** The system automatically converts the text address to `Coordinates` using a Maps API.
3. **Hold State:** The account is locked. The **People Manager** sees a "Pending" list.
4. **Activation:** Once approved, the user appears in the Dispatcher's map and list.

## Implementation Detail: The "Navigate to Next" Function

For the drivers, you don't need to build a map system from scratch. You can use **URL Schemes** to deep-link into the driver's preferred app:

* **Google Maps:** `https://www.google.com/maps/dir/?api=1&destination=[Lat],[Long]`
* **Apple Maps:** `http://maps.apple.com/?daddr=[Lat],[Long]`

This allows your app to stay simple and lightweight while providing professional-grade navigation.

To implement the **Auto-Assign** logic, you'll need a script that runs on a schedule (e.g., every Saturday at 6:00 PM) to clear the "Requested" backlog and populate the driver queues.

## 1. Auto-Assign Logic (Pseudo-Code/Logic)

The goal is to minimize the total driving distance while ensuring no driver is overloaded. This follows a "Nearest Neighbor" approach.

### The Algorithm:

1. **Filter:** Get all `rides` for the upcoming Sunday with status `requested`.
2. **Filter:** Get all `users` with role `volunteer_driver` and status `approved`.
3. **Cluster:** For each `requested_ride`:
* Find the `driver` whose `home_address` is closest to the `member_id.home_address`.
* Check the driver's current `queue_count`. If it’s under the limit (e.g., 4 riders), assign the ride.
* If the closest driver is full, move to the next closest.


4. **Sequence:** Once a driver has a list of assignments, sort them by distance from the driver's home to create the `queue_order`.

---

## 2. API Endpoints (Node.js/Express Example)

These endpoints will power the Dispatcher and Driver views.

### POST `/api/rides/auto-assign`

*Logic to trigger the batch assignment script.*

```javascript
// Example logic for finding the nearest driver using the SQL logic provided earlier
const assignRides = async (sundayDate) => {
    const unassignedRides = await db.query("SELECT * FROM rides WHERE status = 'requested' AND scheduled_for = $1", [sundayDate]);
    
    for (let ride of unassignedRides) {
        const nearestDriver = await db.query(`
            SELECT user_id FROM users 
            WHERE role = 'volunteer_driver' AND status = 'approved'
            ORDER BY coordinates <-> (SELECT coordinates FROM users WHERE user_id = $1)
            LIMIT 1`, [ride.member_id]);

        if (nearestDriver) {
            await db.query("UPDATE rides SET driver_id = $1, status = 'assigned' WHERE ride_id = $2", 
            [nearestDriver.user_id, ride.ride_id]);
        }
    }
};

```

### GET `/api/driver/queue/:driverId`

*Powers the driver's Sunday morning list.*

```sql
SELECT r.ride_id, u.full_name, u.home_address, u.phone, r.queue_order
FROM rides r
JOIN users u ON r.member_id = u.user_id
WHERE r.driver_id = $1 
  AND r.status IN ('assigned', 'in_progress')
  AND r.scheduled_for = CURRENT_DATE -- or the upcoming Sunday
ORDER BY r.queue_order ASC;

```

---

## 3. Dispatcher "Drag and Drop" Logic

When a Dispatcher "moves things around" on the UI, the frontend should send a `PATCH` request to update the `queue_order` and `driver_id`.

**Optimization Tip:** When a ride is moved from Driver A to Driver B, your backend should automatically trigger a "re-sequence" function to refresh the `queue_order` for both drivers to ensure their GPS route still makes sense.

---

## Technical Considerations for Logistics

* **Geocoding Quota:** Since you are a church group, look into **OpenStreetMap (Nominatim)** for free geocoding to avoid high Google Maps API costs.
* **Concurrency:** If two dispatchers move the same ride at the same time, ensure your database uses **Transactions** to prevent data corruption.
* **Data Integration:** Ensure your user roles are strictly enforced at the API level (e.g., a `volunteer_driver` token cannot access the `all_users` list).


To maintain high operational efficiency, the Dispatcher Dashboard needs to prioritize high-level situational awareness and low-friction adjustments. A **Master-Detail split view** is the most effective layout for this.

## Dispatcher Dashboard Wireframe

### 1. The Global Header

* **Active Count:** Displays "Unassigned Requests," "Active Drivers," and "Completed Rides."
* **Date Picker:** Defaults to the upcoming Sunday.
* **Quick Action:** "Run Auto-Assign" button (with a confirmation modal).

---

### 2. Left Panel: The Request Feed (30% Width)

A scrollable list of all ride requests, filtered by status.

* **Unassigned Tab:** Cards showing Member Name, Neighborhood (e.g., "North Tucson"), and Time Requested.
* *Visual Cue:* Red border for rides requested over 24 hours ago.


* **Assigned Tab:** Grouped by driver name.
* **Interaction:** Clicking a card pans the map to that member’s location.

### 3. Center/Right: The Interactive Map (70% Width)

A full-screen map integration (Google Maps or Mapbox).

* **Member Pins:** * **Red:** Unassigned (needs attention).
* **Gray:** Assigned but not yet picked up.
* **Green:** Ride in progress.


* **Driver Pins:** Small van icons showing the driver's **Home Address** (or current location if using live GPS).
* **Assignment Lines:** Thin lines connecting a driver’s pin to their assigned member pins, visually tracing the Sunday morning route.

### 4. The Assignment Modal (Action Trigger)

When a dispatcher clicks an unassigned **Red Pin**:

* A pop-up appears listing the **Top 3 Closest Drivers** based on distance from that member.
* Shows the current "Load" for each driver (e.g., "3/5 rides assigned").
* **Button:** "Assign to [Driver Name]" which updates the database and pushes a notification to the driver.

---

## Driver Queue Management (The "Move Things Around" Logic)

To fulfill your requirement of moving requests between drivers:

* **The "Queue Drawer":** Clicking a Driver’s pin opens a side drawer showing their current sequence (1st stop, 2nd stop, etc.).
* **Drag-and-Drop:** Dispatchers can drag a member card out of Driver A’s queue and drop it into Driver B’s queue.
* **Optimization Trigger:** The system should prompt: *"Would you like to re-optimize this route?"* to recalculate the most efficient sequence ($1 \rightarrow 2 \rightarrow 3$) for the new driver.

---

## Technical Optimization for Logistics

* **Clustering:** If 10 members live in the same retirement community, the map should "cluster" them into one icon with a number until the dispatcher zooms in.
* **Real-Time Sync:** Use **WebSockets** (Socket.io or Supabase Realtime) so that when one dispatcher moves a ride, all other dispatchers see the map pin change color instantly.

The **Volunteer Driver** interface must be "glove-friendly" and high-contrast, designed for use in a vehicle. It should prioritize the current task while providing visibility into the immediate future.

## Volunteer Driver Mobile UI

### 1. The "Active Task" Dashboard (Home)

This is the primary screen the driver sees upon starting their Sunday shift.

* **Current Destination Card:** Displays the next member's name, phone (with a "Call" icon), and full address.
* **"Navigate" Button:** A large, prominent button that deep-links to Google Maps or Apple Maps.
* **"Arrived / Picked Up" Toggle:** A slide-to-confirm action (to prevent accidental taps) that marks the ride as `in_progress`.
* **Status Indicator:** Shows the driver’s progress (e.g., "Stop 2 of 5").

### 2. The Sunday Queue View

A secondary tab or bottom sheet that allows the driver to see the full "manifest" for the morning.

* **List View:** Chronological list of all assigned addresses.
* **Visual Map:** A simplified map showing their route as a "breadcrumb" trail.

---

## Technical Workflow: "Navigate to Next"

To ensure the "Navigate to Next" function is seamless, the app should use the following logic when the driver completes a pickup:

1. **State Update:** Driver slides "Picked Up."
2. **Database Sync:** The `rides` table updates the status to `completed` for that MemberID.
3. **Next Target:** The app queries the local state for the next `queue_order` integer.
4. **Auto-Refresh:** The "Current Destination Card" automatically updates with the next address.
5. **Navigation Handoff:**
* **iOS:** `maps://?daddr=[Lat],[Long]&dirflg=d`
* **Android:** `google.navigation:q=[Lat],[Long]`



---

## Role/People Manager & Admin Views

### People Manager Portal

This role is the gatekeeper of the community.

* **User Directory:** A searchable list of all registered members.
* **Pending Approvals:** A dedicated "Inbox" where the manager reviews new registrations.
* **Role Override:** Ability to upgrade a `member` to a `volunteer_driver` after background checks/insurance verification.

### Super Admin Controls

* **System Configuration:** Set the "Max Capacity" per driver.
* **Audit Logs:** View a history of who moved which ride and when.
* **Emergency Broadcast:** Send an SMS to all active drivers in case of a service cancellation (e.g., weather).

---

## Data-Driven Optimization (Pro Tip)

As the database grows, you can move from simple distance-based assignment to **Time-of-Day optimization**.

* **Logic:** The system can track how long a pickup usually takes (e.g., "Mr. Smith needs 5 minutes to get to the car").
* **Benefit:** This adjusts the `scheduled_for` time for subsequent pickups in the queue, giving the dispatcher and members a more accurate ETA.

Clear, timely communication is the "glue" that makes a logistics system like this feel professional and reliable. For an autistic user or anyone who values structured information, these notifications provide necessary predictability.

I recommend using a service like **Twilio** or **AWS SNS** for these, as SMS has a higher open rate than app notifications for church groups.

---

## 1. Member Notifications (Predictability)

### **Ride Confirmed (Sent Saturday Evening)**

Sent once the Auto-Assign script runs or a dispatcher manually confirms the route.

> **Subject:** Your Church Ride for Sunday
> **Body:** Hello [Name], your ride for tomorrow is confirmed. [Driver Name] will pick you up at [Home Address]. Estimated arrival: [Time Range]. Please be ready 5 minutes early.

### **Driver En Route (Sent Sunday Morning)**

Triggered when the driver clicks "Navigate to Next" in their app.

> **Body:** Hi [Name], your driver [Driver Name] is on the way! They are currently [Estimated Minutes] away in a [Vehicle Description].

---

## 2. Driver Notifications (Operational)

### **Queue Published (Sent Saturday Evening)**

Alerts the volunteer that their Sunday morning task list is ready.

> **Body:** Hello [Driver Name], your pickup queue for tomorrow is ready. You have [Number] stops scheduled. View your route here: [Link to Driver App].

### **Schedule Change (Real-time)**

Triggered if a dispatcher moves a ride into their queue manually on Sunday morning.

> **Body:** ALERT: Your pickup queue has been updated by the dispatcher. One new stop added. Please check your app for the updated route.

---

## 3. Automation Logic for ETAs

To make the "10 minutes away" message accurate without manual driver input:

1. **Geofencing:** Create a virtual perimeter ($1.5$ miles) around the member's coordinates.
2. **Trigger:** When the driver's GPS coordinates enter that circle, the system automatically fires the "En Route" SMS.
3. **Calculation:** Use the **Distance Matrix API** to calculate real-time traffic:

$$ETA = \frac{Distance}{Average Speed} + Buffer$$



---

## Implementation Pathway Summary

| Component | Technology |
| --- | --- |
| **Backend** | PostgreSQL (PostGIS) + Node.js |
| **Frontend** | React (Dispatcher) / React Native (Driver/Member) |
| **Maps/Geo** | Mapbox or OpenStreetMap (Nominatim) |
| **Messaging** | Twilio SMS API |

This structure addresses both the **immediate need** (getting people to church) and the **long-term goal** (a scalable, automated community tool).

Building a system with multiple moving parts requires a clear view of how data and signals flow between the different user roles and services.

## System Architecture Diagram

The diagram below illustrates how the **Central Database** acts as the single source of truth, connecting the high-level management tools with the real-time mobile interfaces.

### Component Breakdown

1. **The Core (PostGIS Database):** Stores user roles, geocoded coordinates, and the Sunday ride manifest.
2. **External Services Layer:**
* **Maps API:** Converts addresses to coordinates and calculates the "Navigate to Next" routes.
* **SMS Gateway (Twilio):** Automates the member and driver notifications.


3. **Application Clients:**
* **Admin/Dispatcher Web Portal:** High-density data views for managing roles and moving pins on the map.
* **Driver Mobile App:** Simplified, GPS-enabled interface for navigation and queue updates.
* **Member Mobile/Web App:** Simple interface for requesting rides and viewing status.



---

## Data Flow for a Single Ride Lifecycle

To ensure system integrity, every ride follows this structured data path:

| Stage | Action | System Logic |
| --- | --- | --- |
| **Request** | Member submits ride request via app. | Entry added to `Rides` table with `status: requested`. |
| **Assign** | Auto-assign script or Dispatcher assigns a driver. | `driver_id` updated; `queue_order` calculated; SMS sent to Member. |
| **Active** | Driver clicks "Navigate" to pick up member. | `status` changes to `in_progress`; GPS tracking begins. |
| **Closing** | Driver confirms pick-up/drop-off. | `status` changes to `completed`; next ride in `queue_order` becomes active. |

---

## Technical Optimization: The "Quick Win" Setup

For the most efficient initial rollout, I recommend the following "Lean" stack:

* **Database & Auth:** **Supabase**. It provides PostgreSQL with PostGIS pre-installed and handles user sign-ups/approvals natively.
* **Dispatcher Interface:** A **React** web app using **Leaflet.js** (open-source) for the map view.
* **Driver Interface:** A **Progressive Web App (PWA)**. This avoids the complexity of the Apple/Google App Stores while still allowing drivers to save a shortcut to their home screen and use GPS navigation.

---

## Immediate Next Steps

To move this from a plan to a functional prototype, we should focus on the data entry and geocoding phase first.

This Python script uses the `geopy` library with the **OpenStreetMap (Nominatim)** service. It is a cost-effective way to clean your church member list and prepare it for the SQL database we designed.

### Geocoding Script (`geocode_members.py`)

```python
import pandas as pd
from geopy.geocoders import Nominatim
from geopy.extra.rate_limiter import RateLimiter
import time

# 1. Initialize Geocoder (Use a unique user_agent for your church group)
geolocator = Nominatim(user_agent="church_ride_app_v1")
geocode = RateLimiter(geolocator.geocode, min_delay_seconds=1)

def process_member_list(input_csv, output_csv):
    # Load your member list (Assumes columns: Name, Address)
    df = pd.read_csv(input_csv)
    
    print(f"Starting geocoding for {len(df)} members...")
    
    # 2. Apply Geocoding
    # This creates a 'location' object containing lat, long, and raw address data
    df['location'] = df['Address'].apply(geocode)
    
    # 3. Extract Latitude and Longitude
    df['latitude'] = df['location'].apply(lambda loc: loc.latitude if loc else None)
    df['longitude'] = df['location'].apply(lambda loc: loc.longitude if loc else None)
    
    # 4. Cleanup and Export
    # Drop the temporary location object before saving
    df_final = df.drop(columns=['location'])
    df_final.to_csv(output_csv, index=False)
    
    print(f"Success! Geocoded data saved to {output_csv}")

# Usage: 
# process_member_list('church_members.csv', 'geocoded_members.csv')

```

---

## Logistics & Accuracy Tips

* **Rate Limiting:** Nominatim requires a 1-second delay between requests (included in the script). If you have over 1,000 members, consider a paid service like **Google Maps API** or **Mapbox** for faster processing.
* **Address Formatting:** For best results in Tucson/Southern Arizona, ensure the address string includes the city and state (e.g., *"123 N Main St, Tucson, AZ"*).
* **Data Quality Check:** After running the script, filter for any rows where `latitude` is `None`. These are addresses the AI couldn't find—usually due to typos or new construction—and will need manual correction by the **People Manager**.

---

## Operational Workflow: From CSV to Database

1. **Cleanse:** Run the script above to get coordinates.
2. **Import:** Use a tool like **DBeaver** or the **Supabase Dashboard** to "Bulk Upload" the CSV into your `users` table.
3. **Map Check:** Open your Dispatcher Web Portal. Since the `coordinates` are now populated, all members will immediately appear as **Red Pins** on the map, ready for Sunday assignments.

### Summary of System Logic

This completes the technical foundation: you have the **Schema** (SQL), the **Logic** (Auto-assign/Proximity), the **Interface** (Wireframes), and the **Data Pipeline** (Geocoding).

## Project Requirements Document (PRD): Church Community Ride-Share

This document serves as the strategic and technical blueprint for the "Uber-like" church transportation system. It aligns immediate operational needs with long-term data-driven scalability.

---

## 1. Executive Summary

The goal is to provide a reliable, automated transportation solution for church members without vehicles. The system facilitates registration, admin-vetted role assignments, automated Sunday morning routing, and real-time dispatching.

## 2. User Roles & Permissions

| Role | Primary Function | Permissions |
| --- | --- | --- |
| **Member** | Request transportation | Create/View own requests; Receive SMS updates. |
| **Volunteer Driver** | Operational execution | View assigned queue; Navigation; Update ride status. |
| **Volunteer Dispatcher** | Logistics management | Map-based assignment; Manual queue overrides. |
| **People Manager** | Access control | Approve/Deactivate users; Role management. |
| **Super Admin** | System integrity | Global settings; Audit logs; Full database access. |

---

## 3. Technical Specifications

### Data Architecture

* **Database:** PostgreSQL with PostGIS for spatial queries.
* **Geocoding:** Nominatim (OpenStreetMap) or Google Maps API to convert addresses to $(lat, long)$ coordinates.
* **Hosting:** Supabase (Backend-as-a-Service) for rapid deployment and built-in Auth.

### Core Logistics Logic

* **Auto-Assign Algorithm:** Saturday evening batch process that clusters members by proximity to approved drivers.
* **Routing:** Uses the **Haversine Formula** for initial distance calculation and external Map APIs for street-level navigation.
* **Notification Engine:** Automated SMS triggers for "Ride Confirmed" and "Driver 10 Minutes Away."

---

## 4. Feature Roadmap

### Phase 1: Foundation (Weeks 1–2)

* Deploy Database Schema and User Auth.
* Implement self-service registration with "Pending Approval" state.
* Bulk geocode existing member lists using the Python utility.

### Phase 2: Dispatcher & Driver MVP (Weeks 3–4)

* Build the **Dispatcher Map View** with draggable pins.
* Launch the **Driver Mobile Interface** (PWA) with "Navigate to Next" functionality.
* Integrate Twilio for basic ride confirmations.

### Phase 3: Automation & Optimization (Weeks 5+)

* Activate the **Auto-Assign Script**.
* Implement geofencing for automatic "Driver is near" SMS alerts.
* Develop reporting dashboards to track driver utilization and missed pickups.

---

## 5. Security & Compliance

* **Vetting:** All drivers and dispatchers must be manually approved by the People Manager.
* **Data Privacy:** Member home addresses are only visible to assigned drivers and authorized dispatchers.
* **Encryption:** SSL/TLS for all data in transit; encrypted storage for PII (Personally Identifiable Information).

---

## Volunteer Driver Quick-Start Guide

**Objective:** To ensure every member is picked up safely and efficiently using the Sunday morning workflow.

---

### 1. Preparation (Saturday Evening)

Once the **Volunteer Dispatcher** finalizes the routes, you will receive a text message.

* **Action:** Click the link in the SMS to open your **Driver Dashboard**.
* **Review:** Look over your list of 3–5 stops. If you recognize a member or address that seems incorrect, contact the **Dispatcher** immediately via the "Help" button.

### 2. Starting Your Shift (Sunday Morning)

When you are ready to begin:

1. Open the app and tap **"Start Shift."**
2. Your **First Pickup** will appear at the top of the screen.
3. Tap the blue **"Navigate"** button. This will automatically open Google Maps or Apple Maps with the member's home address pre-loaded.

### 3. The Pickup Workflow

To keep the system updated in real-time, follow these three steps for every stop:

* **Step A: Arrival**
When you pull up to the home, tap **"Arrived."** This sends a "Driver is outside" text to the member so they know to come out.
* **Step B: Loading**
Once the member is safely in the vehicle, slide the green **"Member Picked Up"** bar. This tells the Dispatcher you are back on the move.
* **Step C: Next Stop**
The app will instantly refresh with the **Next Member** in your queue. Tap **"Navigate"** again to continue the route.

### 4. Special Situations

* **No-Show:** If a member doesn't appear after 5 minutes, tap **"Member No-Show."** The Dispatcher will be notified to call them, and you will be directed to your next stop.
* **Emergency:** Use the **"Contact Dispatcher"** button for any vehicle issues or if you fall significantly behind schedule.

---

## Driver App Interface Reference

* **Header:** Displays your total progress (e.g., "Stop 2 of 4").
* **Contact Icon:** Tap the phone icon to call the member directly if you can't find their house.
* **Notes Field:** Look here for specific instructions like "Gate Code 1234" or "Member uses a walker."

---

## Final Delivery to Church

Once all members in your queue are in the vehicle:

1. The app will display **"Final Destination: Church."**
2. Tap **"Navigate"** one last time.
3. Upon arrival at the church drop-off zone, tap **"Complete All Rides."**

This marks your shift as finished in the system and clears your queue for the next week.
## Dispatcher Troubleshooting Guide

**Objective:** Maintain operational flow when real-world variables disrupt the Sunday morning schedule.

---

### 1. Handling Driver Delays

If a driver is running more than 15 minutes behind their ETA:

* **Identify:** Look for the "Yellow" or "Red" delay indicators on the Master Map.
* **Action:** Click the driver's pin to see their current location.
* **Resolution:** * If they are near a cluster of pickups, **Reassign** the most urgent (earliest) pickups to a nearby "Green" driver with low capacity.
* Send a manual SMS to the affected members via the dashboard: *"Your ride is running late, but a new driver is being assigned. Thank you for your patience."*



### 2. Member "No-Show" or Cancellation

When a driver reports a "No-Show":

* **Action:** The member's pin will turn **Orange** on your map.
* **Contact:** Attempt to call the member using the phone number in their profile.
* **Resolution:** * If they forgot, ask them to be ready in 5 minutes and tell the driver to "Hold" or "Circle back" if the route allows.
* If they are not coming, mark the ride as **Cancelled**. This automatically moves the driver to their next stop.



### 3. Last-Minute Ride Requests

For members who call the church office on Sunday morning asking for a ride:

* **Manual Entry:** Use the **"Quick Add"** button on the Dispatcher Dashboard.
* **Geosearch:** Enter their address; the map will show the nearest active drivers.
* **Insertion:** Select the driver with the smallest queue and click **"Inject into Queue."** The system will automatically place it as the next logical stop and update the driver's app.

---

## Dispatcher Dashboard: Exception Management

| Event | Map Visual | Immediate Step |
| --- | --- | --- |
| **Driver Offline** | Pin turns Gray | Call driver; if no response, reassign entire queue. |
| **Route Overload** | Red Warning Text | Move the last 2 stops to a driver with only 1-2 assigned rides. |
| **Pick-up Completed** | Pin turns Green | No action needed; system is tracking successfully. |

---

## Success Metrics for Leadership

To justify the project and track its health, the **Super Admin** should review these data-driven KPIs (Key Performance Indicators) monthly:

* **Fulfillment Rate:** Percentage of requested rides that were successfully completed.
* **Average Wait Time:** Time from the "Arrival" notification to the "Member Picked Up" confirmation.
* **Volunteer Retention:** How many drivers return for a second or third Sunday shift.

---

## Technical Maintenance

* **Saturday Night Audit:** Always run a manual check of the **Auto-Assign** results at least 12 hours before the first pickup.
* **Database Backup:** Ensure Supabase/PostgreSQL is set to daily backups to prevent data loss.

**This concludes the full documentation suite for your Church Ride-Share App.**


