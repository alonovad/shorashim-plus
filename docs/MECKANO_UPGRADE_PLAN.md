# Attendance Module — Meckano-Grade Upgrade Plan

**Status:** draft v0.1 — for spec review, no code yet
**Owner:** Shorashim Plus
**Target:** parity with Meckano's core attendance + Israeli payroll-export feature set
**Today's baseline:** `public/js/timeclock.js` — single-shift punch in/out, workplace selector, CSV export, simple admin dashboard.

---

## 1. What "Meckano-grade" actually means

Meckano is the de-facto Israeli SMB time & attendance product. To match it we need eight pillars, in this order of importance:

| # | Pillar | Today | Target |
|---|---|---|---|
| 1 | Reliable clock in/out across web + mobile | ✅ have | Keep, harden offline queue |
| 2 | Geofencing / location proof | ❌ none | GPS proof per punch, geofence per plot/site |
| 3 | Shift schedule (expected hours, days off) | ❌ none | Per-employee weekly schedule with exceptions |
| 4 | Break tracking + auto-deduction | ❌ none | Manual + automatic break rules |
| 5 | Overtime tiers (Israeli labor law 125% / 150%) | ❌ none | Daily + weekly OT calculation |
| 6 | Leave management (vacation / sick / reserve / holiday) | ❌ none | Requests, approvals, balance accounting |
| 7 | Approval workflow + audit trail | partial | Every edit logs who/when/before/after |
| 8 | Monthly timesheet + payroll-system export | partial CSV | Meckano-format PDF + Hilan / Michpal / Shiklulit CSV |

Everything below maps to those pillars.

---

## 2. Data model changes

### 2.1 New Firestore collections

```
timeclock/{punchId}            — already exists, extend fields (see 2.2)
schedules/{userId}             — weekly schedule + exceptions
leave-requests/{requestId}     — leave applications + status
leave-balances/{userId}        — running balances per leave type
holidays/{year}                — Israeli public + religious holidays
audit-log/{entryId}            — every edit/delete on time records
sites/{siteId}                 — geofenced work locations (subsumes 'workplaces')
```

`firestore.rules` whitelist needs entries for each new key prefix.

### 2.2 Extended `timeclock/{punchId}` schema

```js
{
  // Existing
  punchIn, punchOut, workplace, username, userName, shiftIndex, date, duration,

  // NEW — location proof
  punchInGeo:  { lat, lng, accuracy, source: 'gps'|'manual', siteId? },
  punchOutGeo: { lat, lng, accuracy, source, siteId? },
  geoVerified: bool,            // within geofence at both ends
  geoWarnings: ['outside_geofence'|'low_accuracy'|'manual_override'],

  // NEW — breaks
  breaks: [{ start, end, type: 'lunch'|'short'|'personal', auto: bool }],
  paidMinutes:  int,            // duration minus unpaid breaks
  breakMinutes: int,

  // NEW — categorisation
  type:     'regular'|'overtime'|'leave'|'holiday'|'reserve'|'sick'|'vacation',
  projectCode: string?,         // optional billing/project tag
  taskCode:    string?,         // optional inner task

  // NEW — approval state
  status:   'pending'|'approved'|'rejected'|'auto_approved',
  approvedBy: username?,
  approvedAt: ts?,
  rejectionReason: string?,

  // NEW — calculated tiers (computed on save, not user-editable)
  hoursRegular:  number,        // ≤ daily cap
  hours125:      number,        // first 2 OT hours
  hours150:      number,        // beyond that
  hoursNight:    number,        // 22:00-06:00 — bonus tier in some sectors

  // NEW — verification
  ipAddress: string?,           // for browser punches
  device:    string?            // 'web'|'mobile'|'kiosk'|'manager_entry'

  // NEW — edits
  originalPunchIn:  ts?,        // if edited, retains original
  originalPunchOut: ts?,
  editReason:       string?
}
```

### 2.3 `schedules/{userId}` schema

```js
{
  userId,
  workWeek: 5 | 6,              // 5-day or 6-day week
  weeklyHours: 42,              // standard Israeli legal limit since 2018
  dailyHoursStandard: 8.4,      // computed from weeklyHours / workWeek
  schedule: {
    sun: { start: '08:00', end: '17:00', breakMinutes: 30 },
    mon: { start: '08:00', end: '17:00', breakMinutes: 30 },
    // ... thu, fri (short Friday), sat (off)
    fri: { start: '08:00', end: '13:00', breakMinutes: 0 },
    sat: null
  },
  flexibility: { graceMinutes: 15 },   // minutes of lateness ignored
  effectiveFrom: ts,
  effectiveTo: ts?,
  history: [...]                       // past schedules
}
```

