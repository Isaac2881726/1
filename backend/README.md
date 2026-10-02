# Campus Eats — Backend

Node.js / Express + PostgreSQL backend for the Campus Eats frontend
(auth, checkout, tracking, staff dashboard).

## Setup

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL, JWT_SECRET, STAFF_PHONE_NUMBERS...
psql -U youruser -d campuseats -f schema.sql
npm run dev                # or: npm start
```

## Project layout

```
schema.sql              -- Postgres schema: buildings, customers, staff, menu_items, orders, order_items
src/
  config/db.js           -- connection pool + withTransaction() helper
  middleware/auth.js      -- JWT verification, requireCustomer / requireStaff guards
  routes/auth.js          -- register, login (customer + staff), staff self-registration (admin-only)
  routes/orders.js        -- create order (server-priced), fetch/list a customer's orders
  routes/staff.js         -- dashboard feed, accept (race-safe), deliver
  utils/sms.js            -- mock SMS sender + "notify all staff" helper
  utils/cron.js           -- every-minute sweep that cancels stale pending orders
  server.js               -- app wiring, rate limiting, error handling
```

## Design notes

**Money is never trusted from the client.** `POST /api/orders` takes only
`menuItemId` + `quantity` per line. Prices, the 10% service fee, and the
total are all computed from `menu_items.price_cents` inside the same DB
transaction that creates the order. A tampered `total` in the request body
is simply ignored.

**Passwords** are hashed with bcrypt (12 salt rounds) before storage —
`password_hash` columns only, never plaintext. Login compares against a
dummy hash when the email isn't found, to avoid leaking account existence
via response timing.

**Accept-order concurrency** uses an atomic conditional `UPDATE ... WHERE
status = 'pending'` (see `staff.js`). Postgres serializes concurrent
UPDATEs to the same row internally, so whichever request commits first
flips the status; the loser's `WHERE` clause no longer matches (status is
already `'accepted'`), so its `UPDATE` affects zero rows and the API
returns `409 Conflict`. This "compare-and-swap" approach needs no
explicit `SELECT ... FOR UPDATE` lock or external mutex, and it's safe
even with multiple server instances behind a load balancer, since the
guarantee lives in the database, not in application memory.

**Order timeout** (`utils/cron.js`) runs every minute via `node-cron` and
cancels any order still `pending` (never accepted) after
`ORDER_TIMEOUT_MINUTES` (default 5). It updates `status`, `cancelled_at`,
and `cancel_reason = 'timeout'` in one query.

**SMS** (`utils/sms.js`) is a mock — it logs to the console and returns a
fake "sent" result. Swap the body of `sendSms()` for a real provider
(Twilio, Clickatell, BulkSMS, etc.) later; nothing else in the app needs
to change. Notification is fire-and-forget after the order transaction
commits, so a flaky SMS provider can never block or roll back an order.

## API summary

| Method | Route                              | Auth            | Purpose |
|--------|-------------------------------------|------------------|---------|
| POST   | `/api/auth/register`                | none             | Customer signup |
| POST   | `/api/auth/login`                   | none             | Login (`as: 'customer' \| 'staff'`) |
| POST   | `/api/auth/staff/register`          | admin staff      | Create a staff account |
| POST   | `/api/orders`                       | customer         | Place an order (server-priced) |
| GET    | `/api/orders`                       | customer         | List own orders |
| GET    | `/api/orders/:id`                   | customer (owner) | Order detail / tracking |
| GET    | `/api/staff/orders`                 | staff            | Dashboard feed |
| POST   | `/api/staff/orders/:id/accept`      | staff            | Claim an order (race-safe) |
| POST   | `/api/staff/orders/:id/deliver`     | staff            | Mark accepted order delivered |

## What you'll still want to add

- Menu item CRUD routes (create/update/delete dishes) for the staff dashboard.
- Refresh tokens / logout (current JWTs are stateless and simply expire).
- WebSocket or polling endpoint so the customer tracking page updates live
  when an order is accepted/delivered/cancelled.
- A real SMS provider integration in `utils/sms.js`.
- Input validation library (e.g. `zod`) if the request bodies grow more complex.
