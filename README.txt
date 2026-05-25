# StepOne WhatsApp AI Bot
## Setup Guide (Windows PC)

---

## STEP 1 — Install Node.js
Download from: https://nodejs.org (LTS version)
Run the installer. Restart your PC after.

---

## STEP 2 — Create the bot folder
Open Command Prompt and run:

```
mkdir C:\stepone-bot
cd C:\stepone-bot
```

Copy bot.js and .env into this folder.

---

## STEP 3 — Install dependencies
In Command Prompt (inside C:\stepone-bot):

```
npm install express @anthropic-ai/sdk axios dotenv
```

---

## STEP 4 — Create your .env file
Create a file called exactly:  .env  (no other name)
Paste this inside and fill in YOUR values:

```
ANTHROPIC_API_KEY=sk-ant-XXXXXXXX        ← from console.anthropic.com
PERISKOPE_API_KEY=eyJYOUR_KEY            ← from console.periskope.app
PERISKOPE_PHONE_ID=918657022012@c.us     ← your bot number
PORT=3000
```

---

## STEP 5 — Get your Anthropic API key (FREE CREDITS)
1. Go to: https://console.anthropic.com
2. Sign up / log in
3. Click "API Keys" → "Create Key"
4. Copy the key → paste into .env
Note: New accounts get $5 free credits = roughly 500-1000 bot replies

---

## STEP 6 — Find your PC's local IP address
Open Command Prompt and run:

```
ipconfig
```

Look for "IPv4 Address" — usually looks like 192.168.1.XX
Write it down — you need it for Step 7.

---

## STEP 7 — Set Periskope Webhook URL
1. Go to console.periskope.app
2. Settings → Webhooks → Add Webhook
3. Enter:  http://192.168.1.XX:3000/webhook
   (replace XX with your actual IP from Step 6)
4. Save it

---

## STEP 8 — Start the bot
In Command Prompt (inside C:\stepone-bot):

```
node bot.js
```

You should see:
╔════════════════════════════════════════╗
║   StepOne WhatsApp AI Bot — RUNNING    ║
╚════════════════════════════════════════╝

---

## STEP 9 — Test it
Send a WhatsApp message directly to the bot number.
It should reply within 3-5 seconds.

In groups: tag the bot by name or use /help, /summary, /status

---

## HOW THE BOT WORKS

Direct messages    → Always replies
Group messages     → Only replies when @mentioned or /command used
Listen-only groups → Logs messages, never replies (configure in bot.js)

Commands:
/summary   → Summarises recent group conversation
/status    → What needs attention right now
/help      → Lists capabilities

---

## KEEP IT RUNNING 24/7 (PM2)
Install PM2 process manager so bot restarts if it crashes:

```
npm install -g pm2
pm2 start bot.js --name stepone-bot
pm2 save
pm2 startup
```

Now the bot survives PC restarts automatically.

---

## COST ESTIMATE
Periskope Starter : $20/month
Claude API        : ~$5-10/month (Sonnet is very cheap)
TOTAL             : ~$25-30/month = ~₹2,100/month
