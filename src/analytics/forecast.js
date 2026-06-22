import { config, todayISO } from '../config.js';
import * as q from '../db/queries.js';
import { brandEmoji, fmtNum, fmtYen } from '../alerts/alertEngine.js';

const WINDOW_DAYS = 28;
// Below this many days of forecast cover, an item joins the shopping list
// even if it's still above its static threshold.
const SHOPPING_HORIZON_DAYS = 4;
// Shopping suggestions aim for roughly two weeks of supply.
const TARGET_SUPPLY_DAYS = 14;

function daysBetween(isoFrom, isoTo) {
  return Math.round((Date.parse(isoTo) - Date.parse(isoFrom)) / 86400000);
}

function runOutDateLabel(daysLeft) {
  const d = new Date(Date.now() + daysLeft * 86400000);
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    timeZone: config.timezone,
  }).format(d);
}

// Pure derivation from one getBurnRateData row — exported for testing.
// Returns dailyBurn/daysLeft as null when there isn't enough history to
// estimate honestly (fewer than 2 purchases or under 7 days of data).
export function deriveBurnRow(raw, today = todayISO()) {
  const purchased = Number(raw.purchased);
  const purchaseCount = Number(raw.purchase_count);
  const stock = Number(raw.current_stock);
  const spanDays = Math.min(WINDOW_DAYS, daysBetween(raw.first_purchase, today) + 1);

  const row = {
    id: raw.id,
    canonical_name: raw.canonical_name,
    brand: raw.brand,
    unit: raw.unit,
    current_stock: stock,
    reorder_threshold: Number(raw.reorder_threshold),
    avgPurchase: purchaseCount > 0 ? purchased / purchaseCount : null,
    dailyBurn: null,
    daysLeft: null,
  };
  if (purchaseCount < 2 || purchased <= 0 || spanDays < 7) return row;

  row.dailyBurn = purchased / spanDays;
  row.daysLeft = stock > 0 ? stock / row.dailyBurn : 0;
  return row;
}

export async function computeBurnRates() {
  const raw = await q.getBurnRateData(WINDOW_DAYS);
  const today = todayISO();
  return raw
    .map((r) => deriveBurnRow(r, today))
    .sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity));
}

function urgencyEmoji(daysLeft) {
  if (daysLeft <= 2) return '🔴';
  if (daysLeft <= 5) return '🟡';
  return '🟢';
}

// "When will we run out?" — optionally filtered to one item.
export function formatRunOutForecast(burnRows, itemName = null) {
  let rows = burnRows.filter((r) => r.daysLeft != null);
  if (itemName) {
    const needle = itemName.toLowerCase();
    rows = rows.filter((r) => r.canonical_name.toLowerCase().includes(needle));
    if (rows.length === 0) {
      return `🔮 Not enough purchase history for "${itemName}" yet — I need at least two receipts over a week or more to estimate.`;
    }
  }
  if (rows.length === 0) {
    return '🔮 Not enough purchase history yet to forecast — after a couple of weeks of receipts I can estimate when things will run out.';
  }

  const MAX_ROWS = 15;
  const lines = rows.slice(0, MAX_ROWS).map((r) => {
    const when = r.daysLeft <= 0
      ? 'out now'
      : `~${Math.round(r.daysLeft)} day${Math.round(r.daysLeft) === 1 ? '' : 's'} (${runOutDateLabel(r.daysLeft)})`;
    return `${urgencyEmoji(r.daysLeft)} ${r.canonical_name} — ${when}`;
  });
  if (rows.length > MAX_ROWS) lines.push(`…and ${rows.length - MAX_ROWS} more`);

  return (
    `🔮 Run-out forecast\n` +
    `─────────────────\n` +
    `${lines.join('\n')}\n` +
    `─────────────────\n` +
    `Rough estimate from the last 4 weeks of purchases.`
  );
}

// Round a suggested buy quantity to something you can actually order.
function roundQty(value, unit) {
  if (['pc', 'bag', 'box'].includes(String(unit).toLowerCase())) return Math.ceil(value);
  return Math.ceil(value * 10) / 10;
}

function suggestQuantity(item, burn) {
  const stock = Number(item.current_stock);
  const threshold = Number(item.reorder_threshold);
  if (burn && burn.dailyBurn) {
    const target = burn.dailyBurn * TARGET_SUPPLY_DAYS - stock;
    if (target > 0) return roundQty(target, item.unit);
  }
  if (burn && burn.avgPurchase > 0) return roundQty(burn.avgPurchase, item.unit);
  if (threshold > 0) {
    const target = threshold * 2 - stock;
    if (target > 0) return roundQty(target, item.unit);
  }
  return null;
}

// Items at/below threshold, plus items forecast to run out within the
// shopping horizon. Formatted to be forwarded straight to a supplier chat.
export async function buildShoppingList() {
  const [items, burns] = await Promise.all([q.getAllItems(), computeBurnRates()]);
  const burnByName = new Map(burns.map((b) => [b.canonical_name.toLowerCase(), b]));

  const entries = [];
  for (const item of items) {
    const stock = Number(item.current_stock);
    const threshold = Number(item.reorder_threshold);
    const burn = burnByName.get(item.canonical_name.toLowerCase());
    if (threshold > 0 && stock <= threshold) {
      entries.push({ item, burn, why: `have ${fmtNum(stock)} ${item.unit}, reorder at ${fmtNum(threshold)} ${item.unit}` });
    } else if (burn && burn.daysLeft != null && burn.daysLeft <= SHOPPING_HORIZON_DAYS) {
      const when = burn.daysLeft <= 0 ? 'out now' : `runs out in ~${Math.round(burn.daysLeft)} days`;
      entries.push({ item, burn, why: `${when} at current pace` });
    }
  }

  if (entries.length === 0) {
    return '🛒 Nothing needed right now — everything is above its reorder level and nothing is forecast to run out in the next few days. ✅';
  }

  const lines = [];
  let estimatedTotal = 0;
  let pricedItems = 0;
  for (const { item, burn, why } of entries) {
    const qty = suggestQuantity(item, burn);
    const buyPart = qty ? `buy ~${fmtNum(qty)} ${item.unit}` : 'buy as needed';
    lines.push(`${brandEmoji(item.brand)} ${item.canonical_name} — ${buyPart} (${why})`);
    const lastPrices = await q.getLastPricesBySupplier(item.canonical_name);
    if (lastPrices.length > 0) {
      const priceText = lastPrices
        .slice(0, 4)
        .map((p) => `${fmtYen(p.unit_price)}/${p.unit} ${p.supplier || 'unknown supplier'} (${p.receipt_date})`)
        .join(' · ');
      lines.push(`    Last prices: ${priceText}`);
      const lastPrice = lastPrices
        .slice()
        .sort((a, b) => Date.parse(b.receipt_date) - Date.parse(a.receipt_date))[0];
      if (qty) {
        estimatedTotal += qty * Number(lastPrice.unit_price);
        pricedItems += 1;
      }
    }
    if (item.supplier_note) lines.push(`    📞 ${item.supplier_note}`);
  }

  let footer = `${entries.length} item${entries.length === 1 ? '' : 's'}`;
  if (estimatedTotal > 0) {
    footer += ` · est. ${fmtYen(estimatedTotal)}${pricedItems < entries.length ? ' (items with known prices)' : ''}`;
  }

  return (
    `🛒 Shopping list — ${todayISO()}\n` +
    `─────────────────\n` +
    `${lines.join('\n')}\n` +
    `─────────────────\n` +
    footer
  );
}
