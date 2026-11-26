-- Shop DB (sim-demo-shop fixture, Phase 25 UI0): the seven tables of the demo's Storage view.

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  referred_by uuid REFERENCES customers (id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX customers_email ON customers (email);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  sku text NOT NULL,
  price numeric NOT NULL,
  CONSTRAINT price_pos CHECK (price >= 0)
);
CREATE UNIQUE INDEX products_sku ON products (sku);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  status text NOT NULL
);
CREATE INDEX orders_status ON orders (status) WHERE status <> 'done';

CREATE TABLE order_items (
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  qty int NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT qty_pos CHECK (qty > 0)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE RESTRICT
);

CREATE TABLE addresses (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE
);

CREATE TABLE categories (
  id uuid PRIMARY KEY,
  parent_id uuid REFERENCES categories (id) ON DELETE SET NULL
);
