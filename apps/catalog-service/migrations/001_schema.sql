-- Catalog schema. Applied idempotently at boot (scripts/migrate.js) and by the
-- `catalog-migrate` Job that Argo CD syncs as a PreSync hook.
CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL REFERENCES categories (slug),
  price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
  currency     CHAR(3) NOT NULL DEFAULT 'USD',
  stock        INTEGER NOT NULL CHECK (stock >= 0),
  rating       NUMERIC(2, 1) NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  tags         TEXT[] NOT NULL DEFAULT '{}',
  featured     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS products_category_idx ON products (category);
CREATE INDEX IF NOT EXISTS products_search_idx ON products USING gin (to_tsvector('english', name || ' ' || description));

CREATE TABLE IF NOT EXISTS stock_reservations (
  id         TEXT PRIMARY KEY,
  order_id   TEXT UNIQUE NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS stock_reservations_expiry_idx
  ON stock_reservations (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS stock_reservation_items (
  reservation_id TEXT NOT NULL REFERENCES stock_reservations (id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products (id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (reservation_id, product_id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
