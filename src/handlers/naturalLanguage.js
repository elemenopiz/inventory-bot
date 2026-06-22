import { logError, userName } from '../config.js';
import { AIServiceError, chatReply } from '../ai/chat.js';
import * as q from '../db/queries.js';
import { brandEmoji, checkThresholds, fmtNum, fmtYen } from '../alerts/alertEngine.js';
import { handlePendingReply, NO_RE, YES_RE } from './photo.js';
import { handleSetupText } from './setup.js';
import { sendWeeklyReport } from '../scheduler.js';
import { buildShoppingList, computeBurnRates, formatRunOutForecast } from '../analytics/forecast.js';

const REPORT_TRIGGER_RE = /report|レポート|تقرير|weekly/i;
const pendingUndo = new Map();
const UNDO_TTL_MS = 2 * 60 * 1000;

// Set once at startup from bot.getMe() — used to detect @mentions in groups.
let botUsername = null;
export function setBotUsername(username) {
  botUsername = username;
}

function isGroupChat(msg) {
  return msg.chat.type === 'group' || msg.chat.type === 'supergroup';
}

function isAddressedToBot(msg) {
  if (botUsername && (msg.text || '').toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;
  const repliedTo = msg.reply_to_message && msg.reply_to_message.from;
  return Boolean(repliedTo && repliedTo.is_bot && botUsername && repliedTo.username === botUsername);
}

// Telegram caps messages at 4096 chars — split long replies (e.g. a big
// stock table) on line boundaries.
async function sendChunked(bot, chatId, text) {
  const MAX = 4000;
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut <= 0) cut = MAX;
    await bot.sendMessage(chatId, rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) await bot.sendMessage(chatId, rest);
}

const HELLO =
  `👋 Hi! I'm the inventory bot for Shawarma House & Yaya Pizza.\n\n` +
  `📸 Send me a photo of a receipt and I'll log it.\n` +
  `💬 Or just ask me anything — English, 日本語, العربية all work.\n` +
  `Try: "how much chicken do we have?" / "在庫見せて" / "كم عندنا طحين؟"`;

export async function handleText(bot, msg) {
  const chatId = msg.chat.id;
  try {
    let text = (msg.text || '').trim();
    if (!text) return;

    // 1. A pending duplicate-receipt YES/NO takes priority over everything,
    //    and works in the group without needing an @mention.
    if (await handlePendingReply(bot, msg)) return;

    // 2. Same for a pending receipt-undo confirmation.
    if (await handlePendingUndo(bot, msg)) return;

    // 3. In the kitchen group the bot sees every message (privacy mode must
    //    be off so it can receive photos) — but it should only ANSWER when
    //    actually addressed. Otherwise it would reply to all kitchen chatter
    //    and casual remarks could trigger real stock adjustments.
    if (isGroupChat(msg)) {
      if (!isAddressedToBot(msg)) return;
      if (botUsername) {
        text = text.replace(new RegExp(`@${botUsername}`, 'gi'), '').trim();
        if (!text) return;
      }
    }

    if (text === '/start' || text.startsWith('/start ')) {
      await bot.sendMessage(chatId, HELLO);
      return;
    }

    // 4. Setup flow ("setup: olive oil 5L, chicken 8kg, ...").
    if (/^setup\s*[:：]/i.test(text)) {
      await handleSetupText(bot, msg);
      return;
    }

    // 5. Weekly report on demand.
    if (REPORT_TRIGGER_RE.test(text)) {
      await bot.sendMessage(chatId, '📊 Putting the weekly report together…');
      await sendWeeklyReport(bot, chatId);
      return;
    }

    // 6. Everything else goes to Kimi with fresh inventory data.
    const items = await q.getAllItems();
    const inventoryJson = JSON.stringify(
      items.map((i) => ({
        name: i.canonical_name,
        brand: i.brand,
        unit: i.unit,
        current_stock: Number(i.current_stock),
        reorder_threshold: Number(i.reorder_threshold),
        supplier_note: i.supplier_note || undefined,
      }))
    );

    const { reply, action } = await chatReply({
      userMessage: text,
      inventoryJson,
      name: userName(msg),
    });

    let finalText = reply;
    if (action && action.action) {
      const result = await executeAction(bot, msg, action);
      if (result) finalText = finalText ? `${finalText}\n\n${result}` : result;
    }
    if (finalText) await sendChunked(bot, chatId, finalText);
  } catch (err) {
    if (err instanceof AIServiceError) {
      await safeReply(bot, chatId, '⚠️ AI service temporarily unavailable. Try again in a moment.');
      return;
    }
    logError('Natural language handler:', err.message);
    await safeReply(bot, chatId, '❌ Something went wrong — logged. Try again.');
  }
}

