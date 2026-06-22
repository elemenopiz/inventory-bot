import { config, logError, todayISO } from '../config.js';

// Thrown for any LLM API failure so handlers can show the "AI temporarily
// unavailable" message instead of the generic error.
export class AIServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AIServiceError';
  }
}

// The bot talks to Kimi (Moonshot) through its OpenAI-compatible chat API.
// Everything funnels through callKimi below, so swapping the provider later is
// a change to this one module only.
// Note: the k2.5 / k2.6 models reject any temperature other than 1, so we omit
// it. They are also reasoning models — hidden reasoning tokens count against
// max_tokens before the visible reply, so the cap must be generous or the answer
// gets truncated to empty. 4096 leaves ample room for reasoning + reply.
async function callKimi(model, messages, { maxTokens = 4096 } = {}) {
  let res;
  try {
    res = await fetch(`${config.kimiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.kimiApiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    });
  } catch (err) {
    logError('Kimi request failed:', err.message);
    throw new AIServiceError(err.message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logError(`Kimi API error ${res.status}:`, body.slice(0, 500));
    throw new AIServiceError(`Kimi API returned ${res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    logError('Kimi response not JSON:', err.message);
    throw new AIServiceError('Kimi returned a malformed response');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    logError('Kimi response missing content:', JSON.stringify(data).slice(0, 500));
    throw new AIServiceError('Kimi returned no content');
  }
  return content;
}

export async function generateText(prompt) {
  return callKimi(config.kimiModel, [{ role: 'user', content: prompt }]);
}

export async function generateVision(prompt, base64Image, mimeType = 'image/jpeg') {
  return callKimi(config.kimiModel, [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ],
    },
  ]);
}

// Pull the first JSON object or array out of a model reply, tolerating
// markdown fences and surrounding prose. Returns null if nothing parses.
export function extractJson(text) {
  if (!text) return null;
  let t = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const objStart = t.indexOf('{');
  const arrStart = t.indexOf('[');
  let start;
  let end;
  if (arrStart !== -1 && (objStart === -1 || arrStart < objStart)) {
    start = arrStart;
    end = t.lastIndexOf(']');
  } else {
    start = objStart;
    end = t.lastIndexOf('}');
  }
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

export const NL_SYSTEM_PROMPT = `You are the inventory assistant for Shawarma House and Yaya Pizza, two restaurants sharing a dining hall in Japan. You help the kitchen team track ingredients and stock.

You understand Arabic, Japanese, and English. Always reply in the same language the user wrote in.

Today's date: {TODAY}

You have access to the current inventory data provided below. Answer the user's question directly and helpfully.

Current inventory:
{INVENTORY_JSON}

Your role:
- Answer stock level questions ("how much chicken do we have", "كم عندنا طحين", "オリーブオイルは何リットルある")
- Confirm receipt logs ("you logged X, Y, Z today")
- Acknowledge stock adjustment requests ("I'll note that we used 2kg of onions")
- Tell users what items are low or need reordering
- Provide cost breakdowns and trend observations when asked
- Keep routine kitchen replies SHORT (2-4 lines max). Reports and document requests can be more detailed.
- Friendly, casual tone. This is a kitchen, not a boardroom.
- If the user wants to adjust stock (e.g. "we threw out 1kg of tomatoes"), extract: item name, delta (negative for waste/usage), unit, reason. Return a JSON action block at the end of your reply:
  {"action": "adjust_stock", "item": "tomatoes", "delta": -1, "unit": "kg", "reason": "spoilage"}
  Always convert the delta to the unit the item is tracked in (shown in the inventory above): grams → kg (÷1000), ml → L (÷1000). E.g. "threw out 500g of tomatoes" with tomatoes tracked in kg → delta -0.5, unit "kg".
- If the user is asking about a specific item price history, return:
  {"action": "price_history", "item": "chicken"}
- For all other queries, just reply naturally with no action block.

Additional actions (same format, at the very end of your reply, on its own line, at most one):
- If the user asks to see the full stock list or inventory overview, or what's low (e.g. "show stock", "what's low", "在庫見せて", "اعطيني المخزون"), return: {"action": "show_stock"} — the system will render the table for you, so keep your text reply to one short line or nothing.
- If the user wants to change a reorder threshold (e.g. "set chicken threshold to 5kg"), return: {"action": "set_threshold", "item": "chicken", "value": 5, "unit": "kg"}
- If the user wants to save a supplier note for an item (e.g. "add supplier note for flour: call Tanaka Foods 03-1234-5678"), return: {"action": "supplier_note", "item": "flour", "note": "call Tanaka Foods 03-1234-5678"}
- If the user asks what needs to be bought / for a shopping list ("what do we need to buy", "買い物リスト作って", "وش لازم نشتري"), return: {"action": "shopping_list"} — the system renders the list, so keep your text reply to one short line or nothing.
- If the user asks when something will run out or how long stock will last ("when will we run out", "how long will the olive oil last", "オイルいつなくなる", "متى يخلص الزيت"), return: {"action": "run_out_forecast", "item": "olive oil"} — use "item": null to forecast everything. The system renders the forecast.
- If the user states an ABSOLUTE count, replacing the recorded amount ("actually we have 7kg of chicken", "鶏肉は7kgある"), return: {"action": "set_stock", "item": "chicken", "quantity": 7, "unit": "kg"} — convert to the item's tracked unit like adjust_stock. Use adjust_stock for relative changes ("we used 2kg"), set_stock for absolute counts.
- If the user says a receipt line was logged wrong ("that receipt was wrong, chicken was 5kg not 8kg"), return: {"action": "fix_receipt_item", "item": "chicken", "quantity": 5, "unit": "kg"}
- If the user wants to undo/delete the most recent receipt ("undo that receipt", "آخر فاتورة غلط، احذفها", "さっきのレシート取り消して"), return: {"action": "undo_receipt"}
- If the user asks to SEE a logged receipt photo again ("show me Tuesday's receipt", "show the receipt from Tanaka"), return: {"action": "show_receipt", "date": "YYYY-MM-DD or null", "supplier": "supplier name or null"} — resolve relative days like "Tuesday" using today's date above.
The "item" field in any action block must be in English (use the canonical inventory names above). Everyone in the kitchen group can ask for inventory details, reports, thresholds, supplier notes, corrections, and documents.`;

// Matches a flat, single-level JSON object containing an "action" key.
const ACTION_BLOCK_RE = /\{[^{}]*"action"[^{}]*\}/g;

export function parseActionFromReply(text) {
  const matches = (text || '').match(ACTION_BLOCK_RE);
  if (!matches) return { reply: (text || '').trim(), action: null };
  const block = matches[matches.length - 1];
  let action = null;
  try {
    action = JSON.parse(block);
  } catch {
    return { reply: text.trim(), action: null };
  }
  const reply = text.replace(block, '').replace(/```(?:json)?/gi, '').trim();
  return { reply, action };
}

export async function chatReply({ userMessage, inventoryJson, name }) {
  const roleLine = `The user writing to you is kitchen staff named ${name}. They have full inventory access.`;
  const prompt =
    NL_SYSTEM_PROMPT.replace('{INVENTORY_JSON}', () => inventoryJson).replace('{TODAY}', () => todayISO()) +
    `\n\n${roleLine}\n\nUser message:\n${userMessage}`;
  const text = await generateText(prompt);
  return parseActionFromReply(text);
}
