import cron from 'node-cron';
import { config, log, logError } from './config.js';
import * as q from './db/queries.js';
import { generateText } from './ai/chat.js';
import { checkThresholds } from './alerts/alertEngine.js';

const REPORT_PROMPT = `You are the inventory analyst for Shawarma House and Yaya Pizza, a dual-concept restaurant in Japan.

Here is the past 7 days of inventory data:
{JSON_DATA}

Write a concise weekly report for the restaurant team. Format it exactly like this:

💰 SPEND THIS WEEK
• Shawarma House: ¥X
• Yaya Pizza: ¥Y
• Shared: ¥Z
• Total: ¥SUM

📈 NOTABLE TRENDS
[2–4 bullet points. Only include observations grounded in the actual data. Examples: an item costing more than the previous week, an item being adjusted down repeatedly (likely spoilage), a category with unusually high spend. If data is too thin to draw conclusions, say so plainly.]

⚠️ ITEMS NEEDING ATTENTION
[Items at or below threshold. Or: "All items well-stocked ✅"]

💡 RECOMMENDATIONS
[2–3 specific, actionable suggestions. Name the items and numbers. No filler.]

Under 350 words. Direct. The kitchen team is busy.`;

export function startScheduler(bot) {
  // Weekly report — every Monday 08:00 in the configured timezone.
  cron.schedule(
    '0 8 * * 1',
    () => sendWeeklyReport(bot).catch((err) => logError('Scheduled weekly report failed:', err.message)),
    { timezone: config.timezone }
  );

  // Daily threshold scan — 09:00. Catches items that stayed low with no new
  // receipts (the 12h dedup in checkThresholds prevents repeat spam).
  cron.schedule(
    '0 9 * * *',
    () => dailyThresholdCheck(bot).catch((err) => logError('Daily threshold check failed:', err.message)),
    { timezone: config.timezone }
  );

  log(`Scheduler running — weekly report Mon 08:00, daily stock check 09:00 (${config.timezone})`);
}

// Also triggered on demand when anyone in the kitchen group asks for a "report".
export async function sendWeeklyReport(bot, chatId = config.kitchenGroupId) {
  const data = await q.getWeeklyData();
  const prompt = REPORT_PROMPT.replace('{JSON_DATA}', () => JSON.stringify(data, null, 2));
  const report = await generateText(prompt);
  await bot.sendMessage(chatId, report);
  log(`Weekly report sent to ${chatId}`);
}

export async function dailyThresholdCheck(bot) {
  const items = await q.getAllItems();
  await checkThresholds(bot, items);
  log('Daily threshold check completed');
}