async function safeReply(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
  } catch (err) {
    logError(`Failed to reply to ${chatId}:`, err.message);
  }
}

export async function handlePendingUndo(bot, msg) {
  const entry = pendingUndo.get(msg.from.id);
  if (!entry) return false;
  if (Date.now() > entry.expires) {
    pendingUndo.delete(msg.from.id);
    return false;
  }

  const text = (msg.text || '').trim();
  if (YES_RE.test(text)) {
    pendingUndo.delete(msg.from.id);
    try {
      const lineItems = await q.undoReceipt(entry.receipt.id);
      const lines = lineItems.map((ri) => `- ${ri.canonical_name || ri.original_name}: -${fmtNum(ri.quantity)} ${ri.unit}`);
      await safeReply(
        bot,
        entry.chatId,
        `✅ Receipt undone.\n${lines.slice(0, 12).join('\n')}${lines.length > 12 ? `\n…and ${lines.length - 12} more` : ''}`
      );
    } catch (err) {
      logError('Receipt undo:', err.message);
      await safeReply(bot, entry.chatId, '❌ Could not undo that receipt — logged.');
    }
    return true;
  }
  if (NO_RE.test(text)) {
    pendingUndo.delete(msg.from.id);
    await safeReply(bot, entry.chatId, '👍 Cancelled — receipt left as-is.');
    return true;
  }
  return false;
}

// Defensive layer behind the prompt instruction: if Kimi still returns a
// quantity in g/ml against an item tracked in kg/L, convert instead of
// applying a 1000x-wrong adjustment. Unknown unit pairs pass through as-is.
function convertToItemUnit(value, fromUnit, toUnit) {
  const from = String(fromUnit || '').toLowerCase();
  const to = String(toUnit || '').toLowerCase();
  if (!from || !to || from === to) return value;
  if (from === 'g' && to === 'kg') return value / 1000;
  if (from === 'kg' && to === 'g') return value * 1000;
  if (from === 'ml' && to === 'l') return value / 1000;
  if (from === 'l' && to === 'ml') return value * 1000;
  return value;
}

