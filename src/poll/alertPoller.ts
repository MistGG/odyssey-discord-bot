import type { Client, TextChannel } from 'discord.js'
import { BossAlertEngine, type BossAlertCandidate } from '../lib/bossTimerAlerts.js'
import {
  fetchRaidTimer,
  hasActiveRaidTrain,
  isBossSlain,
  nextSpawnUtcMs,
  toAlertSnapshots,
  type RaidBossEntry,
} from '../lib/raidTimerApi.js'
import {
  fetchLatestPatchNoteMeta,
  fetchPatchNoteDetail,
} from '../lib/patchNotesApi.js'
import type { EnvConfig } from '../config.js'
import type { GuildConfigManager } from '../guildConfig.js'
import { buildTrainAlertEmbed, rolePingContent } from '../discord/embeds.js'
import { buildPatchNoteEmbed } from '../discord/patchNotesEmbed.js'
import { TrainAlertTracker } from './trainAlertTracker.js'

function isUnknownMessageError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 10008
}

export class AlertPoller {
  private readonly engines = new Map<string, BossAlertEngine>()
  private readonly trainAlerts = new TrainAlertTracker()
  private raidPollTimeout: ReturnType<typeof setTimeout> | null = null
  private patchNotesTimer: ReturnType<typeof setInterval> | null = null
  private pollingRaid = false
  private pollingPatchNotes = false
  private stopped = false
  private lastRaidData: { bosses: RaidBossEntry[]; serverOffsetMs: number } | null = null

  constructor(
    private readonly client: Client,
    private readonly env: EnvConfig,
    private readonly guildConfig: GuildConfigManager,
  ) {}

  start(): void {
    if (this.patchNotesTimer) return
    this.stopped = false
    void this.pollPatchNotes()
    void this.runRaidPollCycle()
    this.patchNotesTimer = setInterval(
      () => void this.pollPatchNotes(),
      this.env.patchNotesPollMs,
    )
  }

  stop(): void {
    this.stopped = true
    if (this.raidPollTimeout) {
      clearTimeout(this.raidPollTimeout)
      this.raidPollTimeout = null
    }
    if (this.patchNotesTimer) {
      clearInterval(this.patchNotesTimer)
      this.patchNotesTimer = null
    }
  }

  private scheduleNextRaidPoll(delayMs: number): void {
    if (this.stopped) return
    if (this.raidPollTimeout) clearTimeout(this.raidPollTimeout)
    this.raidPollTimeout = setTimeout(() => void this.runRaidPollCycle(), delayMs)
  }

  private hasTrackedTrainAlerts(): boolean {
    for (const guildId of this.guildsToNotify()) {
      if (this.trainAlerts.list(guildId).length > 0) return true
    }
    return false
  }

  private shouldPollRaidFast(bosses: RaidBossEntry[], serverOffsetMs: number): boolean {
    if (hasActiveRaidTrain(bosses, serverOffsetMs)) return true
    return this.hasTrackedTrainAlerts()
  }

