import TelegramBot from 'node-telegram-bot-api';
import { config, log, logError } from './config.js';
import { initDb, pool } from './db/client.js';
import { handlePhoto } from './handlers/photo.js';
import { handleText, setBotUsername } from './handlers/naturalLanguage.js';
import { handleCsvDocument, maybeStartOnboarding } from './handlers/setup.js';
import { startScheduler } from './scheduler.js';

async function main() {
  try {
    await initDb();
  } catch (err) {
    logError('Database initialization failed:', err.message || err.code || String(err));
    console.error(
      '\nCheck that PostgreSQL is running and DATABASE_URL in .env is correct,\n' +
        'e.g. postgresql://user:pass@localhost:5432/inventory_bot\n'
    );
    process.exit(1);
  }

  const bot = new TelegramBot(config.telegramToken, { polling: true });

  bot.on('polling_error', (err) => {
    logError('Telegram polling:', err.message);
  });

  // Needed to detect @mentions in the kitchen group. Also doubles as a
  // token sanity check at startup.
  try {
    const me = await bot.getMe();
    setBotUsername(me.username);
    log(`Connected to Telegram as @${me.username}`);
  } catch (err) {
    logError('Could not reach Telegram (is TELEGRAM_BOT_TOKEN correct?):', err.message);
  }

  bot.on('message', async (msg) => {
    try {
      if (!msg.from || msg.from.is_bot) return;

      if (msg.photo && msg.photo.length > 0) {
        await handlePhoto(bot, msg);
        return;
      }

      if (msg.document) {
        const doc = msg.document;
        const name = (doc.file_name || '').toLowerCase();
        const mime = doc.mime_type || '';
        if (mime.startsWith('image/')) {
          // Receipt sent as an uncompressed file instead of a photo.
          await handlePhoto(bot, msg, doc.file_id);
        } else if (name.endsWith('.csv') || mime.includes('csv')) {
          await handleCsvDocument(bot, msg);
        }
        return;
      }

      if (msg.text) {
        await handleText(bot, msg);
      }
    } catch (err) {
      logError('Message router:', err.message);
      try {
        await bot.sendMessage(msg.chat.id, '❌ Something went wrong — logged. Try again.');
      } catch (sendErr) {
        logError('Could not send error message:', sendErr.message);
      }
    }
  });

  startScheduler(bot);
  await maybeStartOnboarding(bot);

  log('🤖 Inventory bot is running — Shawarma House & Yaya Pizza');

  const shutdown = async (signal) => {
    log(`${signal} received — shutting down`);
    try {
      await bot.stopPolling();
      await pool.end();
    } catch (err) {
      logError('Shutdown:', err.message);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logError('Fatal startup error:', err);
  process.exit(1);
});