async function executeAction(bot, msg, action) {
  switch (action.action) {
    case 'adjust_stock': {
      const item = await q.findItemByName(action.item);
      if (!item) {
        return `⚠️ I couldn't find "${action.item}" in the inventory, so nothing was changed. Add it with a setup message or it'll appear on the next receipt.`;
      }
      const rawDelta = Number(action.delta);
      if (!Number.isFinite(rawDelta) || rawDelta === 0) return null;
      const delta = convertToItemUnit(rawDelta, action.unit, item.unit);
      await q.insertStockAdjustment({
        itemId: item.id,
        byName: userName(msg),
        delta,
        unit: item.unit,
        reason: action.reason || null,
      });
      const updated = await q.adjustStock(item.id, delta);
      await checkThresholds(bot, [updated]);
      return `✅ ${item.canonical_name}: ${delta > 0 ? '+' : ''}${fmtNum(delta)} ${item.unit} → now ${fmtNum(updated.current_stock)} ${updated.unit}`;
    }

    case 'show_stock': {
      const items = await q.getAllItems();
      return formatStockTable(items);
    }

    case 'shopping_list': {
      return buildShoppingList();
    }

    case 'run_out_forecast': {
      const rows = await computeBurnRates();
      return formatRunOutForecast(rows, action.item || null);
    }

    case 'price_history': {
      const rows = await q.getPriceHistoryFor(action.item, 10);
      if (rows.length === 0) return `No price history recorded for "${action.item}" yet.`;
      const lines = rows.map(
        (r) => `${r.receipt_date} · ${fmtYen(r.unit_price)}/${r.unit}${r.supplier ? ` · ${r.supplier}` : ''}`
      );
      return `💴 Price history — ${rows[0].canonical_name}\n${lines.join('\n')}`;
    }

    case 'set_threshold': {
      const item = await q.findItemByName(action.item);
      if (!item) return `⚠️ I couldn't find "${action.item}" in the inventory.`;
      const rawValue = Number(action.value);
      if (!Number.isFinite(rawValue) || rawValue < 0) return `⚠️ "${action.value}" isn't a valid threshold.`;
      const value = convertToItemUnit(rawValue, action.unit, item.unit);
      const updated = await q.setThreshold(item.id, value);
      return `✅ ${updated.canonical_name} reorder threshold set to ${fmtNum(value)} ${updated.unit}.`;
    }

    case 'set_stock': {
      const item = await q.findItemByName(action.item);
      if (!item) return `⚠️ I couldn't find "${action.item}" in the inventory.`;
      const rawQuantity = Number(action.quantity);
      if (!Number.isFinite(rawQuantity) || rawQuantity < 0) return `⚠️ "${action.quantity}" isn't a valid stock count.`;
      const quantity = convertToItemUnit(rawQuantity, action.unit, item.unit);
      const current = Number(item.current_stock);
      const delta = quantity - current;
      await q.insertStockAdjustment({
        itemId: item.id,
        byName: userName(msg),
        delta,
        unit: item.unit,
        reason: action.reason || 'absolute stock correction',
      });
      const updated = await q.adjustStock(item.id, delta);
      await checkThresholds(bot, [updated]);
      return `✅ ${item.canonical_name}: corrected to ${fmtNum(updated.current_stock)} ${updated.unit} (${delta >= 0 ? '+' : ''}${fmtNum(delta)}).`;
    }

    case 'fix_receipt_item': {
      const item = await q.findItemByName(action.item);
      if (!item) return `⚠️ I couldn't find "${action.item}" in the inventory.`;
      const rawQuantity = Number(action.quantity);
      if (!Number.isFinite(rawQuantity) || rawQuantity < 0) return `⚠️ "${action.quantity}" isn't a valid receipt quantity.`;
      const quantity = convertToItemUnit(rawQuantity, action.unit, item.unit);
      const receiptItem = await q.findRecentReceiptItem(item.id, 7);
      if (!receiptItem) {
        return `⚠️ I couldn't find a recent receipt line for ${item.canonical_name}. Use a stock correction instead, like "actually we have 5 ${item.unit}".`;
      }
      const result = await q.correctReceiptItemQuantity({
        receiptItemId: receiptItem.id,
        quantity,
        unit: item.unit,
      });
      if (!result) return `⚠️ I couldn't update that receipt line.`;
      const updated = await q.findItemByName(item.canonical_name);
      await checkThresholds(bot, [updated]);
      const supplier = receiptItem.supplier ? ` from ${receiptItem.supplier}` : '';
      return `✅ Fixed ${item.canonical_name} on the ${receiptItem.receipt_date} receipt${supplier}: ${fmtNum(result.before.quantity)} ${result.before.unit} → ${fmtNum(result.after.quantity)} ${result.after.unit}. Stock is now ${fmtNum(updated.current_stock)} ${updated.unit}.`;
    }

    case 'supplier_note': {
      const item = await q.findItemByName(action.item);
      if (!item) return `⚠️ I couldn't find "${action.item}" in the inventory.`;
      await q.setSupplierNote(item.id, action.note || null);
      return `✅ Supplier note saved for ${item.canonical_name}.`;
    }

    case 'undo_receipt': {
      const receipt = await q.getLatestReceipt({ maxAgeHours: 24 });
      if (!receipt) {
        return '⚠️ I could not find a receipt from the last 24 hours to undo.';
      }
      const lineItems = await q.getReceiptItems(receipt.id);
      const preview = lineItems
        .slice(0, 8)
        .map((ri) => `- ${ri.canonical_name || ri.original_name}: ${fmtNum(ri.quantity)} ${ri.unit}`)
        .join('\n');
      pendingUndo.set(msg.from.id, {
        receipt,
        chatId: msg.chat.id,
        expires: Date.now() + UNDO_TTL_MS,
      });
      return (
        `⚠️ Undo this receipt?\n` +
        `${receipt.receipt_date} · ${receipt.supplier || 'unknown supplier'} · ${receipt.logged_by_name || 'unknown'}\n` +
        `${preview}${lineItems.length > 8 ? `\n…and ${lineItems.length - 8} more` : ''}\n\n` +
        `Reply YES to undo it or NO to cancel.`
      );
    }

    case 'show_receipt': {
      const date = action.date && action.date !== 'null' && /^\d{4}-\d{2}-\d{2}$/.test(action.date) ? action.date : null;
      const supplier = action.supplier && action.supplier !== 'null' ? action.supplier : null;
      const receipts = await q.findReceiptsForRecall({ date, supplier, limit: 3 });
      const withPhotos = receipts.filter((r) => r.telegram_file_id);
      if (withPhotos.length === 0) {
        return `⚠️ I couldn't find a saved receipt photo${supplier ? ` from ${supplier}` : ''}${date ? ` on ${date}` : ''}.`;
      }
      for (const receipt of withPhotos) {
        await bot.sendPhoto(msg.chat.id, receipt.telegram_file_id, {
          caption: `🧾 ${receipt.receipt_date} · ${receipt.supplier || 'unknown supplier'} · ${receipt.total_amount != null ? fmtYen(receipt.total_amount) : 'total unknown'}`,
        });
      }
      return withPhotos.length === 1 ? null : `Sent ${withPhotos.length} matching receipt photos.`;
    }

    default:
      return null;
  }
}

