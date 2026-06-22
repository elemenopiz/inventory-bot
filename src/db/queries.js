import { pool } from './client.js';

const VALID_BRANDS = ['shawarma', 'pizza', 'shared'];

export function normalizeBrand(brand) {
  const b = String(brand || '').toLowerCase().trim();
  return VALID_BRANDS.includes(b) ? b : 'shared';
}

// ---------------------------------------------------------------- items

export async function getAllItems() {
  const { rows } = await pool.query(
    `SELECT * FROM items ORDER BY brand, LOWER(canonical_name)`
  );
  return rows;
}

export async function countItems() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM items');
  return rows[0].n;
}

// Case-insensitive match on canonical_name or any alias.
export async function findItemByName(name) {
  const { rows } = await pool.query(
    `SELECT * FROM items
     WHERE LOWER(canonical_name) = LOWER($1)
        OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($1))
     LIMIT 1`,
    [String(name || '').trim()]
  );
  return rows[0] || null;
}

export async function createItem({ name, brand = 'shared', unit = 'kg', stock = 0, threshold = 0, aliases = [] }) {
  const { rows } = await pool.query(
    `INSERT INTO items (canonical_name, brand, unit, current_stock, reorder_threshold, aliases)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (canonical_name) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [name.trim(), normalizeBrand(brand), unit, stock, threshold, aliases]
  );
  return rows[0];
}

export async function addAlias(itemId, alias) {
  if (!alias || !alias.trim()) return;
  await pool.query(
    `UPDATE items SET aliases = array_append(aliases, $2)
     WHERE id = $1
       AND LOWER(canonical_name) <> LOWER($2)
       AND NOT EXISTS (SELECT 1 FROM unnest(aliases) a WHERE LOWER(a) = LOWER($2))`,
    [itemId, alias.trim()]
  );
}

export async function adjustStock(itemId, delta) {
  const { rows } = await pool.query(
    `UPDATE items SET current_stock = current_stock + $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [itemId, delta]
  );
  return rows[0];
}

export async function setThreshold(itemId, value) {
  const { rows } = await pool.query(
    `UPDATE items SET reorder_threshold = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [itemId, value]
  );
  return rows[0];
}

export async function setSupplierNote(itemId, note) {
  const { rows } = await pool.query(
    `UPDATE items SET supplier_note = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [itemId, note]
  );
  return rows[0];
}

// Used by setup seeding. Upserts by canonical_name so re-running setup updates
// stock/threshold instead of failing.
export async function bulkUpsertItems(items) {
  let count = 0;
  for (const it of items) {
    if (!it.name || !String(it.name).trim()) continue;
    await pool.query(
      `INSERT INTO items (canonical_name, brand, unit, current_stock, reorder_threshold)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (canonical_name) DO UPDATE
         SET brand = EXCLUDED.brand,
             unit = EXCLUDED.unit,
             current_stock = EXCLUDED.current_stock,
             reorder_threshold = EXCLUDED.reorder_threshold,
             updated_at = NOW()`,
      [
        String(it.name).trim(),
        normalizeBrand(it.brand),
        it.unit || 'kg',
        Number(it.stock) || 0,
        Number(it.threshold) || 0,
      ]
    );
    count += 1;
  }
  return count;
}

export async function getItemsBelowThreshold() {
  const { rows } = await pool.query(
    `SELECT * FROM items
     WHERE reorder_threshold > 0 AND current_stock <= reorder_threshold
     ORDER BY brand, LOWER(canonical_name)`
  );
  return rows;
}

// ------------------------------------------------------------- receipts

