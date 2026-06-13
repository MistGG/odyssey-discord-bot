# Odyssey Discord Bot — agent rules

When working in `odyssey-discord-bot`:

1. **Reuse companion logic** — port from `../dmo-timeline-overlay/src/lib/raidTimerApi.ts` and `../dmo-timeline-overlay/electron/main/bossTimerAlerts.ts` instead of reimplementing train math.
2. **Use a real Discord bot** (discord.js), not webhooks-only, so pinned live boards and slash commands work.
3. **Dedupe alerts** — same spawn cycle must not ping twice; use `trainNotifyKey` pattern from companion.
4. **Secrets** — `DISCORD_BOT_TOKEN` in `.env` only; never commit. No Supabase service role in this repo for community use.
5. **API** — poll `https://thedigitalodyssey.com/api/raid-timer`; do not scrape game client.
6. **Scope** — raid world bosses only in v1; not meter/Digi Aura dungeon alerts.

Follow `TRACKING.md` for task checklist and MVP acceptance criteria.