  private async runRaidPollCycle(): Promise<void> {
    let nextDelay = this.env.pollMs
    try {
      await this.pollRaidAlerts()
      if (this.lastRaidData) {
        nextDelay = this.shouldPollRaidFast(this.lastRaidData.bosses, this.lastRaidData.serverOffsetMs)
          ? this.env.activeTrainPollMs
          : this.env.pollMs
      }
    } catch {
      nextDelay = this.env.pollMs
    } finally {
      this.scheduleNextRaidPoll(nextDelay)
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

  private async pollRaidAlerts(): Promise<void> {
    if (this.pollingRaid) return
    this.pollingRaid = true
    try {
      const data = await fetchRaidTimer()
      this.lastRaidData = { bosses: data.bosses, serverOffsetMs: data.serverOffsetMs }
      const snapshots = toAlertSnapshots(data.bosses)

      for (const guildId of this.guildsToNotify()) {
        const engine = this.engineFor(guildId)
        engine.setSnapshots(snapshots)
        await this.notifyGuild(guildId, engine)
        await this.refreshTrainAlertMessages(guildId, data.bosses, data.serverOffsetMs)
      }
    } catch (err) {
      console.error('[poll] raid timer fetch failed:', err)
    } finally {
      this.pollingRaid = false
    }
  }

  private async pollPatchNotes(): Promise<void> {
    if (this.pollingPatchNotes) return
    this.pollingPatchNotes = true
    try {
      const guildIds = this.guildsForPatchNotes()
      if (guildIds.length === 0) return

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
    } finally {
      this.pollingPatchNotes = false
    }
  }

  private resolveLiveTrain(
    rosterNames: string[],
    bosses: RaidBossEntry[],
  ): BossAlertCandidate['train'] {
    const train: BossAlertCandidate['train'] = []
    for (const name of rosterNames) {
      const boss = bosses.find((b) => b.monster_name === name)
      if (!boss) continue
      train.push({
        monsterName: boss.monster_name,
        mapName: boss.map_name,
        status: boss.status,
        nextSpawnUtcMs: nextSpawnUtcMs(boss),
      })
    }
    return train
  }

  private slainNamesForRoster(
    rosterNames: string[],
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): Set<string> {
    const slain = new Set<string>()
    for (const name of rosterNames) {
      const boss = bosses.find((b) => b.monster_name === name)
      if (boss && isBossSlain(boss, serverOffsetMs, bosses)) slain.add(name)
    }
    return slain
  }

  private isTrainCleared(
    rosterNames: string[],
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): boolean {
    if (rosterNames.length === 0) return true
    return rosterNames.every((name) => {
      const boss = bosses.find((b) => b.monster_name === name)
      return boss != null && isBossSlain(boss, serverOffsetMs, bosses)
    })
  }

  private async refreshTrainAlertMessages(
    guildId: string,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): Promise<void> {
    const tracked = this.trainAlerts.list(guildId)
    if (tracked.length === 0) return

    for (const alert of [...tracked]) {
      try {
        const channel = await this.resolveChannel(guildId, alert.channelId)
        if (!channel) {
          this.trainAlerts.remove(guildId, alert.messageId)
          continue
        }

        const message = await channel.messages.fetch(alert.messageId).catch(() => null)
        if (!message) {
          this.trainAlerts.remove(guildId, alert.messageId)
          continue
        }

        if (this.isTrainCleared(alert.rosterNames, bosses, serverOffsetMs)) {
          await message.delete().catch(() => {})
          this.trainAlerts.remove(guildId, alert.messageId)
          continue
        }

        const liveTrain = this.resolveLiveTrain(alert.rosterNames, bosses)
        if (liveTrain.length === 0) continue

        const slainNames = this.slainNamesForRoster(alert.rosterNames, bosses, serverOffsetMs)
        const candidate: BossAlertCandidate = {
          train: liveTrain,
          leadMin: alert.leadMin,
          notifyKey: alert.notifyKey,
          copy: alert.copy,
        }

        await message.edit({
          embeds: [buildTrainAlertEmbed(candidate, { slainNames, liveTrain })],
        })
      } catch (err) {
        if (isUnknownMessageError(err)) {
          this.trainAlerts.remove(guildId, alert.messageId)
        } else {
          console.error(`[poll] failed to refresh train alert ${alert.messageId}:`, err)
        }
      }
    }
  }

  private async notifyGuild(guildId: string, engine: BossAlertEngine): Promise<void> {
    const cfg = this.guildConfig.get(guildId)
    if (!cfg.alertChannelId) return

    const candidates = engine.tick(cfg.leadMinutes)
    const toSend =
      candidates.length > 0
        ? candidates
        : this.trainAlerts.list(guildId).length === 0
          ? (() => {
              const active = engine.tickActiveTrain()
              return active ? [active] : []
            })()
          : []
    if (toSend.length === 0) return

    const channel = await this.resolveChannel(guildId, cfg.alertChannelId)
    if (!channel) return

    for (const candidate of toSend) {
      try {
        const sent = await channel.send({
          content: rolePingContent(cfg.pingRoleId),
          embeds: [buildTrainAlertEmbed(candidate)],
          allowedMentions: cfg.pingRoleId ? { roles: [cfg.pingRoleId] } : { parse: [] },
        })
        this.trainAlerts.track(guildId, TrainAlertTracker.fromCandidate(channel.id, sent.id, candidate))
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