export async function insertReceipt({ date, supplier, byId, byName, total, fileId }) {
  const { rows } = await pool.query(
    `INSERT INTO receipts (receipt_date, supplier, logged_by_id, logged_by_name, total_amount, telegram_file_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [date, supplier || null, byId, byName, total ?? null, fileId || null]
  );
  return rows[0];
}

// Same supplier + same total + receipt_date within a day of the new one.
export async function findDuplicateReceipt({ supplier, total, date }) {
  const { rows } = await pool.query(
    `SELECT * FROM receipts
     WHERE supplier IS NOT DISTINCT FROM $1
       AND total_amount = $2
       AND receipt_date BETWEEN $3::date - 1 AND $3::date + 1
     ORDER BY created_at DESC LIMIT 1`,
    [supplier || null, total, date]
  );
  return rows[0] || null;
}

export async function insertReceiptItem({ receiptId, itemId, originalName, canonicalName, brand, quantity, unit, unitPrice, totalPrice, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO receipt_items
       (receipt_id, item_id, original_name, canonical_name, brand, quantity, unit, unit_price, total_price, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [receiptId, itemId, originalName, canonicalName, normalizeBrand(brand), quantity, unit, unitPrice ?? null, totalPrice ?? null, notes || null]
  );
  return rows[0];
}

export async function insertStockAdjustment({ itemId, byName, delta, unit, reason }) {
  const { rows } = await pool.query(
    `INSERT INTO stock_adjustments (item_id, adjusted_by_name, delta, unit, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [itemId, byName, delta, unit, reason || null]
  );
  return rows[0];
}

// -------------------------------------------------------- price history

export async function insertPriceHistory({ name, supplier, price, unit, date, receiptId }) {
  const { rows } = await pool.query(
    `INSERT INTO price_history (canonical_name, supplier, unit_price, unit, receipt_date, receipt_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [name, supplier || null, price, unit, date, receiptId || null]
  );
  return rows[0];
}

export async function getLastPrice(name) {
  const { rows } = await pool.query(
    `SELECT * FROM price_history
     WHERE LOWER(canonical_name) = LOWER($1)
     ORDER BY receipt_date DESC, created_at DESC LIMIT 1`,
    [name]
  );
  return rows[0] || null;
}

export async function getLastPricesBySupplier(name) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (COALESCE(supplier, ''))
            canonical_name, supplier, unit_price, unit, receipt_date, created_at
     FROM price_history
     WHERE LOWER(canonical_name) = LOWER($1)
     ORDER BY COALESCE(supplier, ''), receipt_date DESC, created_at DESC`,
    [name]
  );
  return rows;
}

export async function getPriceHistoryFor(name, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM price_history
     WHERE LOWER(canonical_name) = LOWER($1)
     ORDER BY receipt_date DESC, created_at DESC LIMIT $2`,
    [name, limit]
  );
  return rows;
}

// --------------------------------------- undo, corrections, recall

// Latest receipt — optionally restricted to one user and/or a max age.
export async function getLatestReceipt({ byId = null, maxAgeHours = null } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM receipts
     WHERE ($1::text IS NULL OR logged_by_id = $1)
       AND ($2::int IS NULL OR created_at > NOW() - ($2 || ' hours')::interval)
     ORDER BY created_at DESC LIMIT 1`,
    [byId, maxAgeHours]
  );
  return rows[0] || null;
}

export async function getReceiptItems(receiptId) {
  const { rows } = await pool.query(
    'SELECT * FROM receipt_items WHERE receipt_id = $1 ORDER BY id',
    [receiptId]
  );
  return rows;
}

// Reverses a receipt atomically: subtracts the stock it added, then deletes
// the receipt row (receipt_items and price_history rows cascade away).
// Returns the line items that were reversed.
export async function undoReceipt(receiptId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lineItems } = await client.query(
      'SELECT * FROM receipt_items WHERE receipt_id = $1',
      [receiptId]
    );
    for (const ri of lineItems) {
      if (ri.item_id == null) continue;
      await client.query(
        'UPDATE items SET current_stock = current_stock - $2, updated_at = NOW() WHERE id = $1',
        [ri.item_id, ri.quantity]
      );
    }
    await client.query('DELETE FROM receipts WHERE id = $1', [receiptId]);
    await client.query('COMMIT');
    return lineItems;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getItemsByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await pool.query('SELECT * FROM items WHERE id = ANY($1)', [ids]);
  return rows;
}

// Most recent receipt line for an item, for "the receipt was wrong" fixes.
export async function findRecentReceiptItem(itemId, days = 7) {
  const { rows } = await pool.query(
    `SELECT ri.*, r.receipt_date, r.supplier
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     WHERE ri.item_id = $1 AND r.receipt_date >= CURRENT_DATE - $2::int
     ORDER BY r.receipt_date DESC, ri.id DESC LIMIT 1`,
    [itemId, days]
  );
  return rows[0] || null;
}

export async function updateReceiptItemQuantity(id, quantity, unitPrice = null) {
  const { rows } = await pool.query(
    `UPDATE receipt_items
     SET quantity = $2, unit_price = COALESCE($3, unit_price)
     WHERE id = $1 RETURNING *`,
    [id, quantity, unitPrice]
  );
  return rows[0];
}

export async function correctReceiptItemQuantity({ receiptItemId, quantity, unit }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      `SELECT ri.*, i.unit AS item_unit
       FROM receipt_items ri
       JOIN items i ON i.id = ri.item_id
       WHERE ri.id = $1
       FOR UPDATE`,
      [receiptItemId]
    );
    const existing = existingRows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return null;
    }

    const oldQuantity = Number(existing.quantity);
    const newQuantity = Number(quantity);
    const delta = newQuantity - oldQuantity;
    const nextUnit = unit || existing.unit || existing.item_unit;
    const nextTotal = existing.unit_price == null ? existing.total_price : Number(existing.unit_price) * newQuantity;

    const { rows: updatedRows } = await client.query(
      `UPDATE receipt_items
       SET quantity = $2, unit = $3, total_price = $4
       WHERE id = $1
       RETURNING *`,
      [receiptItemId, newQuantity, nextUnit, nextTotal]
    );
    await client.query(
      `UPDATE items SET current_stock = current_stock + $2, updated_at = NOW()
       WHERE id = $1`,
      [existing.item_id, delta]
    );
    await client.query('COMMIT');
    return { before: existing, after: updatedRows[0], delta };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updatePriceHistoryForReceipt(receiptId, canonicalName, unitPrice) {
  await pool.query(
    `UPDATE price_history SET unit_price = $3
     WHERE receipt_id = $1 AND LOWER(canonical_name) = LOWER($2)`,
    [receiptId, canonicalName, unitPrice]
  );
}

