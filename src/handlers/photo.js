import { logError, todayISO, userName } from '../config.js';
import { parseReceipt } from '../ai/parseReceipt.js';
import { AIServiceError } from '../ai/chat.js';
import * as q from '../db/queries.js';
import { brandEmoji, checkPriceSpike, checkThresholds, fmtNum, fmtYen } from '../alerts/alertEngine.js';

// Pending duplicate confirmations, keyed by Telegram user ID. 2-minute TTL.
const pending = new Map();
const PENDING_TTL_MS = 2 * 60 * 1000;

export const YES_RE = /^(yes|y|نعم|اي|أيوه|はい|うん|ok|👍)$/i;
export const NO_RE = /^(no|n|لا|いいえ|やめて|cancel|キャンセル)$/i;

async function safeReply(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
  } catch (err) {
    logError(`Failed to reply to ${chatId}:`, err.message);
  }
}

// fileIdOverride lets bot.js route uncompressed image documents here too.
export async function handlePhoto(bot, msg, fileIdOverride = null) {
  const chatId = msg.chat.id;
  try {
    const fileId = fileIdOverride || msg.photo[msg.photo.length - 1].file_id;

    await safeReply(bot, chatId, '🧾 Reading the receipt…');

    const fileLink = await bot.getFileLink(fileId);
    const res = await fetch(fileLink);
    if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
    const base64 = Buffer.from(await res.arrayBuffer()).toString('base64');

    const parsed = await parseReceipt(base64);

    if (parsed.error === 'not_a_receipt') {
      await safeReply(bot, chatId, "That doesn't look like a receipt 📷 — send a photo of a receipt to log it.");
      return;
    }
    if (parsed.error === 'unreadable') {
      let text = "😵 I couldn't read that receipt. Please retake the photo — flat, well-lit, whole receipt in frame.";
      if (parsed.parse_notes) text += `\n\nWhat went wrong: ${parsed.parse_notes}`;
      await safeReply(bot, chatId, text);
      return;
    }
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
      await safeReply(bot, chatId, "🤔 I read the photo but couldn't find any line items. Try a closer, sharper photo of the receipt.");
      return;
    }

    // Kimi occasionally returns dates in other formats ("2026/06/10") or
    // hallucinated values — anything that isn't strict YYYY-MM-DD would fail
    // the DATE insert, so fall back to today.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.receipt_date || '')) {
      parsed.receipt_date = todayISO();
    }

    if (parsed.total != null) {
      const dup = await q.findDuplicateReceipt({
        supplier: parsed.supplier,
        total: parsed.total,
        date: parsed.receipt_date,
      });
      if (dup) {
        pending.set(msg.from.id, { parsed, fileId, chatId, from: msg.from, expires: Date.now() + PENDING_TTL_MS });
        await safeReply(
          bot,
          chatId,
          `⚠️ This looks like a duplicate — a receipt from ${parsed.supplier || 'this supplier'} ` +
            `for ${fmtYen(parsed.total)} was already logged on ${dup.receipt_date}.\n\n` +
            `Reply YES to log anyway or NO to cancel.`
        );
        return;
      }
    }

    await commitReceipt(bot, { parsed, fileId, chatId, from: msg.from });
  } catch (err) {
    if (err instanceof AIServiceError) {
      await safeReply(bot, chatId, '⚠️ AI service temporarily unavailable. Try again in a moment.');
      return;
    }
    logError('Photo handler:', err.message);
    await safeReply(bot, chatId, '❌ Something went wrong — logged. Try again.');
  }
}

// Called from the text handler BEFORE natural-language routing.
// Returns true if the message was consumed as a YES/NO duplicate reply.
export async function handlePendingReply(bot, msg) {
  const entry = pending.get(msg.from.id);
  if (!entry) return false;
  if (Date.now() > entry.expires) {
    pending.delete(msg.from.id);
    return false;
  }
  const text = (msg.text || '').trim();
  if (YES_RE.test(text)) {
    pending.delete(msg.from.id);
    try {
      await commitReceipt(bot, entry);
    } catch (err) {
      logError('Pending receipt commit:', err.message);
      await safeReply(bot, entry.chatId, '❌ Something went wrong — logged. Try again.');
    }
    return true;
  }
  if (NO_RE.test(text)) {
    pending.delete(msg.from.id);
    await safeReply(bot, entry.chatId, '👍 Cancelled — receipt not logged.');
    return true;
  }
  // Anything else falls through to the normal handler; the pending entry
  // stays until it expires.
  return false;
}

async function commitReceipt(bot, { parsed, fileId, chatId, from }) {
  const receipt = await q.insertReceipt({
    date: parsed.receipt_date,
    supplier: parsed.supplier,
    byId: from.id.toString(),
    byName: userName({ from }),
    total: parsed.total,
    fileId,
  });

  const affectedItems = [];
  const lines = [];

  for (const it of parsed.items) {
    const canonical = (it.canonical_name || it.original_name || '').trim();
    if (!canonical) continue;
    const quantity = Number(it.quantity) || 0;
    const unit = it.unit || 'pc';
    const brand = q.normalizeBrand(it.brand_guess);

    let item = await q.findItemByName(canonical);
    if (!item) {
      const aliases = it.original_name && it.original_name.toLowerCase() !== canonical.toLowerCase()
        ? [it.original_name]
        : [];
      item = await q.createItem({ name: canonical, brand, unit, aliases });
    } else if (it.original_name) {
      // Remember the receipt's exact wording so future matching improves.
      await q.addAlias(item.id, it.original_name);
    }

    await q.insertReceiptItem({
      receiptId: receipt.id,
      itemId: item.id,
      originalName: it.original_name || canonical,
      canonicalName: item.canonical_name,
      brand: item.brand,
      quantity,
      unit,
      unitPrice: it.unit_price,
      totalPrice: it.total_price,
      notes: null,
    });

    let unitPrice = it.unit_price;
    if (unitPrice == null && it.total_price != null && quantity > 0) {
      unitPrice = Number(it.total_price) / quantity;
    }
    if (unitPrice != null && Number.isFinite(Number(unitPrice))) {
      const previous = await q.getLastPrice(item.canonical_name);
      await q.insertPriceHistory({
        name: item.canonical_name,
        supplier: parsed.supplier,
        price: unitPrice,
        unit,
        date: parsed.receipt_date,
        receiptId: receipt.id,
      });
      await checkPriceSpike(bot, {
        itemId: item.id,
        name: item.canonical_name,
        previous,
        newPrice: unitPrice,
        unit,
        supplier: parsed.supplier,
      });
    }

    const updated = await q.adjustStock(item.id, quantity);
    affectedItems.push(updated);

    const price = it.total_price != null ? fmtYen(it.total_price)
      : it.unit_price != null ? fmtYen(it.unit_price)
      : '¥—';
    lines.push(`${brandEmoji(item.brand)} ${item.canonical_name} · ${fmtNum(quantity)} ${unit} · ${price}`);
  }

  let text =
    `✅ Receipt logged! (${parsed.receipt_date})\n` +
    `🏪 ${parsed.supplier || 'Unknown supplier'}\n` +
    `─────────────────\n` +
    `${lines.join('\n')}\n` +
    `─────────────────\n` +
    `Total: ${parsed.total != null ? fmtYen(parsed.total) : '¥—'} · ${lines.length} items`;
  if (parsed.confidence === 'low') {
    text += `\n⚠️ Low-confidence parse — double-check the numbers above.`;
    if (parsed.parse_notes) text += `\n⚠️ ${parsed.parse_notes}`;
  }
  await safeReply(bot, chatId, text);

  await checkThresholds(bot, affectedItems);
}
