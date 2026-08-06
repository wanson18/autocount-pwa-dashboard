# Item → Customer Breakdown (Design Spec)

Date: 2026-08-06

## Problem

The "Product Breakdown" table on the dashboard shows aggregate units/revenue
per item (e.g. "5kg Minyak Masak"), but not who bought it. The user wants to
click an item and see which customers bought it and how much.

## Goal

Clicking an item row in the Product Breakdown table expands it in place to
show a list of customers and the quantity each one bought of that item, for
the currently selected date range.

## Non-goals

- No new screens, routes, or endpoints.
- No revenue-per-customer breakdown (quantity only, per user's request).
- No persistence of expand/collapse state across search or refresh.

## Backend changes — `api/sales.js`

`aggregateBySKU()` already loops every invoice's line items per SKU. Extend
the per-SKU accumulator to also tally quantity per customer name
(`invoice.customerName`) while iterating, e.g. `skuMap[sku].customerMap[name]
+= item.quantity`.

When converting the internal map to the output array, turn `customerMap`
into a `customers` array on each SKU object, sorted by quantity descending,
and drop the internal map from the output:

```json
{
  "sku": "OIL-PKO-20L",
  "description": "Palm Kernel Oil 20L Drum",
  "totalRevenue": 15000,
  "totalUnits": 120,
  "customers": [
    { "name": "ABC Trading Sdn Bhd", "quantity": 90 },
    { "name": "XYZ Industries Ltd", "quantity": 30 }
  ]
}
```

This is purely additive — existing fields (`totalRevenue`, `totalUnits`,
`avgPricePerUnit`, `orderCount`, `totalCost`) are unchanged, so `topSKUs`
and `skuBreakdown` both gain `customers` with no other contract change.

## Frontend changes — `public/index.html`

- Add a chevron icon to the Product column of each row in the Product
  Breakdown table.
- Clicking anywhere on the row toggles a detail `<tr>` directly beneath it
  (`colspan="3"`) listing `customers` as `name — quantity`, in the order
  the backend already sorted them (quantity descending). The chevron
  rotates to indicate expanded/collapsed state.
- If `customers` is empty or missing (defensive, e.g. stale cached
  response), show "No customer data" in the detail row instead of an
  empty list.
- `renderTable()` and `filterTable()` currently duplicate the same row
  markup. Both will call one shared row-builder function that produces the
  item row + its (initially collapsed) detail row, keyed by array index so
  toggling works after a search re-render.
- Add a small `escapeHtml()` helper used for text fields interpolated into
  `innerHTML` in that shared builder (item description, SKU, customer
  names) — this data originates from AutoCount/customer records, not the
  app itself.
- Expand/collapse state is not preserved across search input or data
  refresh; every re-render starts collapsed.

## Testing

Manual verification via `npx vercel dev` with `USE_MOCK_DATA=true`:
- Expand "Palm Kernel Oil 20L Drum" (bought by both "ABC Trading Sdn Bhd"
  and "XYZ Industries Ltd" in `mock-sales.json`) and confirm both customers
  and their correct quantities appear, sorted highest first.
- Confirm the chevron rotates open/closed and multiple rows can be
  expanded independently.
- Confirm the search box still filters rows correctly and expanded state
  resets on a new search.
