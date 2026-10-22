# Geston MD Mini — Ready to Deploy

This package keeps the **Geston-Md main repository's commands** by downloading the current `main` source at first boot, then applies a small multi-session patch.

## What it does
- Web pairing page
- User enters WhatsApp number and requests a pairing code
- A dedicated child process runs the full Geston-Md command set for that session
- Session files and database are isolated per generated bot
- No SESSION_ID copy/paste is required
- Referral links: `/?ref=CODE`
- Referral statistics stored in `mini-data.json`
- Health endpoint: `/health`

## Deploy

Set:
- `PORT` = platform-provided port (optional locally)
- `PUBLIC_URL` = your HTTPS URL (recommended for referral links)
- `MAX_BOTS` = maximum simultaneous child bots, default 3
- `PAIRING_TTL_MINUTES` = pairing request lifetime, default 15

Then:

```bash
npm install
npm start
```

The first boot needs outbound HTTPS access to GitHub to download `gestontech/Geston-Md`.

## Local test

```bash
npm install
npm start
```

Open `http://localhost:3000`.

### Important
The user still has to confirm the pairing inside WhatsApp. The website only requests the official Baileys pairing code; it cannot silently authorize a WhatsApp account.

Keep `.mini-data/` on persistent storage in production. Do not expose the session folders or `mini-data.json` publicly.
