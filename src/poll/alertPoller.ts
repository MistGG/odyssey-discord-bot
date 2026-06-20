import type { Client, TextChannel } from 'discord.js'
import { BossAlertEngine, type BossAlertCandidate } from '../lib/bossTimerAlerts.js'
import {
  fetchRaidTimer,
  groupAlertSnapshotsForNotify,
  hasActiveRaidTrain,
  isBossAlive,
  isBossReady,
  isBossSlain,
  bossTrainSpawnMs,
  nextSpawnUtcMs,
  serverNowMs,
  toAlertSnapshots,
  TRAIN_WAVE_TAIL_MS,
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
import { TrainAlertTracker, type TrackedTrainAlert } from './trainAlertTracker.js'

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

  private hasTrackedTrainAlert(): boolean {
    for (const guildId of this.guildsToNotify()) {
      if (this.trainAlerts.get(guildId)) return true
    }
    return false
  }

  private shouldPollRaidFast(bosses: RaidBossEntry[], serverOffsetMs: number): boolean {
    if (hasActiveRaidTrain(bosses, serverOffsetMs)) return true
    if (this.hasTrackedTrainAlert()) return true
    for (const guildId of this.guildsToNotify()) {
      const leadMinutes = this.guildConfig.get(guildId).leadMinutes
      if (this.isWithinLeadWindow(bosses, leadMinutes)) return true
    }
    return false
  }

  private isWithinLeadWindow(bosses: RaidBossEntry[], leadMinutes: number[]): boolean {
    const snapshots = toAlertSnapshots(bosses)
    const trains = groupAlertSnapshotsForNotify(snapshots, Date.now())
    if (trains.length === 0) return false

    const train = trains[0]!
    const respawning = train.filter((b) => b.status === 'respawning')
    if (respawning.length === 0) return false

    const anchorMs = Math.min(...respawning.map((b) => b.nextSpawnUtcMs))
    const maxLeadMs = Math.max(...leadMinutes, 5) * 60_000
    const remaining = anchorMs - Date.now()
    return remaining > 0 && remaining <= maxLeadMs + 60_000
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
        await this.refreshTrainAlertMessage(guildId, engine, data.bosses, data.serverOffsetMs)
        this.maybeFinishCycleWithoutMessage(guildId, engine, data.bosses, data.serverOffsetMs)
        await this.notifyGuild(guildId, engine, data.bosses, data.serverOffsetMs)
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

  /** Update sticky defeated/seen-alive state for the current train cycle only. */
  private updateCycleProgress(
    alert: TrackedTrainAlert,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): { defeatedNames: Set<string>; seenAliveNames: Set<string> } {
    const defeated = new Set(alert.defeatedNames)
    const seenAlive = new Set(alert.seenAliveNames)
    const nowMs = serverNowMs(serverOffsetMs)

    const trainHasStarted =
      nowMs >= alert.cycleAnchorMs ||
      alert.rosterNames.some((name) => {
        const boss = bosses.find((b) => b.monster_name === name)
        return boss != null && (isBossAlive(boss) || isBossReady(boss))
      }) ||
      seenAlive.size > 0

    for (const name of alert.rosterNames) {
      if (defeated.has(name)) continue

      const boss = bosses.find((b) => b.monster_name === name)
      if (!boss) continue

      if (isBossAlive(boss) || isBossReady(boss)) {
        seenAlive.add(name)
        continue
      }

      if (seenAlive.has(name)) {
        defeated.add(name)
        continue
      }

      if (!trainHasStarted) continue

      const spawnMs = bossTrainSpawnMs(boss, nowMs)
      if (spawnMs > alert.cycleAnchorMs + TRAIN_WAVE_TAIL_MS) continue

      if (isBossSlain(boss, serverOffsetMs, bosses) && nowMs >= spawnMs) {
        defeated.add(name)
      }
    }

    return { defeatedNames: defeated, seenAliveNames: seenAlive }
  }

  private isTrainCleared(alert: TrackedTrainAlert): boolean {
    return alert.rosterNames.every((name) => alert.defeatedNames.includes(name))
  }

  private maybeFinishCycleWithoutMessage(
    guildId: string,
    engine: BossAlertEngine,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): void {
    if (this.trainAlerts.get(guildId)) return

    const anchorMs = engine.getCycleAnchorMs()
    if (anchorMs == null) return

    const nowMs = serverNowMs(serverOffsetMs)
    const waveEndMs = anchorMs + TRAIN_WAVE_TAIL_MS

    if (hasActiveRaidTrain(bosses, serverOffsetMs)) return
    if (nowMs < waveEndMs) return

    engine.resetCycle()
  }

  private async finishTrainAlert(
    guildId: string,
    engine: BossAlertEngine,
    channel: TextChannel,
    messageId: string,
  ): Promise<void> {
    await channel.messages.fetch(messageId).then((m) => m.delete()).catch(() => {})
    this.trainAlerts.remove(guildId)
    engine.resetCycle()
  }

  private async refreshTrainAlertMessage(
    guildId: string,
    engine: BossAlertEngine,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): Promise<void> {
    const alert = this.trainAlerts.get(guildId)
    if (!alert) return

    try {
      const channel = await this.resolveChannel(guildId, alert.channelId)
      if (!channel) {
        this.trainAlerts.remove(guildId)
        return
      }

      const message = await channel.messages.fetch(alert.messageId).catch(() => null)
      if (!message) {
        // User deleted the message — do not re-ping this cycle; reset when the wave ends.
        this.trainAlerts.remove(guildId)
        return
      }

      const progress = this.updateCycleProgress(alert, bosses, serverOffsetMs)
      const updated: TrackedTrainAlert = {
        ...alert,
        defeatedNames: [...progress.defeatedNames],
        seenAliveNames: [...progress.seenAliveNames],
      }
      this.trainAlerts.update(guildId, {
        defeatedNames: updated.defeatedNames,
        seenAliveNames: updated.seenAliveNames,
      })

      if (this.isTrainCleared(updated)) {
        await this.finishTrainAlert(guildId, engine, channel, alert.messageId)
        return
      }

      const liveTrain = this.resolveLiveTrain(updated.rosterNames, bosses)
      if (liveTrain.length === 0) return

      const candidate: BossAlertCandidate = {
        train: liveTrain,
        leadMin: updated.leadMin,
        notifyKey: updated.notifyKey,
        copy: updated.copy,
      }

      await message.edit({
        content: null,
        embeds: [
          buildTrainAlertEmbed(candidate, {
            slainNames: progress.defeatedNames,
            liveTrain,
          }),
        ],
      })
    } catch (err) {
      if (isUnknownMessageError(err)) {
        this.trainAlerts.remove(guildId)
      } else {
        console.error(`[poll] failed to refresh train alert ${alert.messageId}:`, err)
      }
    }
  }

  private async notifyGuild(
    guildId: string,
    engine: BossAlertEngine,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): Promise<void> {
    const cfg = this.guildConfig.get(guildId)
    if (!cfg.alertChannelId) return
    if (this.trainAlerts.get(guildId)) return
    if (hasActiveRaidTrain(bosses, serverOffsetMs)) return

    const candidates = engine.tick(cfg.leadMinutes)
    if (candidates.length === 0) return

    const channel = await this.resolveChannel(guildId, cfg.alertChannelId)
    if (!channel) return

    for (const candidate of candidates) {
      if (engine.hasNotified(candidate.leadMin, candidate.notifyKey)) continue

      try {
        const sent = await channel.send({
          content: rolePingContent(cfg.pingRoleId),
          embeds: [buildTrainAlertEmbed(candidate)],
          allowedMentions: cfg.pingRoleId ? { roles: [cfg.pingRoleId] } : { parse: [] },
        })
        engine.markNotified(candidate.leadMin, candidate.notifyKey)
        this.trainAlerts.track(
          guildId,
          TrainAlertTracker.fromCandidate(channel.id, sent.id, candidate),
        )
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
