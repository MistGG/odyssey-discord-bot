import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = join(__dirname, '..', '..')

export type EnvConfig = {
  token: string
  clientId: string
  devGuildId: string | null
  defaultAlertChannelId: string | null
  defaultPingRoleId: string | null
  defaultPatchNotesChannelId: string | null
  alertLeadMinutes: number[]
  pollMs: number
  activeTrainPollMs: number
  patchNotesPollMs: number
  guildConfigPath: string
}

function parseLeadMinutes(raw: string | undefined): number[] {
  if (!raw?.trim()) return [5]
  const parsed = raw
    .split(',')
    .map((s) => Math.round(Number(s.trim())))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 120)
  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => b - a) : [5]
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export function loadEnvConfig(): EnvConfig {
  const pollRaw = Number(process.env.RAID_POLL_MS)
  const pollMs = Number.isFinite(pollRaw) && pollRaw >= 15_000 ? pollRaw : 60_000
  const patchNotesPollRaw = Number(process.env.PATCH_NOTES_POLL_MS)
  const patchNotesPollMs =
    Number.isFinite(patchNotesPollRaw) && patchNotesPollRaw >= 60_000 ? patchNotesPollRaw : 300_000
  const activeTrainPollRaw = Number(process.env.ACTIVE_TRAIN_POLL_MS)
  const activeTrainPollMs =
    Number.isFinite(activeTrainPollRaw) && activeTrainPollRaw >= 5_000 ? activeTrainPollRaw : 10_000
  const guildConfigPath = join(rootDir, 'data', 'guild-config.json')

  mkdirSync(dirname(guildConfigPath), { recursive: true })

  return {
    token: requireEnv('DISCORD_BOT_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    devGuildId: process.env.DISCORD_DEV_GUILD_ID?.trim() || null,
    defaultAlertChannelId: process.env.DISCORD_ALERT_CHANNEL_ID?.trim() || null,
    defaultPingRoleId: process.env.DISCORD_PING_ROLE_ID?.trim() || null,
    defaultPatchNotesChannelId: process.env.DISCORD_PATCH_NOTES_CHANNEL_ID?.trim() || null,
    alertLeadMinutes: parseLeadMinutes(process.env.ALERT_LEAD_MINUTES),
    pollMs,
    activeTrainPollMs,
    patchNotesPollMs,
    guildConfigPath,
  }
}
