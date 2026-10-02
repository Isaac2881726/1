-- ============================================================
-- Campus Eats — Database Schema (PostgreSQL)
-- ============================================================
-- Run with: psql -U youruser -d campuseats -f schema.sql

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------
-- BUILDINGS  (dorms / delivery destinations)
-- ------------------------------------------------------------
CREATE TABLE buildings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120) NOT NULL,          -- e.g. "Men's Res"
    campus_zone     VARCHAR(80),                    -- optional grouping
    est_minutes     INTEGER NOT NULL DEFAULT 10,     -- typical delivery time
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- CUSTOMERS
-- ------------------------------------------------------------
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    phone           VARCHAR(30)  NOT NULL,
    password_hash   TEXT NOT NULL,                   -- bcrypt hash, NEVER plaintext
    building_id     UUID REFERENCES buildings(id),
    room_number     VARCHAR(30),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customers_email ON customers(email);

-- ------------------------------------------------------------
-- STAFF  (runners / dispatch / admin)
-- ------------------------------------------------------------
CREATE TABLE staff (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    phone           VARCHAR(30)  NOT NULL,
    password_hash   TEXT NOT NULL,
    role            VARCHAR(20)  NOT NULL DEFAULT 'runner'
                        CHECK (role IN ('runner', 'dispatch', 'admin')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_email ON staff(email);

-- ------------------------------------------------------------
-- MENU ITEMS (kept minimal — extend as needed)
-- ------------------------------------------------------------
CREATE TABLE menu_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(150) NOT NULL,
    description     TEXT,
    price_cents     INTEGER NOT NULL CHECK (price_cents >= 0), -- store money as integer cents (ZAR)
    is_available    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- ORDERS
-- ------------------------------------------------------------
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(id),
    building_id         UUID NOT NULL REFERENCES buildings(id),
    room_number         VARCHAR(30),

    -- Money fields — ALWAYS computed server-side, never trust client totals.
    subtotal_cents      INTEGER NOT NULL CHECK (subtotal_cents >= 0),
    fee_cents           INTEGER NOT NULL CHECK (fee_cents >= 0),   -- 10% service fee
    total_cents         INTEGER NOT NULL CHECK (total_cents >= 0),

    payment_method      VARCHAR(20) NOT NULL DEFAULT 'cash'
                            CHECK (payment_method IN ('cash', 'bank_transfer')),

    -- Order lifecycle:
    -- pending -> accepted -> delivered
    --         -> cancelled (staff, customer, or timeout)
    status              VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'accepted', 'delivered', 'cancelled')),

    accepted_by_staff_id UUID REFERENCES staff(id),
    accepted_at          TIMESTAMPTZ,
    delivered_at          TIMESTAMPTZ,
    cancelled_at          TIMESTAMPTZ,
    cancel_reason          VARCHAR(60),   -- 'timeout', 'staff', 'customer'

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_orders_updated_at
BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------
-- ORDER ITEMS
-- ------------------------------------------------------------
CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    UUID NOT NULL REFERENCES menu_items(id),
    item_name       VARCHAR(150) NOT NULL,      -- snapshot at time of order
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0), -- snapshot, immune to later price changes
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
);

CREATE INDEX idx_order_items_order ON order_items(order_id);
