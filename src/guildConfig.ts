import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EnvConfig } from './config.js'

export type GuildConfig = {
  alertChannelId: string | null
  pingRoleId: string | null
  leadMinutes: number[]
  patchNotesChannelId: string | null
  lastPostedPatchNoteId: string | null
}

type GuildConfigStore = Record<string, Partial<GuildConfig>>

function emptyGuildConfig(env: EnvConfig): GuildConfig {
  return {
    alertChannelId: env.defaultAlertChannelId,
    pingRoleId: env.defaultPingRoleId,
    leadMinutes: [...env.alertLeadMinutes],
    patchNotesChannelId: env.defaultPatchNotesChannelId,
    lastPostedPatchNoteId: null,
  }
}

function normalizeLeadMinutes(raw: unknown, fallback: number[]): number[] {
  if (!Array.isArray(raw)) return [...fallback]
  const parsed = raw
    .map((v) => Math.round(Number(v)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 120)
  return parsed.length > 0 ? [...new Set(parsed)].sort((a, b) => b - a) : [...fallback]
}

export class GuildConfigManager {
  private store: GuildConfigStore = {}

  constructor(private readonly env: EnvConfig) {
    this.migrateLegacyConfigPath()
    this.load()
  }

  /** Older builds stored config in ~/data instead of <project>/data. */
  private migrateLegacyConfigPath(): void {
    const newPath = this.env.guildConfigPath
    if (existsSync(newPath)) return
    const legacyPath = join(dirname(newPath), '..', '..', 'data', 'guild-config.json')
    try {
      if (existsSync(legacyPath)) {
        copyFileSync(legacyPath, newPath)
      }
    } catch {
      // Best effort — fresh setup still works.
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.env.guildConfigPath, 'utf8')
      this.store = JSON.parse(raw) as GuildConfigStore
    } catch {
      this.store = {}
    }
  }

  private persist(): void {
    writeFileSync(this.env.guildConfigPath, JSON.stringify(this.store, null, 2), 'utf8')
  }

  get(guildId: string): GuildConfig {
    const saved = this.store[guildId]
    const base = emptyGuildConfig(this.env)
    if (!saved) return base
    return {
      alertChannelId: saved.alertChannelId ?? base.alertChannelId,
      pingRoleId: saved.pingRoleId ?? base.pingRoleId,
      leadMinutes: normalizeLeadMinutes(saved.leadMinutes, base.leadMinutes),
      patchNotesChannelId: saved.patchNotesChannelId ?? base.patchNotesChannelId,
      lastPostedPatchNoteId: saved.lastPostedPatchNoteId ?? null,
    }
  }

  private ensureStored(guildId: string): GuildConfig {
    const current = this.get(guildId)
    this.store[guildId] = current
    return current
  }

  setAlertChannel(guildId: string, channelId: string): GuildConfig {
    const current = this.ensureStored(guildId)
    current.alertChannelId = channelId
    this.persist()
    return current
  }

  setPingRole(guildId: string, roleId: string | null): GuildConfig {
    const current = this.ensureStored(guildId)
    current.pingRoleId = roleId
    this.persist()
    return current
  }

  setLeadMinutes(guildId: string, leadMinutes: number[]): GuildConfig {
    const current = this.ensureStored(guildId)
    current.leadMinutes = normalizeLeadMinutes(leadMinutes, this.env.alertLeadMinutes)
    this.persist()
    return current
  }

  setPatchNotesChannel(guildId: string, channelId: string): GuildConfig {
    const current = this.ensureStored(guildId)
    current.patchNotesChannelId = channelId
    this.persist()
    return current
  }

  setLastPostedPatchNoteId(guildId: string, patchNoteId: string | null): GuildConfig {
    const current = this.ensureStored(guildId)
    current.lastPostedPatchNoteId = patchNoteId
    this.persist()
    return current
  }

  allConfiguredGuildIds(): string[] {
    return Object.keys(this.store).filter((id) => {
      const cfg = this.get(id)
      return Boolean(cfg.alertChannelId)
    })
  }

  allPatchNotesGuildIds(): string[] {
    const ids = new Set<string>()
    for (const guildId of Object.keys(this.store)) {
      if (this.get(guildId).patchNotesChannelId) ids.add(guildId)
    }
    return [...ids]
  }
}
