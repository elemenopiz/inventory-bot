import { generateVision, extractJson } from './chat.js';

export const RECEIPT_PROMPT = `You are a receipt parser for a restaurant in Japan. Extract every line item and return ONLY valid JSON — no markdown, no explanation, no backticks.

{
  "receipt_date": "YYYY-MM-DD or null",
  "supplier": "name or null",
  "total": number or null,
  "tax": number or null,
  "currency": "JPY",
  "confidence": "high | medium | low",
  "parse_notes": "issues or null",
  "items": [
    {
      "original_name": "exact text from receipt",
      "canonical_name": "English normalized name",
      "quantity": number,
      "unit": "kg | L | pc | bag | box",
      "unit_price": number or null,
      "total_price": number or null,
      "brand_guess": "shawarma | pizza | shared | unknown"
    }
  ]
}

Unit rules: weight → kg (g÷1000). Volume → L (ml÷1000). 個/枚/本 → pc. 袋 → bag. 箱 → box.
Brand hints — shawarma: pita, tahini, shawarma meat, chickpeas, sumac, cumin, hummus. Pizza: 00 flour, mozzarella, pepperoni, prosciutto, pizza boxes. Shared: olive oil, tomatoes, onions, garlic, lemons, parsley, salt, pepper, cleaning supplies.
Not a receipt → {"error": "not_a_receipt"}
Unreadable → {"error": "unreadable", "parse_notes": "description"}`;

// Returns the parsed receipt object, or an {error, parse_notes} object.
// Throws AIServiceError (from generateVision) on API failure.
export async function parseReceipt(base64Image, mimeType = 'image/jpeg') {
  const raw = await generateVision(RECEIPT_PROMPT, base64Image, mimeType);
  const parsed = extractJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'unreadable', parse_notes: 'The AI returned data I could not understand. Try a clearer, well-lit photo.' };
  }
  return parsed;
}
