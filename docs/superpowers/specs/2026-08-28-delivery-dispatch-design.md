# Delivery Dispatch Module Design Specification

Date: 2026-08-28

## Decision

Add the delivery dispatch module to `D:\autocount-pwa-dashboard`. Keep
`D:\autocount-mobile-quick-invoice` focused on creating and editing invoices,
and add only an **Open Dispatch** link there.

A delivery trip is a company-neutral operational record. The same trip may
contain invoices from both:

- `enterprise` — Wanson Enterprise
- `sdn_bhd` — Wanson Enterprise (M) Sdn Bhd

Every invoice card, assignment, loading-sheet line, status event, and report
row retains its `company_key`. Combining invoices for physical loading must
never erase accounting ownership.

## Why this is the lowest-disruption architecture

### Recommended: dashboard-owned dispatch UI, API, and database

Pros:

- Dispatch appears in the operations-oriented dashboard, where desktop drag
  and drop and period reporting fit naturally.
- Quick Invoice's tested invoice-issue path remains untouched except for one
  navigation link.
- The dashboard uses same-origin APIs, avoiding browser CORS and cross-project
  write failures.
- One Postgres transaction can protect trip capacity, duplicate assignment,
  audit events, and item snapshots.

Cons:

- The dashboard must gain a second-company AutoCount read adapter and durable
  database support.
- Some company configuration concepts are duplicated from Quick Invoice; the
  two projects must keep the same public company keys.

### Alternative: put dispatch inside Quick Invoice

Pros: existing two-company configuration and invoice parsing are closer to the
feature.

Cons: it expands a narrow mobile invoice workflow into a desktop operations
system, increases regression risk in a dirty/behind repository, and makes the
dispatch board harder to discover from the Sales Dashboard. Not recommended.

### Alternative: create a third standalone dispatch app

Pros: strongest technical separation and independent deployment.

Cons: a third PWA, third navigation surface, extra authentication, and another
deployment to operate. This is clean in theory but is not the lowest-disruption
choice for the current scale. Not recommended for v1.

## Clerk workflow

1. Clerk opens **Dispatch** from the Sales Dashboard or Quick Invoice.
2. Clerk signs in to the protected dispatch surface.
3. The Unassigned area loads eligible, non-cancelled invoices from both
   companies for the selected invoice-date range.
4. Each card displays a permanent company badge, invoice number, customer,
   delivery address, and item summary.
5. Clerk creates or opens a trip, selecting trip date, driver, lorry, and
   optional route notes.
6. On desktop, clerk drags an invoice to the trip. On touch/mobile or keyboard,
   clerk selects an invoice and chooses **Assign to trip**. Both gestures call
   the same API.
7. The server revalidates the source invoice, snapshots its header and item
   lines, writes the assignment, and writes an audit event in one transaction.
8. Clerk presses **Print Items** to print a combined physical loading sheet.
9. Clerk moves the trip through Planned, Loading, Dispatched, Completed, or
   Cancelled and updates invoice delivery outcomes.
10. At period end, clerk filters and exports the delivery record. The default
    report is combined; company filters provide accounting-specific views.

## UI structure

`public/dispatch.html` will provide four compact views:

- **Board** — combined Unassigned list on the left and trip columns/cards on
  the right; optional company filters do not change trip ownership.
- **Trips** — date-based trip list and trip detail/status controls.
- **Reports** — period, company, driver, lorry, and status filters with CSV
  export.
- **Resources** — minimal driver and lorry maintenance.

Desktop supports drag and drop. Mobile uses a tap-first assignment flow. Every
state-changing control remains keyboard accessible.

## Combined loading sheet

The **Print Items** action prints one sheet for the physical trip, even when it
contains both companies. Item aggregation uses the exact key:

`company-neutral total = sum(quantity) grouped by item_code + UOM`

The printed table contains:

| Item code | Description | UOM | Enterprise | Sdn Bhd | Total loaded |
| --- | --- | --- | ---: | ---: | ---: |
| 5KG | Example item | UNIT | 120 | 80 | 200 |
| AJINOMOTO | Example item | CTN | 1 | 2 | 3 |

Rules:

- Never combine different item codes merely because descriptions match.
- Never combine different UOMs. `3 CTN` and `30 UNIT` remain separate unless
  AutoCount provides an authoritative conversion rule; v1 does not invent one.
- Values and prices are excluded from the loading sheet.
- The sheet header shows trip, date, driver, lorry, route, total invoice count,
  and invoice count per company.
- An invoice checklist at the bottom keeps company badge/name, invoice number,
  and customer visible for loading verification.

## Data ownership and snapshots

Postgres is the source of truth for dispatch state. AutoCount remains the
source of truth for invoices.

At assignment time, persist immutable invoice header and item-line snapshots.
Period reports and loading sheets read those snapshots rather than mutable live
invoice data. A later AutoCount cancellation is surfaced as an exception; it
does not silently delete dispatch history.

Core tables:

- `dispatch_drivers`
- `dispatch_vehicles`
- `delivery_trips`
- `delivery_assignments`
- `delivery_assignment_items`
- `delivery_events`

The database enforces one non-removed assignment for each
`(company_key, invoice_id)`, while allowing the same invoice number to exist in
different companies.

## Status model

Trip statuses:

`planned -> loading -> dispatched -> completed`

`planned|loading -> cancelled`

Assignment outcomes:

`assigned -> loaded -> out_for_delivery -> delivered`

`out_for_delivery -> failed|returned`

`assigned|loaded -> removed`

The server rejects invalid transitions. Trips cannot be dispatched without an
active driver, active lorry, and at least one non-removed assignment.

## API surface

All routes are same-origin Vercel Functions and require a valid dispatch
session:

- `/api/dispatch/session` — sign in, current session, sign out
- `/api/dispatch/resources` — active drivers and lorries; create/deactivate
- `/api/dispatch/invoices` — combined eligible feed from both companies
- `/api/dispatch/trips` — list, create, update metadata/status
- `/api/dispatch/assignments` — assign, move, remove, update outcome
- `/api/dispatch/loading-sheet` — persisted combined item totals and checklist
- `/api/dispatch/reports` — period-end JSON/CSV records

Write requests use a request id for idempotency and a trip revision for
optimistic concurrency. Conflicts return `409` and the UI refreshes the affected
trip rather than pretending the move succeeded.

## Security and deployment

- Use a Marketplace Postgres integration connected to the dashboard project;
  Vercel no longer provisions the former Vercel Postgres product directly.
- Keep database and AutoCount credentials in Vercel environment variables.
- Use a small server-side clerk list with scrypt-hashed PINs and an HMAC-signed,
  Secure, HttpOnly, SameSite cookie. No write API is public.
- Do not cache dispatch write requests in the service worker.
- If offline, static screens may open but assignment and status controls are
  disabled until the server is reachable. V1 has no offline write queue.

## Out of scope for v1

- Route optimization or GPS tracking
- Automatic UOM conversion or lorry weight calculation
- Driver payroll/commission
- Proof-of-delivery photo/signature capture
- Editing or issuing invoices from the dispatch board
- Automatic e-Invoice actions

## Acceptance criteria

- Both companies' eligible invoices are visible together with unmistakable
  company tags.
- One trip can hold invoices from both companies.
- The same `(company_key, invoice_id)` cannot be actively assigned twice.
- Cancelled/void invoices are never eligible for a new assignment.
- A failed drag or stale update visibly rolls back and explains the conflict.
- Print Items totals equal the persisted item snapshots, split by company and
  combined by exact item code plus UOM.
- Period reports can be combined or filtered by company without losing trip,
  driver, lorry, status, and audit timestamps.
- Quick Invoice links to Dispatch but its invoice workflow remains unchanged.