### 2.4 `leave-requests/{requestId}` schema

```js
{
  userId, userName,
  type: 'vacation'|'sick'|'reserve'|'personal'|'unpaid'|'maternity'|'bereavement',
  startDate, endDate,             // inclusive
  startDay: 'full'|'half_am'|'half_pm',
  endDay:   'full'|'half_am'|'half_pm',
  totalDays: number,              // calculated
  reason: string?,
  attachmentUrl: string?,         // doctor's note, military reserve order, etc.
  status: 'pending'|'approved'|'rejected'|'cancelled',
  requestedAt, approvedBy, approvedAt, rejectionReason
}
```

### 2.5 `leave-balances/{userId}` schema

```js
{
  userId, year,
  accrual: {
    vacation: { earned: 14, used: 6, pending: 2, remaining: 6 },
    sick:     { earned: 18, used: 3, pending: 0, remaining: 15 },
    reserve:  { used: 22 },        // tracked separately, no balance limit
    bereavement: { used: 0 }
  },
  carryOver: { vacation: 4 },      // from previous year
  history: [...]
}
```

Israeli annual minimums (legal floor) — auto-populated based on tenure:
- 0–4 years tenure → 12 vacation days
- 5 years → 14
- 6 years → 16
- 14+ years → 24
- Sick: 1.5 days/month, max 90 accrued

### 2.6 `audit-log/{entryId}` schema

```js
{
  ts, actor: username, action: 'edit'|'delete'|'approve'|'reject'|'create',
  target: 'timeclock'|'leave'|'schedule',
  targetId,
  before: {...},                   // full document snapshot
  after:  {...},
  reason: string?,
  ip, userAgent
}
```

### 2.7 `sites/{siteId}` schema

Replaces the current freeform `workplaces` list.

```js
{
  id, name, name_th?, name_ar?,    // trilingual via existing locName helper
  type: 'farm'|'office'|'site'|'custom',
  geofence: {
    center: { lat, lng },
    radiusMeters: 150,             // simple circle, OR
    polygon: [[lat,lng], ...]      // for irregular sites — reuses plot polygons!
  },
  linkedFarmId: int?,              // ties to farm — auto-import polygon
  linkedPlotIds: [int],            // tie attendance to specific plots
  active: bool,
  graceMeters: 50                  // extend geofence by this for accuracy fudge
}
```

**Key insight:** the user already drew plot polygons. We re-use them. A plot polygon IS the geofence shape — no extra drawing for the user. The radius (or polygon buffer) is set **per-plot**, with 100m as the initial fallback if not explicitly set.

### 2.8 `holidays/{year}` schema

```js
{
  year, country: 'IL',
  holidays: [
    { date: '2026-04-02', name_he: 'פסח', name_th: 'ปัสกา', name_ar: 'عيد الفصح', paid: true, halfDay: false },
    ...
  ]
}
```

Auto-seeded from Hebcal API on first load. Cached per year.

---

## 3. Feature roadmap (sequenced for incremental delivery)

### Phase 1 — Foundation (1 deploy, ~600 LOC)

Goal: harden what we have, add the data shape Phase 2 needs.

- [ ] Migrate `workplaces` → `sites` collection. Auto-create site per farm using the polygon as geofence.
- [ ] Extend `timeclock/*` schema (additive only — old records remain readable).
- [ ] Add `audit-log` writes on every record edit/delete (manager dashboard already has these actions).
- [ ] Add `firestore.rules` whitelists.
- [ ] Offline punch queue using IndexedDB — punches made offline sync when connection returns. Currently `db.collection(...).set` silently fails offline.

**Risk:** the IndexedDB queue needs careful sequencing so a stale offline punch can't overwrite a fresh one. Use server-side merge with `Math.min`/`Math.max` for punchIn/punchOut times.

### Phase 2 — Geofence + breaks (1 deploy, ~800 LOC)

- [ ] Request geolocation permission at punch time; log accuracy + warn if > 100m.
- [ ] Check punch location against `sites/*` geofence (point-in-polygon for plot polygons, point-in-circle for simple sites). Set `geoVerified` flag.
- [ ] Manager-side override: a punch can be force-approved with `geoWarnings: ['manual_override']` and a reason.
- [ ] Break UI in the clock-bar: ☕ button opens "start break / end break / type". Multiple breaks per shift.
- [ ] Auto-break rule: if shift > 6h and no manual break logged, deduct 30min unpaid (configurable per site).

