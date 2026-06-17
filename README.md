# Odyssey Discord Bot

Discord bot for **raid boss spawn alerts**, **boss trains**, and **role pings** — porting train/alert logic from [Odyssey Companion](https://github.com/MistGG/dmo-timeline-overlay) (`raidTimerApi.ts`, `bossTimerAlerts.ts`).

## Features (MVP)

- Polls `https://thedigitalodyssey.com/api/raid-timer` on a configurable interval
- Groups spawns into **trains** (5-minute window, same rules as Companion)
- Sends embed alerts with optional role ping at configurable lead times (default 5m and 2m)
- Dedupes alerts per guild using `trainNotifyKey` (no duplicate pings in the same spawn cycle)
- Slash commands: `/setup`, `/trains`

## Setup

1. Create a [Discord application](https://discord.com/developers/applications) and bot user.
2. Copy `.env.example` → `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application ID (for slash command registration) |
| `DISCORD_DEV_GUILD_ID` | no | Guild ID for instant dev command registration |
| `DISCORD_ALERT_CHANNEL_ID` | no | Default alert channel (until `/setup` is run) |
| `DISCORD_PING_ROLE_ID` | no | Default ping role |
| `ALERT_LEAD_MINUTES` | no | Comma-separated lead times (default `5`) |
| `DISCORD_PATCH_NOTES_CHANNEL_ID` | no | Default patch notes channel |
| `RAID_POLL_MS` | no | Poll interval ms (default `60000`, min `15000`) |

3. Install and run:

```bash
npm install
npm run dev
```

## Bot invite scopes

When generating an OAuth2 URL, enable:

- `bot`
- `applications.commands`

Suggested bot permissions: **Send Messages**, **Embed Links**, **Manage Messages** (optional, for future pinned live board).

Example invite URL shape:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=18432&scope=bot%20applications.commands
```

(`18432` = Send Messages + Embed Links)

## Slash commands

| Command | Description |
|---------|-------------|
| `/setup alert-channel #channel` | Where train alerts are posted |
| `/setup ping-role @role` | Role to ping (omit role to clear) |
| `/setup lead-times 5` | Minutes before spawn to alert (up to 3 values) |
| `/setup patch-notes-channel #channel` | Where new patch notes are posted |
| `/setup show` | Show current guild settings |
| `/trains` | On-demand snapshot of upcoming trains |
| `/patch-notes test` | Preview the latest patch note in the configured channel |

Guild settings are stored in `data/guild-config.json` (gitignored).

## Deploy

The bot must stay online to poll the raid timer and send alerts.

**Recommended:** [Oracle Cloud Always Free](deploy/oracle/README.md) — free 24/7 VM with systemd.

Local production build:

```bash
npm ci
npm run build
npm start
```

Dev with auto-reload: `npm run dev`

## Related repos

| Project | Reuse |
|---------|--------|
| `../dmo-timeline-overlay` | `src/lib/raidTimerApi.ts`, `electron/main/bossTimerAlerts.ts` |
| `../digimon-hub` | Raid timer API types |

See `TRACKING.md` for v2 roadmap (Supabase guild config, live board, per-boss mutes).