// Receipt photo recall: by exact date and/or fuzzy supplier match.
export async function findReceiptsForRecall({ date = null, supplier = null, limit = 3 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM receipts
     WHERE ($1::date IS NULL OR receipt_date = $1)
       AND ($2::text IS NULL OR supplier ILIKE '%' || $2 || '%')
     ORDER BY receipt_date DESC, created_at DESC
     LIMIT $3`,
    [date, supplier, limit]
  );
  return rows;
}

// ------------------------------------------------------------ forecasting

// Per-item purchase totals over a trailing window, used to estimate burn
// rate (steady-state assumption: what the kitchen buys, it uses).
export async function getBurnRateData(windowDays = 28) {
  const { rows } = await pool.query(
    `SELECT i.id, i.canonical_name, i.brand, i.unit, i.current_stock, i.reorder_threshold,
            i.supplier_note,
            SUM(ri.quantity)           AS purchased,
            COUNT(DISTINCT r.id)::int  AS purchase_count,
            MIN(r.receipt_date)        AS first_purchase,
            MAX(r.receipt_date)        AS last_purchase
     FROM receipt_items ri
     JOIN receipts r ON r.id = ri.receipt_id
     JOIN items i    ON i.id = ri.item_id
     WHERE r.receipt_date >= CURRENT_DATE - $1::int
     GROUP BY i.id
     ORDER BY i.brand, LOWER(i.canonical_name)`,
    [windowDays]
  );
  return rows;
}

// --------------------------------------------------------------- alerts

export async function hasRecentAlert(itemId, alertType, hours = 12) {
  const { rows } = await pool.query(
    `SELECT 1 FROM alert_log
     WHERE item_id = $1 AND alert_type = $2
       AND created_at > NOW() - ($3 || ' hours')::interval
     LIMIT 1`,
    [itemId, alertType, hours]
  );
  return rows.length > 0;
}

export async function logAlert(itemId, alertType, sentTo) {
  await pool.query(
    `INSERT INTO alert_log (item_id, alert_type, sent_to) VALUES ($1, $2, $3)`,
    [itemId, alertType, sentTo]
  );
}

// ------------------------------------------------------------ bot state

export async function getState(key) {
  const { rows } = await pool.query('SELECT value FROM bot_state WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}

export async function setState(key, value) {
  await pool.query(
    `INSERT INTO bot_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// ------------------------------------------------------------ reporting

export async function getWeeklyData() {
  const [spend, purchases, adjustments, prices, lowItems] = await Promise.all([
    pool.query(
      `SELECT COALESCE(ri.brand, 'shared') AS brand,
              ROUND(SUM(COALESCE(ri.total_price, ri.unit_price * ri.quantity, 0)))::numeric AS spend
       FROM receipt_items ri
       JOIN receipts r ON r.id = ri.receipt_id
       WHERE r.receipt_date >= CURRENT_DATE - 7
       GROUP BY 1`
    ),
    pool.query(
      `SELECT r.receipt_date, r.supplier, ri.canonical_name, ri.brand,
              ri.quantity, ri.unit, ri.unit_price, ri.total_price
       FROM receipt_items ri
       JOIN receipts r ON r.id = ri.receipt_id
       WHERE r.receipt_date >= CURRENT_DATE - 7
       ORDER BY r.receipt_date DESC`
    ),
    pool.query(
      `SELECT i.canonical_name, i.brand, sa.delta, sa.unit, sa.reason,
              sa.adjusted_by_name, sa.created_at::date AS adjusted_on
       FROM stock_adjustments sa
       JOIN items i ON i.id = sa.item_id
       WHERE sa.created_at >= NOW() - INTERVAL '7 days'
       ORDER BY sa.created_at DESC`
    ),
    // 14 days so the model can compare this week's prices against last week's.
    pool.query(
      `SELECT canonical_name, supplier, unit_price, unit, receipt_date
       FROM price_history
       WHERE receipt_date >= CURRENT_DATE - 14
       ORDER BY canonical_name, receipt_date DESC`
    ),
    pool.query(
      `SELECT canonical_name, brand, current_stock, reorder_threshold, unit, supplier_note
       FROM items
       WHERE reorder_threshold > 0 AND current_stock <= reorder_threshold
       ORDER BY brand, LOWER(canonical_name)`
    ),
  ]);

  const spendByBrand = { shawarma: 0, pizza: 0, shared: 0 };
  for (const row of spend.rows) {
    spendByBrand[row.brand] = Number(row.spend) || 0;
  }

  return {
    spend_by_brand_jpy: spendByBrand,
    total_spend_jpy: spendByBrand.shawarma + spendByBrand.pizza + spendByBrand.shared,
    purchases_last_7_days: purchases.rows,
    stock_adjustments_last_7_days: adjustments.rows,
    price_history_last_14_days: prices.rows,
    items_at_or_below_threshold: lowItems.rows,
  };
}
