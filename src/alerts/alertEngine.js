import { config, logError } from '../config.js';
import * as q from '../db/queries.js';

const BRAND_EMOJI = { shawarma: '🥙', pizza: '🍕', shared: '🔄' };

export function brandEmoji(brand) {
  return BRAND_EMOJI[brand] || '🔄';
}

// NUMERIC columns come back from pg as strings — normalize and trim zeros.
export function fmtNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return String(parseFloat(n.toFixed(2)));
}

export function fmtYen(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '¥—';
  return '¥' + Math.round(n).toLocaleString('en-US');
}

// Alerts must never crash the flow that triggered them.
async function safeSend(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
    return true;
  } catch (err) {
    logError(`Failed to send alert to ${chatId}:`, err.message);
    return false;
  }
}

// Low stock check for a list of item rows. Skips items with no threshold and
// items already alerted within the last 12 hours.
export async function checkThresholds(bot, items) {
  for (const item of items || []) {
    try {
      const stock = Number(item.current_stock);
      const threshold = Number(item.reorder_threshold);
      if (!(threshold > 0) || stock > threshold) continue;
      if (await q.hasRecentAlert(item.id, 'low_stock', 12)) continue;

      const kitchenText =
        `📦 Stock alert\n` +
        `🔴 ${item.canonical_name} is running low\n` +
        `Current: ${fmtNum(stock)} ${item.unit} | Reorder at: ${fmtNum(threshold)} ${item.unit}`;

      let detailText =
        `📊 Reorder details — ${item.canonical_name}\n` +
        `Brand: ${item.brand}\n` +
        `Stock: ${fmtNum(stock)} ${item.unit} (threshold: ${fmtNum(threshold)} ${item.unit})`;
      const lastPrice = await q.getLastPrice(item.canonical_name);
      if (lastPrice) {
        detailText += `\nLast price: ${fmtYen(lastPrice.unit_price)}/${lastPrice.unit} (${lastPrice.receipt_date} from ${lastPrice.supplier || 'unknown supplier'})`;
      }
      if (item.supplier_note) {
        detailText += `\n${item.supplier_note}`;
      }

      const sentKitchen = await safeSend(bot, config.kitchenGroupId, `${kitchenText}\n\n${detailText}`);
      if (sentKitchen) await q.logAlert(item.id, 'low_stock', 'kitchen');
    } catch (err) {
      logError(`Threshold check failed for item ${item && item.canonical_name}:`, err.message);
    }
  }
}

// Price spike alert: new unit price ≥ 20% above the previous
// price_history entry. `previous` must be fetched BEFORE inserting the new price.
export async function checkPriceSpike(bot, { itemId, name, previous, newPrice, unit, supplier }) {
  try {
    if (!previous || previous.unit_price == null) return;
    const before = Number(previous.unit_price);
    const now = Number(newPrice);
    if (!(before > 0) || !Number.isFinite(now)) return;
    const pct = ((now - before) / before) * 100;
    if (pct < 20) return;

    const text =
      `💴 Price spike — ${name}\n` +
      `Before: ${fmtYen(before)}/${previous.unit} (${previous.receipt_date})\n` +
      `Now: ${fmtYen(now)}/${unit} (+${Math.round(pct)}%)\n` +
      `Supplier: ${supplier || 'unknown'}`;

    const sent = await safeSend(bot, config.kitchenGroupId, text);
    if (sent) await q.logAlert(itemId, 'price_spike', 'kitchen');
  } catch (err) {
    logError(`Price spike check failed for ${name}:`, err.message);
  }
}