const SECTION_HEADERS = {
  shawarma: '📦 Current inventory — Shawarma House',
  pizza: '📦 Current inventory — Yaya Pizza',
  shared: '🔄 Shared',
};

function statusEmoji(item) {
  const stock = Number(item.current_stock);
  const threshold = Number(item.reorder_threshold);
  if (!(threshold > 0)) return '';
  if (stock <= threshold) return '🔴 LOW';
  if (stock <= threshold * 1.25) return '🟡';
  return '🟢';
}

function formatStockTable(items) {
  if (items.length === 0) {
    return '📦 No items in inventory yet. Run setup, or just start sending receipt photos.';
  }
  const nameWidth = Math.min(20, Math.max(...items.map((i) => i.canonical_name.length)) + 2);
  const sections = [];
  for (const brand of ['shawarma', 'pizza', 'shared']) {
    const group = items.filter((i) => i.brand === brand);
    if (group.length === 0) continue;
    const rows = group.map((i) => {
      const qty = `${fmtNum(i.current_stock)} ${i.unit}`;
      return `${i.canonical_name.padEnd(nameWidth)} ${qty.padEnd(9)} ${statusEmoji(i)}`.trimEnd();
    });
    sections.push(`${SECTION_HEADERS[brand]}\n───────────────────\n${rows.join('\n')}`);
  }
  return sections.join('\n\n');
}
