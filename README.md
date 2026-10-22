# dialled-job-board

Discord bot + API for the Dialled job board (runs on Railway).

## Channels

| Flow | Source channel | Destination | Approval |
|---|---|---|---|
| Standard | `#job-tips` (screenshots) | `JOB_BOARD_CHANNEL_ID` | Manual (Approve / Edit / Discard buttons) |
| Premium | `PREMIUM_TIPS_CHANNEL_ID` (text and/or screenshots, from anyone) | `PREMIUM_BOARD_CHANNEL_ID` | Automatic |

Premium board offers are graded by monthly OTE, with matching embed colours:

- 🌱 Entry (green): under $5k/month
- 🔥 Standard (red): $5k–$15k/month, $15k+ that isn't verified, or no pay listed
- 💎 Premium (gold): $15k+/month with verified OTE

Premium tips: the bot reacts 🔍 while reading, ✅ once posted, ❌ if it failed. Casual chat that isn't a job is ignored. Any links in the tip text are posted exactly as written.

## Environment variables

- `DISCORD_TOKEN`
- `DATABASE_URL`
- `ANTHROPIC_API_KEY`
- `JOB_BOARD_CHANNEL_ID`
- `PORTAL_API_KEY` (optional)
- `PREMIUM_TIPS_CHANNEL_ID`
- `PREMIUM_BOARD_CHANNEL_ID`
