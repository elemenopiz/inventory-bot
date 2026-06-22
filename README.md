# Inventory Bot Setup Guide

This guide takes you from this code folder to a working Telegram inventory bot in a group chat with your employees.

The bot is built for one shared kitchen group. Employees send receipt photos to the group; the bot reads the receipts, updates stock, remembers prices, warns when items are low, and answers inventory questions when mentioned.

## What You Will Need

- A server or VPS that can stay online all day. Ubuntu is assumed in the commands below.
- Node.js 20 or newer.
- PostgreSQL.
- A Telegram group for the employees.
- A Moonshot (Kimi) API key — from [platform.moonshot.ai](https://platform.moonshot.ai).
- This project folder on the server.

Important: this bot uses Telegram long polling, not webhooks. That means you do not need to open an HTTPS port or configure a domain name. Telegram stores updates and the bot receives them with `getUpdates`.

## Big Picture

You will do these steps:

1. Prepare the server.
2. Put the code on the server.
3. Create a PostgreSQL database.
4. Create the Telegram bot with BotFather.
5. Disable Telegram bot privacy mode.
6. Create or prepare the employee group chat.
7. Get the group chat ID.
8. Create the `.env` file.
9. Install dependencies.
10. Run the bot once manually.
11. Load starting inventory.
12. Test the bot in the group.
13. Run it permanently with PM2.
14. Add nightly database backups.
15. Show employees how to use it.

Follow them in order. Do not skip the privacy-mode step; receipt photos in group chat depend on it.

## 1. Prepare The Server

SSH into your server:

```bash
ssh your-user@your-server-ip
```

Update packages:

```bash
sudo apt update
sudo apt upgrade -y
```

Install basic tools:

```bash
sudo apt install -y curl git postgresql postgresql-client
```

Check Node.js:

```bash
node --version
npm --version
```

If `node --version` is missing or lower than `v20`, install Node.js 20. One common Ubuntu method is:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version
npm --version
```

Checkpoint: `node --version` should print `v20...` or newer.

## 2. Put The Code On The Server

Choose where the bot will live. This guide uses `/opt/inventory-bot`.

Create the folder:

```bash
sudo mkdir -p /opt/inventory-bot
sudo chown "$USER":"$USER" /opt/inventory-bot
```

Copy the project into that folder.

If you have the code in Git:

```bash
git clone YOUR_REPO_URL /opt/inventory-bot
cd /opt/inventory-bot
```

If you have the folder on your laptop, upload it from your laptop. The `/.` at the end matters because it copies hidden files like `.env.example` too:

```bash
scp -r /path/to/inventory-bot/. your-user@your-server-ip:/opt/inventory-bot/
```

Then SSH back into the server and enter the folder:

```bash
cd /opt/inventory-bot
```

Checkpoint:

```bash
ls
```

You should see files like `package.json`, `src`, `scripts`, and `ecosystem.config.cjs`.

## 3. Create The PostgreSQL Database

Create a database user and database. Replace `choose-a-strong-password` with a real password and save it somewhere safe. For the least painful setup, use letters, numbers, hyphens, and underscores; special URL characters like `@`, `/`, `:`, and `#` must be URL-encoded inside `DATABASE_URL`.

```bash
sudo -u postgres psql
```

Inside the PostgreSQL prompt, run:

```sql
CREATE USER inventory_bot_user WITH PASSWORD 'choose-a-strong-password';
CREATE DATABASE inventory_bot OWNER inventory_bot_user;
GRANT ALL PRIVILEGES ON DATABASE inventory_bot TO inventory_bot_user;
\q
```

Test the login:

```bash
psql "postgresql://inventory_bot_user:choose-a-strong-password@localhost:5432/inventory_bot" -c "SELECT 1;"
```

Checkpoint: it should print a row containing `1`.

## 4. Create The Telegram Bot

On Telegram:

1. Open a chat with `@BotFather`.
2. Send `/newbot`.
3. Give it a display name, for example `Shawarma Inventory`.
4. Give it a username ending in `bot`, for example `shawarma_inventory_bot`.
5. BotFather will send a token that looks like `123456789:ABC...`.

Save that token. It becomes `TELEGRAM_BOT_TOKEN` in `.env`.

Do not share the token with employees. Anyone with the token can control the bot.

## 5. Disable Bot Privacy Mode

This is required for group receipt photos.

By default, Telegram bots added to groups run in Privacy Mode and only see selected messages and commands. This bot needs to see receipt photos posted by employees in the group, so privacy mode must be disabled.

In the `@BotFather` chat:

1. Send `/setprivacy`.
2. Choose your new bot.
3. Choose `Disable`.

If the bot was already in the employee group before you disabled privacy mode, remove it from the group and add it again.

Checkpoint: BotFather should say privacy mode is disabled.

## 6. Create The Employee Group Chat

In Telegram:

1. Create a group for the kitchen or open your existing employee group.
2. Add your new bot to the group.
3. Add the employees who should send receipts or ask stock questions.
4. Send a simple test message in the group, for example:

```text
hello inventory bot
```

The bot may not answer yet because the server is not running. That is okay. This message helps us find the group chat ID in a later step.

How the group will work after setup:

- Receipt photos are logged automatically.
- Text questions need an `@bot_username` mention or a reply to one of the bot's messages.
- This keeps the bot from answering normal employee conversation.

## 7. Get The Group Chat ID

Use the bot token from BotFather.

In a browser, open this URL after replacing `YOUR_BOT_TOKEN`:

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

Look for a section like this:

```json
"chat": {
  "id": -1001234567890,
  "title": "Kitchen Inventory",
  "type": "supergroup"
}
```

Copy the `id`. It is usually a negative number for a group or supergroup, often starting with `-100`.

That value becomes `KITCHEN_GROUP_ID` in `.env`.

If the page says `"result":[]`:

1. Make sure the bot is in the group.
2. Send another message in the group.
3. Refresh the `getUpdates` URL.

If it still shows no group message, check that privacy mode was disabled and remove/re-add the bot to the group.

## 8. Get A Moonshot (Kimi) API Key

The bot uses Moonshot's Kimi API to read receipt photos and answer inventory questions.

1. Open [platform.moonshot.ai](https://platform.moonshot.ai) and sign in.
2. Create an API key.
3. Copy it.

It becomes `KIMI_API_KEY` in `.env`. That single key is all you need. By default, the bot uses `kimi-k2.5` for both receipt photos and inventory chat. Advanced users can override the model with `KIMI_MODEL` in `.env`, but it is optional.

Tip: keep an eye on your balance at first. A small top-up (a few dollars) typically covers weeks of normal kitchen use.

## 9. Create The `.env` File

On the server:

```bash
cd /opt/inventory-bot
cp .env.example .env
nano .env
```

Fill it in like this:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABC_from_BotFather
KIMI_API_KEY=your_moonshot_api_key
# KIMI_MODEL=kimi-k2.5
DATABASE_URL=postgresql://inventory_bot_user:choose-a-strong-password@localhost:5432/inventory_bot
KITCHEN_GROUP_ID=-1001234567890
TIMEZONE=Asia/Tokyo
```

Save and exit nano:

- Press `Ctrl+O`, then Enter.
- Press `Ctrl+X`.

Checkpoint:

```bash
for key in TELEGRAM_BOT_TOKEN KIMI_API_KEY DATABASE_URL KITCHEN_GROUP_ID TIMEZONE; do
  if awk -F= -v k="$key" '$1 == k && $2 ~ /[^[:space:]#]/ { found = 1 } END { exit !found }' .env; then
    echo "$key set"
  else
    echo "$key MISSING"
  fi
done
```

Every line should say `set`. Do not paste the full `.env` into group chats or screenshots.

## 10. Install The Bot Dependencies

From the project folder:

```bash
cd /opt/inventory-bot
npm install
```

Checkpoint:

```bash
npm run
```

You should see scripts including `start`, `dev`, and `backup`.

## 11. Run The Bot Manually First

Before starting PM2, run it in the terminal so errors are easy to see:

```bash
cd /opt/inventory-bot
npm start
```

A good startup looks like this:

```text
Database schema applied
Connected to Telegram as @your_bot_username
Scheduler running
Inventory bot is running
```

If it stops immediately, read the error. The most common problems are:

- Wrong `DATABASE_URL`.
- Missing `.env` value.
- Wrong Telegram bot token.
- PostgreSQL is not running.

Leave this terminal running for the next two steps.

## 12. Load Starting Inventory

The bot needs initial stock counts before receipt photos become useful.

Option A: mention the bot in the employee group with a setup message:

```text
@your_bot_username setup: olive oil 5L, chicken thigh 8kg, pita bread 200pc, mozzarella 4kg
```

Option B: upload a CSV with these columns:

```csv
name,brand,unit,current_stock,reorder_threshold
olive oil,shared,L,5,2
chicken thigh,shawarma,kg,8,3
mozzarella,pizza,kg,4,2
pita bread,shawarma,pc,200,50
```

Valid `brand` values:

```text
shawarma
pizza
shared
```

The bot should confirm how many items were loaded.

You can change thresholds later in plain English:

```text
set olive oil threshold to 2L
```

## 13. How The Bot Is Primed

The baseline inventory is the first layer of context. Once someone loads the starting stock, the bot stores those items in PostgreSQL and sends the current inventory table to Kimi every time it answers a stock question.

The bot does not rely on one long Telegram conversation as memory. That avoids the usual long-chat quality drop. The durable memory is:

- PostgreSQL tables for items, current stock, receipts, price history, adjustments, thresholds, and supplier notes.
- The system prompt in `src/ai/chat.js`, which defines how the bot should interpret kitchen requests.
- Weekly reports and stock views generated directly from the database.

Employees do not need direct PostgreSQL access. They access the database through the bot in the group chat:

```text
@your_bot_username show stock
@your_bot_username what do we need to buy?
@your_bot_username price history for chicken
@your_bot_username report
```

The server owner can still access PostgreSQL directly over SSH for maintenance, backups, or emergency repair, but normal kitchen use should happen through Telegram.

## 14. Test In The Employee Group

In the employee group, test these in order.

First, ask a stock question by mentioning the bot:

```text
@your_bot_username how much olive oil do we have?
```

Expected result: the bot answers with the current stock.

Second, ask for the shopping list:

```text
@your_bot_username what do we need to buy?
```

Expected result: the bot sends low-stock or soon-to-run-out items.

Third, send a clear receipt photo to the group.

Expected result:

1. The bot says it is reading the receipt.
2. The bot logs line items.
3. Stock counts increase.
4. If the receipt looks duplicated, the bot asks for YES or NO.

Fourth, test a correction:

```text
@your_bot_username actually that chicken was 5kg not 8kg
```

Expected result: the bot fixes the recent receipt line and stock count.

Fifth, test receipt undo:

```text
@your_bot_username undo that last receipt
```

Expected result: the bot shows the receipt summary and asks for YES or NO before reversing it.

## 15. Stop The Manual Run

When the test works, go back to the server terminal where `npm start` is running and press:

```text
Ctrl+C
```

Now set it up permanently.

## 16. Run Permanently With PM2

Install PM2:

```bash
sudo npm install -g pm2
```

Start the bot using the included PM2 config:

```bash
cd /opt/inventory-bot
pm2 start ecosystem.config.cjs
```

Check it:

```bash
pm2 status
pm2 logs inventory-bot
```

Save the PM2 process list:

```bash
pm2 save
```

Make PM2 restart after server reboot:

```bash
pm2 startup
```

PM2 will print a `sudo ...` command. Copy that exact command and run it.

Checkpoint:

```bash
pm2 status
```

You should see `inventory-bot` as `online`.

## Cloudways fallback

If you must use a Cloudways server and only see a PHP-style application wizard, use the app as a container for the files and run the bot from SSH.

What works on Cloudways:

- SSH access to the server.
- Local Node modules in the application folder.
- Cron jobs with an advanced editor.

That lets you run the bot as a background Node process and keep a watchdog cron job that restarts it if it dies.

Suggested flow:

1. Create the Cloudways app anyway, even if it is a PHP custom app.
2. SSH into the server.
3. Install Node.js in your Cloudways shell if it is not already available.
4. Put the repo in the application directory.
5. Run `npm install`.
6. Start the bot with `pm2 start ecosystem.config.cjs` if PM2 is available.
7. Add a Cloudways cron job that runs `scripts/cloudways-watchdog.sh` every 5 minutes.

Example advanced cron entry:

```cron
*/5 * * * * cd /path/to/inventory-bot && /usr/bin/env bash scripts/cloudways-watchdog.sh >> logs/cloudways-watchdog.log 2>&1
```

If PM2 is not available, the watchdog falls back to `nohup node src/bot.js`.

## 17. Add Nightly Database Backups

The project includes a backup script:

```bash
scripts/backup-db.sh
```

It reads `DATABASE_URL` from `.env`, writes compressed PostgreSQL dumps into `backups`, and deletes backups older than 14 days.

Test it:

```bash
cd /opt/inventory-bot
npm run backup
ls -lh backups
```

If that works, add a nightly cron job:

```bash
crontab -e
```

Add this line:

```cron
0 2 * * * cd /opt/inventory-bot && mkdir -p backups && /usr/bin/env bash scripts/backup-db.sh >> backups/backup.log 2>&1
```

Checkpoint the next day:

```bash
ls -lh /opt/inventory-bot/backups
tail -50 /opt/inventory-bot/backups/backup.log
```

## 18. Employee Instructions

Send this to employees:

```text
Inventory bot rules:

1. When a delivery arrives, send a clear photo of the receipt in this group.
2. Keep the whole receipt visible, flat, and well-lit.
3. To ask the bot a question, mention it: @your_bot_username how much chicken do we have?
4. If the bot reads a receipt wrong, mention it: @your_bot_username actually that was 5kg not 8kg.
5. If a receipt was sent by mistake, mention it: @your_bot_username undo that last receipt.
6. For normal kitchen chat, do not mention the bot.
```

Useful employee messages:

```text
@your_bot_username how much chicken do we have?
@your_bot_username show stock
@your_bot_username what do we need to buy?
@your_bot_username when will olive oil run out?
@your_bot_username actually we used 2kg onions
@your_bot_username actually that was 5kg not 8kg
@your_bot_username undo that last receipt
@your_bot_username report
@your_bot_username show price history for chicken
@your_bot_username set chicken threshold to 5kg
@your_bot_username add supplier note for flour: call Tanaka Foods 03-1234-5678
@your_bot_username show me Tuesday's receipt from Tanaka
```

## 19. Daily Operation

The bot automatically does these things:

- Reads receipt photos and logs purchases.
- Adds new receipt items to inventory if they do not exist yet.
- Stores the original Telegram receipt photo ID for later recall.
- Updates stock counts.
- Stores item price history.
- Warns about duplicate receipts.
- Alerts when stock is at or below reorder threshold.
- Alerts the group when prices jump.
- Builds shopping lists on demand.
- Estimates run-out dates from recent purchase history.
- Sends a weekly group report every Monday at 08:00.
- Runs a daily low-stock scan at 09:00.

## 20. Common Problems

### The bot ignores group receipt photos

Most likely privacy mode is still enabled.

Fix:

1. Go to `@BotFather`.
2. Send `/setprivacy`.
3. Choose the bot.
4. Choose `Disable`.
5. Remove the bot from the employee group.
6. Add it back to the group.
7. Restart the bot:

```bash
pm2 restart inventory-bot
```

### The bot logs photos but does not answer text in the group

This is usually expected. In group chat, text questions must mention the bot or reply to one of the bot's messages.

Use:

```text
@your_bot_username show stock
```

### The bot says the database is unreachable

Test PostgreSQL:

```bash
export DATABASE_URL="$(node -e "require('dotenv').config(); process.stdout.write(process.env.DATABASE_URL || '')")"
psql "$DATABASE_URL" -c "SELECT 1;"
```

If that fails, check the `DATABASE_URL` in `.env`, the database password, and whether PostgreSQL is running:

```bash
sudo systemctl status postgresql
```

### The bot is running twice

Symptoms: duplicate replies or duplicate receipt logs.

Check:

```bash
pm2 status
ps aux | grep node
```

Stop the manual run if one is open. PM2 should be the only long-running copy.

### You changed `.env` but nothing changed

Restart PM2:

```bash
pm2 restart inventory-bot
```

## 21. PM2 Commands You Will Actually Use

```bash
pm2 status
pm2 logs inventory-bot
pm2 restart inventory-bot
pm2 stop inventory-bot
pm2 start ecosystem.config.cjs
pm2 save
```

## 22. References Checked

- Telegram Bot API: `getUpdates` receives incoming updates with long polling, and updates contain message objects such as text and photos: [Telegram Bot API](https://core.telegram.org/bots/api#getting-updates).
- Telegram bot privacy mode: bots in groups use Privacy Mode by default and only see selected messages unless disabled: [Telegram Bot Features](https://core.telegram.org/bots/features#privacy-mode).
- PM2 ecosystem files and startup persistence: [PM2 ecosystem file](https://pm2.keymetrics.io/docs/usage/application-declaration/) and [PM2 startup](https://pm2.keymetrics.io/docs/usage/startup/).
- PostgreSQL backups: `pg_dump` exports a database, and custom format is compressed and restorable with `pg_restore`: [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html).
