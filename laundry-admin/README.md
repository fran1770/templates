# Suds — Laundry Admin

A focused admin tool for a laundry shop counter: create an order, price it by
weight, track it through wash → dry → fold → ready → claimed, and never lose
track of when a customer is due to pick it up.

No build step. No framework. Plain HTML/CSS/JS, so it runs straight off
GitHub Pages.

## Features

- **Orders** — customer, contact, service type, weight (kg), price per kilo
  (editable per order, right there in the order form), optional extra charge,
  auto-calculated total, payment status, and an optional cash/change
  calculator for counter transactions.
- **Tracking** — every order moves through a status stepper
  (Pending → Washing → Drying → Folding → Ready for pickup → Claimed, or
  Cancelled), with a timestamped history you can expand on each order.
- **Deadlines, overdue vs. late** — every order has a pickup deadline.
  "Overdue" means an order is still being processed (not ready yet) and has
  passed its deadline — a shop-side problem. "Late for pickup" means it's
  washed and ready, the customer just hasn't collected it — flagged with its
  own indicator in the Orders table so the two don't get confused.
- **Sales** — a dashboard panel showing total sales, order count, unique
  customers and average order value, filterable by day, week, month or a
  custom date range.
- **Orders tab date filter** — defaults to today, with the same day/week/
  month/range filter as Sales, plus search and status filters on top.
- **Backup/restore** — since data lives in the browser (see below), Settings
  has one-click export to a `.json` file and import to restore it.
- Loading states on every async action (fetching orders, saving an order,
  exporting, importing), toasts for confirmation/errors, hover/press states
  on interactive elements, and a light/dark theme toggle.

## Running it

No install needed. Either:

- Open `index.html` directly in a browser, or
- Serve the folder locally so relative paths and IndexedDB behave exactly
  like they will in production:

  ```bash
  npx serve .
  # or
  python3 -m http.server 8080
  ```

## Deploying to GitHub Pages

1. Push this folder to a GitHub repository (the contents of
   `laundry-admin/`, including `index.html`, at the repo root — or in a
   `/docs` folder if you prefer).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to "Deploy from a branch",
   pick your branch (e.g. `main`) and the folder (`/` or `/docs`).
4. Save. GitHub gives you a URL like
   `https://<your-username>.github.io/<repo-name>/` — that's your admin app.

No environment variables, no server, no database to provision — that's the
whole point of the next section.

## About "the database" — important to understand

GitHub Pages only serves static files. There is no server behind it, so
there's no way to run a real database engine (Postgres, MySQL, etc.) that
this app could connect to directly from the browser.

Instead, this app uses **IndexedDB** — a real, transactional, indexed
database that ships built into every browser. It's not a workaround or a
toy: it has tables (called "object stores"), indexes, and transactions, just
like a server database. The difference is *where* it lives: on the device
the browser is running on, not on a shared server.

That has one real consequence worth knowing up front:

> **Data is local to one browser, on one device.** If you use this on the
> shop's counter tablet, all orders live on that tablet. Opening the app on
> your phone will show a separate, empty database. Clearing browser data
> wipes it.

This is fine for a single counter/single device setup, which is the common
case for a small shop's first version of this kind of tool. For that reason,
**Settings → Backup your data** lets you export everything to a `.json` file
and import it back in — treat that as your "off-device backup" until you
outgrow single-device use.

### Schema (`js/db.js`)

Everything is documented in the header comment of `js/db.js`, mirrored here:

**Database:** `LaundryAdminDB`

**Store `orders`** (primary key: `id`)

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | primary key |
| `orderNo` | string | e.g. `OR-0001`, unique, auto-incremented |
| `customerName` | string | indexed for search |
| `contactNumber` | string | |
| `serviceType` | string | e.g. "Wash & Fold" |
| `weightKg` | number | |
| `pricePerKilo` | number | set per order, in the order form |
| `additionalCharge` | number | optional flat add-on (e.g. stain removal) |
| `additionalChargeNote` | string | |
| `totalAmount` | number | `weightKg * pricePerKilo + additionalCharge` |
| `paymentStatus` | `"unpaid" \| "partial" \| "paid"` | |
| `amountPaid` | number | |
| `cashReceived` | number or `null` | optional, from the checkout change calculator |
| `status` | `"pending" \| "washing" \| "drying" \| "folding" \| "ready" \| "claimed" \| "cancelled"` | indexed |
| `statusHistory` | `{status, at}[]` | append-only log for tracking |
| `dateReceived` | ISO datetime | |
| `pickupDeadline` | ISO datetime | indexed |
| `dateClaimed` | ISO datetime or `null` | |
| `notes` | string | |
| `createdAt` / `updatedAt` | ISO datetime | |

**Store `settings`** (primary key: `key`, single row `"general"`)

`businessName`, `currencySymbol`, `defaultPricePerKilo`, `orderPrefix`,
`orderCounter`, `theme`.

### Growing past a single device

If/when this needs to be used from more than one device at once (multiple
staff, multiple counters), the clean upgrade path is to swap the inside of
`js/db.js` for calls to a real backend — Firebase/Firestore and Supabase both
work well from a static GitHub Pages frontend with no separate server to
host. Because `app.js` only ever calls `db.getAllOrders()`,
`db.addOrder()`, `db.updateOrder()`, `db.setOrderStatus()`, `db.deleteOrder()`
and the settings/export methods, that swap doesn't require touching the UI
code — the table above is effectively your target schema for whichever
service you pick (a Firestore collection `orders` with the same fields, for
example).

## Folder structure

```
laundry-admin/
├── index.html          # layout, views, modals, inline icon sprite
├── css/
│   └── style.css        # design tokens (incl. dark theme), layout, components
├── js/
│   ├── db.js             # IndexedDB data layer (the "database")
│   └── app.js             # rendering, navigation, order logic, loaders
└── README.md
```

## Customizing

- **Business name, currency symbol, default price per kilo, order number
  prefix** — all editable in the app under Settings, no code changes needed.
- **Colors/fonts** — CSS variables at the top of `css/style.css` under
  `:root` (light) and `[data-theme="dark"]`.
- **Status stages** — `STATUS_FLOW` near the top of `js/app.js`, plus the
  matching `.badge-*` classes in `style.css` if you add/rename a stage.
