import { config, log, logError } from '../config.js';
import { AIServiceError, extractJson, generateText } from '../ai/chat.js';
import * as q from '../db/queries.js';

const ONBOARDING_MESSAGE = `👋 Inventory bot is ready!

Before we start, I need your current stock levels.
You have two options:

1. Send me a CSV file with columns: name, brand, unit, current_stock, reorder_threshold
   Example row: olive oil,shared,L,5,2

2. Type your stock count like this:
   "setup: olive oil 5L, chicken 8kg, pita bread 200pc, ..."

Reply with either and I'll load everything in.`;

// On startup: if nothing has been seeded yet, prompt the kitchen group.
export async function maybeStartOnboarding(bot) {
  try {
    const done = await q.getState('setup_complete');
    if (done === 'true') return;
    const count = await q.countItems();
    if (count > 0) {
      // Items exist (e.g. from receipts) — consider setup done.
      await q.setState('setup_complete', 'true');
      return;
    }
    await bot.sendMessage(config.kitchenGroupId, ONBOARDING_MESSAGE);
    log('Onboarding message sent to kitchen group');
  } catch (err) {
    logError(
      'Could not send onboarding message to the kitchen group:',
      err.message,
      '— make sure KITCHEN_GROUP_ID is correct and the bot is in the group, then restart the bot or type "setup: ...".'
    );
  }
}

async function finishSeeding(bot, chatId, count) {
  await q.setState('setup_complete', 'true');
  await bot.sendMessage(
    chatId,
    `✅ ${count} items loaded. You're ready to go! Staff can now send receipt photos to log inventory.`
  );
}

// "setup: olive oil 5L, chicken 8kg, ..." — parsed by Kimi.
export async function handleSetupText(bot, msg) {
  const chatId = msg.chat.id;
  try {
    const list = msg.text.replace(/^setup\s*[:：]/i, '').trim();
    if (!list) {
      await bot.sendMessage(chatId, 'Type your stock after "setup:", e.g.\n"setup: olive oil 5L, chicken 8kg, pita bread 200pc"');
      return;
    }

    const prompt =
      `Extract items from this stock count list as a JSON array: ` +
      `[{"name": "english item name", "unit": "kg | L | pc | bag | box", "quantity": number, ` +
      `"brand": "shawarma | pizza | shared (guess from the item: shawarma → pita/tahini/chickpeas/sumac/hummus, ` +
      `pizza → 00 flour/mozzarella/pepperoni/pizza boxes, everything ambiguous → shared)"}]. ` +
      `Normalize units: grams to kg, ml to L, pieces/個/枚/本 to pc. ` +
      `Return ONLY the JSON array — no markdown, no explanation.\n\nStock count list:\n${list}`;

    const raw = await generateText(prompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      await bot.sendMessage(chatId, "🤔 I couldn't read any items from that list. Try again, e.g.\n\"setup: olive oil 5L, chicken 8kg, pita bread 200pc\"");
      return;
    }

    const items = parsed
      .filter((p) => p && p.name)
      .map((p) => ({
        name: String(p.name).trim(),
        brand: p.brand,
        unit: p.unit || 'pc',
        stock: Number(p.quantity) || 0,
        threshold: 0,
      }));
    const count = await q.bulkUpsertItems(items);

    const summary = items
      .map((i) => `• ${i.name} — ${i.stock} ${i.unit}`)
      .join('\n');
    await bot.sendMessage(chatId, `Loaded:\n${summary}\n\n💡 Tip: set reorder alerts anytime, e.g. "set olive oil threshold to 2L".`);
    await finishSeeding(bot, chatId, count);
  } catch (err) {
    if (err instanceof AIServiceError) {
      await safeReply(bot, chatId, '⚠️ AI service temporarily unavailable. Try again in a moment.');
      return;
    }
    logError('Setup text handler:', err.message);
    await safeReply(bot, chatId, '❌ Something went wrong — logged. Try again.');
  }
}

// CSV document upload: name, brand, unit, current_stock, reorder_threshold
export async function handleCsvDocument(bot, msg) {
  const chatId = msg.chat.id;
  try {
    const fileLink = await bot.getFileLink(msg.document.file_id);
    const res = await fetch(fileLink);
    if (!res.ok) throw new Error(`Telegram file download failed: HTTP ${res.status}`);
    const text = await res.text();

    const items = parseCsv(text);
    if (items.length === 0) {
      await bot.sendMessage(
        chatId,
        '🤔 That CSV had no rows I could read. Expected columns:\nname, brand, unit, current_stock, reorder_threshold\nExample: olive oil,shared,L,5,2'
      );
      return;
    }

    const count = await q.bulkUpsertItems(items);
    const summary = items
      .slice(0, 30)
      .map((i) => `• ${i.name} (${q.normalizeBrand(i.brand)}) — ${i.stock} ${i.unit}, reorder at ${i.threshold}`)
      .join('\n');
    const more = items.length > 30 ? `\n…and ${items.length - 30} more` : '';
    await bot.sendMessage(chatId, `Loaded from CSV:\n${summary}${more}`);
    await finishSeeding(bot, chatId, count);
  } catch (err) {
    logError('CSV setup handler:', err.message);
    await safeReply(bot, chatId, '❌ Something went wrong — logged. Try again.');
  }
}

function parseCsv(text) {
  const items = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols[0].toLowerCase() === 'name') continue; // header row
    const [name, brand, unit, stock, threshold] = cols;
    if (!name) continue;
    items.push({
      name,
      brand,
      unit: unit || 'kg',
      stock: parseFloat(stock) || 0,
      threshold: parseFloat(threshold) || 0,
    });
  }
  return items;
}

async function safeReply(bot, chatId, text) {
  try {
    await bot.sendMessage(chatId, text);
  } catch (err) {
    logError(`Failed to reply to ${chatId}:`, err.message);
  }
}