**Risk:** GPS accuracy on Android in arid open areas can drift 20–50m even outdoors. Mitigate with `graceMeters` per site and a manager-side "explain and approve" override path.

### Phase 3 — Schedules + overtime (1 deploy, ~1000 LOC)

- [ ] Schedule editor (admin only): pick week template per employee, set effective date.
- [ ] On punch out, calculate `hoursRegular`, `hours125`, `hours150`, `hoursNight` using:
  - Israeli law 2018+: 8.6h/day standard, OT at 1.25× for first 2 hours past schedule, 1.5× thereafter.
  - Weekly cap of 42h regular hours (post-2018 reform).
  - Night work bonus: ≥ 4 hours between 22:00–06:00.
- [ ] Late/early-leave detection — compare punch times to schedule. Manager dashboard flags > graceMinutes deviation.
- [ ] "Expected vs actual" widget on the user's own dashboard: today / week / month.

**Risk:** Israeli labor law has many exceptions (shomer Shabbat, agriculture sector — relevant!, youth, women post-childbirth). MVP applies the agriculture-sector defaults; admin can manually override OT classification.

### Phase 4 — Leave management (1 deploy, ~1200 LOC)

- [ ] Leave request UI for employees: pick type, dates, half-day options, attach note.
- [ ] Manager approval queue with one-tap approve/reject.
- [ ] Balance calculator: auto-credits monthly vacation/sick accrual.
- [ ] Israeli holidays auto-fetched from Hebcal `https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&mod=on&i=on&year=YYYY` once per year, cached in `holidays/{year}`.
- [ ] Approved leave creates synthetic `timeclock` entries (`type: 'vacation' | 'sick' | ...`) so monthly summaries treat them uniformly.
- [ ] Reserve duty (מילואים) — separate flow, no balance limit, requires PDF upload of order.

**Risk:** Mid-month policy changes (e.g., admin retroactively edits vacation balance). Resolve via the audit log + a balance recalculation job.

### Phase 5 — Reporting + payroll export (1 deploy, ~700 LOC)

- [ ] Monthly timesheet PDF per employee — Meckano-shaped layout:
  - Header: month, employee, ID, position
  - Day-by-day table: date / day-of-week / punch-in / punch-out / break / regular hrs / 125% / 150% / notes
  - Footer: totals by category, signature box
- [ ] Same data as Excel via SheetJS (already available in the project for spray exports if added).
- [ ] Payroll CSV exporters (one button per format):
  - **Hilan** (חילן) — header rows + per-employee detail rows; spec lives at `assets/payroll-formats/hilan-spec.md`
  - **Michpal** (מיכפל) — tab-separated, fixed columns
  - **Shiklulit** (שקלולית) — XML format
- [ ] Manager dashboard upgrades: "live who's in" (uses `currentShift` from each user), missing-punch alerts.
- [ ] Email/push notification when:
  - Employee forgot to punch out (after 14h on shift)
  - Manager has > 5 pending approvals
  - Leave balance dropping below threshold

**Risk:** Payroll-system formats change without notice. Wrap each in its own module so swapping a column is a one-file edit.

### Phase 6 — Polish (1 deploy, ~400 LOC)

- [ ] Kiosk mode for field tablets — large clock face, PIN-based punch (no per-employee login on device).
- [ ] NFC card support for kiosk (Web NFC API where available, fallback to QR scan).
- [ ] Shift swap requests between employees with manager approval.
- [ ] "Forgot my password" / SMS-based punch (for workers without smartphones — request and confirm code).
- [ ] Multi-employer support if a worker has shifts in multiple farms with different employers (export per employer).

---

## 4. UI surfaces (sketched, not built)

