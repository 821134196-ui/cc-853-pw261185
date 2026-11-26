'use strict';

const SCHEMA_SQL = `
DROP TABLE IF EXISTS demo_order_items CASCADE;
DROP TABLE IF EXISTS demo_orders CASCADE;
DROP TABLE IF EXISTS demo_inventory CASCADE;
DROP TABLE IF EXISTS demo_accounts CASCADE;

CREATE TABLE demo_accounts (
  id integer PRIMARY KEY,
  account_no text NOT NULL UNIQUE,
  holder text NOT NULL,
  balance_cents integer NOT NULL CHECK (balance_cents >= 0),
  version integer NOT NULL DEFAULT 0
);

CREATE TABLE demo_inventory (
  sku text PRIMARY KEY,
  label text NOT NULL,
  on_hand integer NOT NULL CHECK (on_hand >= 0)
);

CREATE TABLE demo_orders (
  id integer PRIMARY KEY,
  account_id integer NOT NULL REFERENCES demo_accounts(id),
  sku text NOT NULL REFERENCES demo_inventory(sku),
  qty integer NOT NULL CHECK (qty > 0),
  status text NOT NULL DEFAULT 'pending',
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO demo_accounts (id, account_no, holder, balance_cents, version) VALUES
  (1, 'A-1001', 'Alice', 100000, 0),
  (2, 'A-1002', 'Bob',    85000, 0),
  (3, 'A-1003', 'Chen',   42000, 0);

INSERT INTO demo_inventory (sku, label, on_hand) VALUES
  ('SKU-LOCK-1', '锁演示物料 1', 12),
  ('SKU-LOCK-2', '锁演示物料 2',  7),
  ('SKU-FAST',   '短脉冲物料',    3);

INSERT INTO demo_orders (id, account_id, sku, qty, status) VALUES
  (101, 1, 'SKU-LOCK-1', 1, 'pending'),
  (102, 2, 'SKU-LOCK-2', 2, 'paid'),
  (103, 3, 'SKU-FAST',   1, 'picking');

CREATE INDEX idx_demo_orders_account ON demo_orders(account_id);
CREATE INDEX idx_demo_orders_sku ON demo_orders(sku);
`;

module.exports = { SCHEMA_SQL };
