import 'dotenv/config';

const REQUIRED_VARS = [
  ['TELEGRAM_BOT_TOKEN', 'Telegram bot token from @BotFather'],
  ['KIMI_API_KEY', 'Moonshot/Kimi API key from https://platform.moonshot.ai'],
  ['DATABASE_URL', 'PostgreSQL connection string, e.g. postgresql://user:pass@localhost:5432/inventory_bot'],
  ['KITCHEN_GROUP_ID', 'Telegram group chat ID for the kitchen (negative number)'],
  ['TIMEZONE', 'IANA timezone, e.g. Asia/Tokyo'],
];

const missing = REQUIRED_VARS.filter(([key]) => !process.env[key] || process.env[key].trim() === '');
if (missing.length > 0) {
  console.error('❌ Cannot start — missing required environment variables:\n');
  for (const [key, hint] of missing) {
    console.error(`   ${key}  →  ${hint}`);
  }
  console.error('\nCopy .env.example to .env and fill in every value, then start again.');
  process.exit(1);
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN.trim(),
  kimiApiKey: process.env.KIMI_API_KEY.trim(),
  // One model for both receipt-photo vision and chat. k2.5 is a reasoning model — see the
  // max_tokens note in chat.js. Override with KIMI_MODEL if you ever want to swap.
  kimiModel: (process.env.KIMI_MODEL || 'kimi-k2.5').trim(),
  kimiBaseUrl: (process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1').trim().replace(/\/+$/, ''),
  databaseUrl: process.env.DATABASE_URL.trim(),
  kitchenGroupId: process.env.KITCHEN_GROUP_ID.trim(),
  timezone: process.env.TIMEZONE.trim(),
};

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function logError(...args) {
  console.error(`[${new Date().toISOString()}] ERROR:`, ...args);
}

export function userName(msg) {
  const from = (msg && msg.from) || {};
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
}

// Today's date as YYYY-MM-DD in the configured timezone (en-CA locale formats ISO-style).
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}
