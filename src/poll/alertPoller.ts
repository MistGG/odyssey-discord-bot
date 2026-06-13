import type { Client, TextChannel } from 'discord.js'
import { BossAlertEngine } from '../lib/bossTimerAlerts.js'
import { fetchRaidTimer, toAlertSnapshots } from '../lib/raidTimerApi.js'
import {
  fetchLatestPatchNoteMeta,
  fetchPatchNoteDetail,
} from '../lib/patchNotesApi.js'
import type { EnvConfig } from '../config.js'
import type { GuildConfigManager } from '../guildConfig.js'
import { buildTrainAlertEmbed, rolePingContent } from '../discord/embeds.js'
import { buildPatchNoteEmbed } from '../discord/patchNotesEmbed.js'

export class AlertPoller {
  private readonly engines = new Map<string, BossAlertEngine>()
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(
    private readonly client: Client,
    private readonly env: EnvConfig,
    private readonly guildConfig: GuildConfigManager,
  ) {}

  start(): void {
    if (this.timer) return
    void this.pollOnce()
    this.timer = setInterval(() => void this.pollOnce(), this.env.pollMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private engineFor(guildId: string): BossAlertEngine {
    let engine = this.engines.get(guildId)
    if (!engine) {
      engine = new BossAlertEngine()
      this.engines.set(guildId, engine)
    }
    return engine
  }

  private guildsToNotify(): string[] {
    const ids = new Set(this.guildConfig.allConfiguredGuildIds())
    for (const [guildId] of this.client.guilds.cache) {
      if (this.guildConfig.get(guildId).alertChannelId) {
        ids.add(guildId)
      }
    }
    return [...ids]
  }

  private guildsForPatchNotes(): string[] {
    const ids = new Set(this.guildConfig.allPatchNotesGuildIds())
    for (const [guildId] of this.client.guilds.cache) {
      if (this.guildConfig.get(guildId).patchNotesChannelId) {
        ids.add(guildId)
      }
    }
    return [...ids]
  }

  private async pollOnce(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await Promise.all([this.pollRaidAlerts(), this.pollPatchNotes()])
    } finally {
      this.polling = false
    }
  }

  private async pollRaidAlerts(): Promise<void> {
    try {
      const data = await fetchRaidTimer()
      const snapshots = toAlertSnapshots(data.bosses)

      for (const guildId of this.guildsToNotify()) {
        const engine = this.engineFor(guildId)
        engine.setSnapshots(snapshots)
        await this.notifyGuild(guildId, engine)
      }
    } catch (err) {
      console.error('[poll] raid timer fetch failed:', err)
    }
  }

  private async pollPatchNotes(): Promise<void> {
    const guildIds = this.guildsForPatchNotes()
    if (guildIds.length === 0) return

    try {
      const latest = await fetchLatestPatchNoteMeta()
      if (!latest) return

      const pendingGuildIds = guildIds.filter((guildId) => {
        const cfg = this.guildConfig.get(guildId)
        return cfg.patchNotesChannelId && cfg.lastPostedPatchNoteId !== latest.id
      })
      if (pendingGuildIds.length === 0) return

      const note = await fetchPatchNoteDetail(latest.url)

      for (const guildId of pendingGuildIds) {
        const cfg = this.guildConfig.get(guildId)
        if (!cfg.patchNotesChannelId) continue

        const channel = await this.resolveChannel(guildId, cfg.patchNotesChannelId)
        if (!channel) continue

        try {
          await channel.send({ embeds: [buildPatchNoteEmbed(note)] })
          this.guildConfig.setLastPostedPatchNoteId(guildId, latest.id)
        } catch (err) {
          console.error(`[poll] failed to post patch notes in guild ${guildId}:`, err)
        }
      }
    } catch (err) {
      console.error('[poll] patch notes fetch failed:', err)
    }
  }

  private async notifyGuild(guildId: string, engine: BossAlertEngine): Promise<void> {
    const cfg = this.guildConfig.get(guildId)
    if (!cfg.alertChannelId) return

    const candidates = engine.tick(cfg.leadMinutes)
    if (candidates.length === 0) return

    const channel = await this.resolveChannel(guildId, cfg.alertChannelId)
    if (!channel) return

    for (const candidate of candidates) {
      try {
        await channel.send({
          content: rolePingContent(cfg.pingRoleId),
          embeds: [buildTrainAlertEmbed(candidate)],
          allowedMentions: cfg.pingRoleId ? { roles: [cfg.pingRoleId] } : { parse: [] },
        })
      } catch (err) {
        console.error(`[poll] failed to send alert in guild ${guildId}:`, err)
      }
    }
  }

  private async resolveChannel(
    guildId: string,
    channelId: string,
  ): Promise<TextChannel | null> {
    const cached = this.client.channels.cache.get(channelId)
    if (cached?.isTextBased() && !cached.isDMBased()) {
      return cached as TextChannel
    }

    try {
      const fetched = await this.client.channels.fetch(channelId)
      if (fetched?.isTextBased() && !fetched.isDMBased()) {
        return fetched as TextChannel
      }
    } catch {
      console.error(`[poll] could not fetch channel ${channelId} for guild ${guildId}`)
    }
    return null
  }
}
