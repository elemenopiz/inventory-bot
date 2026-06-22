CREATE TABLE IF NOT EXISTS items (
  id            SERIAL PRIMARY KEY,
  canonical_name TEXT UNIQUE NOT NULL,
  aliases        TEXT[]   DEFAULT '{}',
  brand          TEXT     CHECK (brand IN ('shawarma', 'pizza', 'shared')) NOT NULL DEFAULT 'shared',
  category       TEXT,
  unit           TEXT     NOT NULL DEFAULT 'kg',
  current_stock  NUMERIC  DEFAULT 0,
  reorder_threshold NUMERIC DEFAULT 0,
  supplier_note  TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipts (
  id              SERIAL PRIMARY KEY,
  receipt_date    DATE    NOT NULL,
  supplier        TEXT,
  logged_by_id    TEXT,
  logged_by_name  TEXT,
  total_amount    NUMERIC,
  telegram_file_id TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipt_items (
  id             SERIAL PRIMARY KEY,
  receipt_id     INT     REFERENCES receipts(id) ON DELETE CASCADE,
  item_id        INT     REFERENCES items(id),
  original_name  TEXT    NOT NULL,
  canonical_name TEXT,
  brand          TEXT    CHECK (brand IN ('shawarma', 'pizza', 'shared')),
  quantity       NUMERIC NOT NULL,
  unit           TEXT    NOT NULL,
  unit_price     NUMERIC,
  total_price    NUMERIC,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id             SERIAL PRIMARY KEY,
  item_id        INT     REFERENCES items(id),
  adjusted_by_name TEXT,
  delta          NUMERIC NOT NULL,
  unit           TEXT    NOT NULL,
  reason         TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_history (
  id             SERIAL PRIMARY KEY,
  canonical_name TEXT    NOT NULL,
  supplier       TEXT,
  unit_price     NUMERIC NOT NULL,
  unit           TEXT    NOT NULL,
  receipt_date   DATE    NOT NULL,
  receipt_id     INT     REFERENCES receipts(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Upgrade path for databases created before receipt_id existed (undo support).
ALTER TABLE price_history
  ADD COLUMN IF NOT EXISTS receipt_id INT REFERENCES receipts(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS alert_log (
  id             SERIAL PRIMARY KEY,
  item_id        INT     REFERENCES items(id),
  alert_type     TEXT,
  sent_to        TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value TEXT);

INSERT INTO bot_state (key, value) VALUES ('setup_complete', 'false')
ON CONFLICT (key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_price_history_name_date
  ON price_history (canonical_name, receipt_date DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_log_item_type
  ON alert_log (item_id, alert_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receipts_dup
  ON receipts (supplier, total_amount, receipt_date);

CREATE INDEX IF NOT EXISTS idx_receipts_recall
  ON receipts (receipt_date DESC, supplier);
