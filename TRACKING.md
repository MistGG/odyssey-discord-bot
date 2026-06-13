# Odyssey Discord Bot — tracking brief

**Status:** MVP implemented  
**Owner:** MistGG / Odyssey Calc  
**Created from chat:** raid alerts + train times + role ping + clean Discord UI

---

## Goal

A **Discord bot** (not webhook-only) that:

1. **Raid boss alerts** — notify when world bosses are alive, ready, or approaching spawn (configurable lead time, e.g. 5m / 2m).
2. **Train alerts** — group spawns within 5 minutes into a single “boss train” message (same rules as companion).
3. **Role ping** — optional `<@&roleId>` on alert messages per guild/channel config.
4. **Clean Discord UI** — rich embeds + optional **pinned live board** message updated every ~1 min (trains + countdowns).

Out of scope for v1: Digi Aura dungeon timeline boss alerts (companion-only event stream).

---

## Reuse from companion (port or shared package)

| Logic | Source file |
|-------|-------------|
| Fetch + normalize raid API | `dmo-timeline-overlay/src/lib/raidTimerApi.ts` |
| Train grouping | `groupByNextSpawnWindow`, `groupAlertSnapshotsForNotify`, `BOSS_TRAIN_WINDOW_MS` |
| Alert dedupe keys | `electron/main/bossTimerAlerts.ts` → `trainNotifyKey` |
| Copy / lead minutes | `relaxedBossCopy`, `relaxedTrainCopy` |

---

## Recommended stack

- **Runtime:** Node 20+ TypeScript
- **Library:** `discord.js` v14
- **Scheduler:** `setInterval` in bot process, or node-cron (poll every 30–60s)
- **Config (v1):** env vars; **(v2):** Supabase table `discord_guild_config` with RLS
- **Hosting:** Railway / Fly.io / VPS / Cloudflare Workers + Discord gateway (Workers need separate gateway approach — prefer long-running Node for v1)

---

## MVP tasks

- [x] **Bootstrap** — `package.json`, tsx, discord.js, eslint, `.env.example`
- [x] **Port raid timer module** — copy or symlink `raidTimerApi.ts` (trim Electron imports)
- [x] **Poll loop** — fetch raid timer, compute alert candidates, dedupe with in-memory + optional Redis/Supabase
- [x] **Alert messages** — embed per boss; train embed with field list; role ping from config
- [x] **Slash commands** — `/setup alert-channel`, `/setup ping-role`, `/setup lead-times 5 2`, `/trains` (on-demand snapshot)
- [ ] **Live board (optional MVP+)** — pin one message per guild; edit every 60s with upcoming trains (no ping)
- [ ] **Deploy docs** — README with bot invite URL scopes (`applications.commands`, `Send Messages`, `Embed Links`, `Manage Messages` if editing pins)

---

## v2 tasks

- [ ] Supabase guild config (webhook URL **not** needed — bot token only)
- [ ] Per-boss mute / watch lists
- [ ] Link to wiki drops in embed (`wiki_id` on `boss_schedules` if added)
- [ ] Scheduled bosses (Neptunemon etc.) from `boss_schedules` table

---

## Discord embed sketch

**Train alert (with ping):**

```
content: <@&RAID_ROLE_ID>
embed:
  title: Boss train (3 spawns) — ~5 min
  color: 0x3ee0ff
  fields:
    - name: SukaMon · Map Name · 3:42 PM
    - name: Crowmon · …
  footer: Odyssey Calc · live
```

**Live board (no ping, edited in place):**

```
title: Raid trains — next 30 min
description: bullet list of trains + alive/ready bosses
```

---

## Security

- Bot token only on server; never in client or public repo
- Do **not** give community bot authors Supabase **service role**
- If multi-tenant config in DB: RLS per guild, admin Discord user id check on `/setup`

---

## Open questions (decide in new chat)

1. Single official Odyssey server only, or public multi-guild bot?
2. Default lead times: match companion (check `BOSS_TIMER_ALERT_*` in settings)?
3. GitHub repo: `MistGG/Odyssey-Discord-Bot`?
4. Share TS via npm workspace, git submodule, or copy-paste for v1?

---

## Acceptance criteria (MVP done)

- Bot joins guild, `/setup` stores channel + role in env or JSON
- When a train enters 5m window, **one** ping + embed (no duplicate spam within same spawn cycle)
- `/trains` shows current API state with train grouping
- Runs 24h without duplicate alerts for the same `trainNotifyKey`