```
┌───────────────────────────────────────┐
│ ⏱ 03:47:21    ☕ Break    🟢 Punched in │   <- existing clockBar, extended
│ Site: Paran-North  📍 GPS verified ✓  │
└───────────────────────────────────────┘

┌─── My Attendance ───────────────────┐
│  📅 This week                       │
│   M  T  W  T  F  S  S               │
│   ✓  ✓  ✓  ⚠  ·  ·  ·               │  <- check / late / leave / off
│  Hours so far: 27.3 / 42.0          │
│  Overtime: 1.5h                     │
│                                     │
│  📋 Leave balance                   │
│   Vacation: 8.5 / 14 days           │
│   Sick:     15 / 18 days            │
│   [Request leave]                   │
└─────────────────────────────────────┘

┌─── Manager view ────────────────────┐
│  🟢 Currently in: 14                │
│     - Alon, Paran-N, since 06:12    │
│     - Mohammed, Paran-S, 06:45      │
│     ...                              │
│                                     │
│  ⏳ Pending approvals: 5            │
│     - 3 leave requests              │
│     - 2 punch edits                 │
│                                     │
│  ⚠ Anomalies today: 2               │
│     - Yossi: missed punch-out yesterday│
│     - Rami: GPS outside Paran-W (12m)│
└─────────────────────────────────────┘
```

---

## 5. Implementation order and effort

| Phase | LOC | Deploy risk | User-visible | Build effort |
|---|---|---|---|---|
| 1. Foundation | ~600 | Low (additive) | Minimal | 1 session |
| 2. Geofence + breaks | ~800 | Medium (location prompts) | High | 1–2 sessions |
| 3. Schedules + OT | ~1000 | High (legal calculations) | High | 2 sessions |
| 4. Leave management | ~1200 | Medium | High | 2 sessions |
| 5. Reports + payroll | ~700 | Low | Manager-only | 1 session |
| 6. Polish | ~400 | Low | Variable | 1 session |

Total: ~4700 LOC, 8–9 sessions for full parity. Each phase ships independently and provides value.

---

## 6. Decisions locked (answered by product owner)

| # | Question | Decision | Implementation note |
|---|---|---|---|
| 1 | Sector defaults for OT | Agriculture defaults out of the box, **per-employee override** available | `schedules/{userId}` gets an `otRules` field. If absent, fall back to global agriculture defaults. UI: an "OT rules" toggle in the per-employee schedule editor opens an override panel. |
| 2 | Who is "the manager" | The existing `operator` role | No new role. Existing role-gating already handles operator-only screens — extend the same pattern to approval queues. |
| 3 | Geofence radius | **Per-plot setting** (no global default) | Each plot doc gets a `geofence.radiusMeters` field. Sensible initial value 100m, editable from the plot edit modal (new field next to area). For plots without an explicit radius, fall back to 100m and surface a one-time prompt to set it. |
| 4 | Selfie capture | **No selfies** | Drop the selfie feature entirely from the spec. Storage cost saved, one less permission prompt. Geofence + GPS accuracy is the verification level. The `selfieUrl` field is removed from the `timeclock/*` schema; `requireSelfie` removed from `sites/*`. |
| 5 | Payroll target | **Hilan (חילן)** is the first build target, but the exporter layer is **pluggable** | Build `exporters/hilan.js` first. Define a common `TimesheetExporter` interface — `{ format(records, employees) → { filename, content } }` — so adding Michpal / Shiklulit / custom CSV later is a one-file drop-in. |
| 6 | Worker phones | **All workers have smartphones** | Kiosk mode stays in Phase 6 polish. No need to ship it early. The standard mobile flow covers everyone. |
| 7 | Migrate old records? | **No** — leave existing `timeclock/*` records as-is | New fields apply only to records created after Phase 1 deploys. Reports that aggregate across the cutoff handle missing fields with sensible fallbacks (no geo → `geoVerified: null`, all hours → `regular`). Manager dashboard gets a "before vs after Phase 1" indicator. |

These decisions are now spec — anything that would change them needs a written change request rather than a chat correction.

---

## 7. Non-goals (explicitly)

- Not building a full HR/HRIS — only the attendance + leave slice Meckano covers.
- No salary calculation — that stays in the payroll system, we just export the inputs.
- No mobile-native app for now (PWA covers it).
- No biometric (fingerprint) and no selfie/photo verification — geofence + GPS accuracy is the proof level.
- No multi-tenant SaaS — each customer is a separate Firebase project.

---

## 8. Definition of done (per phase)

Each phase ships only when:
1. New Firestore rules deployed and tested against worker / manager / admin roles.
2. Service worker cache bumped.
3. CSS additions append-only.
4. All visible strings wrapped in `tt()` for he/th/ar.
5. Offline behavior verified (airplane mode → re-connect).
6. `node -c` clean on all changed JS.
7. One end-to-end manual walkthrough recorded.

---

End of v0.1 plan. Confirm direction and answer §6 questions, then we kick off Phase 1.
