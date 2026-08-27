import type { Client, TextChannel } from 'discord.js'
import { BossAlertEngine, trainNotifyKey, type BossAlertCandidate } from '../lib/bossTimerAlerts.js'
import {
  bossesForTrainLane,
  fetchRaidTimer,
  groupAlertSnapshotsForNotify,
  hasActiveRaidTrain,
  isBossAlive,
  isBossReady,
  isBossSlain,
  bossTrainSpawnMs,
  nextSpawnUtcMs,
  partitionTrainLanes,
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
import { sendPatchNoteMessages } from '../discord/patchNotesEmbed.js'
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
    return this.trainAlerts.hasAny()
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
    const maxLeadMs = Math.max(...leadMinutes, 5) * 60_000
    for (const lane of partitionTrainLanes(bosses)) {
      const trains = groupAlertSnapshotsForNotify(toAlertSnapshots(lane.bosses), Date.now())
      if (trains.length === 0) continue

      const train = trains[0]!
      const respawning = train.filter((b) => b.status === 'respawning')
      if (respawning.length === 0) continue

      const anchorMs = Math.min(...respawning.map((b) => b.nextSpawnUtcMs))
      const remaining = anchorMs - Date.now()
      if (remaining > 0 && remaining <= maxLeadMs + 60_000) return true
    }
    return false
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

  private engineFor(guildId: string, laneKey: string): BossAlertEngine {
    const key = `${guildId}:${laneKey}`
    let engine = this.engines.get(key)
    if (!engine) {
      engine = new BossAlertEngine()
      this.engines.set(key, engine)
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
      const lanes = partitionTrainLanes(data.bosses)

      for (const guildId of this.guildsToNotify()) {
        const trackedKeys = new Set(this.trainAlerts.list(guildId).map((entry) => entry.laneKey))
        for (const { laneKey } of this.trainAlerts.list(guildId)) {
          const laneBosses = bossesForTrainLane(data.bosses, laneKey)
          const engine = this.engineFor(guildId, laneKey)
          engine.setSnapshots(toAlertSnapshots(laneBosses))
          await this.refreshTrainAlertMessage(guildId, laneKey, engine, laneBosses, data.serverOffsetMs)
        }

        for (const lane of lanes) {
          const engine = this.engineFor(guildId, lane.key)
          engine.setSnapshots(toAlertSnapshots(lane.bosses))
          if (!trackedKeys.has(lane.key)) {
            this.maybeFinishCycleWithoutMessage(guildId, lane.key, engine, lane.bosses, data.serverOffsetMs)
          }
          await this.notifyGuild(guildId, lane.key, engine, lane.bosses, data.serverOffsetMs)
        }
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
          await sendPatchNoteMessages(channel, note)
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
        respawnSec: boss.respawn_sec,
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
    laneKey: string,
    engine: BossAlertEngine,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): void {
    if (this.trainAlerts.get(guildId, laneKey)) return

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
    laneKey: string,
    engine: BossAlertEngine,
    channel: TextChannel,
    messageId: string,
  ): Promise<void> {
    await channel.messages.fetch(messageId).then((m) => m.delete()).catch(() => {})
    this.trainAlerts.remove(guildId, laneKey)
    engine.resetCycle()
  }

  private async refreshTrainAlertMessage(
    guildId: string,
    laneKey: string,
    engine: BossAlertEngine,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): Promise<void> {
    const alert = this.trainAlerts.get(guildId, laneKey)
    if (!alert) return

    try {
      const channel = await this.resolveChannel(guildId, alert.channelId)
      if (!channel) {
        this.trainAlerts.remove(guildId, laneKey)
        return
      }

      const message = await channel.messages.fetch(alert.messageId).catch(() => null)
      if (!message) {
        // User deleted the message — do not re-ping this cycle; reset when the wave ends.
        this.trainAlerts.remove(guildId, laneKey)
        return
      }

      const progress = this.updateCycleProgress(alert, bosses, serverOffsetMs)
      const updated: TrackedTrainAlert = {
        ...alert,
        defeatedNames: [...progress.defeatedNames],
        seenAliveNames: [...progress.seenAliveNames],
      }
      this.trainAlerts.update(guildId, laneKey, {
        defeatedNames: updated.defeatedNames,
        seenAliveNames: updated.seenAliveNames,
      })

      if (this.isTrainCleared(updated)) {
        await this.finishTrainAlert(guildId, laneKey, engine, channel, alert.messageId)
        return
      }

      const liveTrain = this.resolveLiveTrain(updated.rosterNames, bosses)
      if (liveTrain.length === 0) return

      const candidate: BossAlertCandidate = {
        train: liveTrain,
        leadMin: updated.leadMin,
        notifyKey: updated.notifyKey,
        copy: updated.copy,
        cycleAnchorMs: updated.cycleAnchorMs,
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
        this.trainAlerts.remove(guildId, laneKey)
      } else {
        console.error(`[poll] failed to refresh train alert ${alert.messageId}:`, err)
      }
    }
  }

  private async notifyGuild(
    guildId: string,
    laneKey: string,
    engine: BossAlertEngine,
    bosses: RaidBossEntry[],
    serverOffsetMs: number,
  ): Promise<void> {
    const cfg = this.guildConfig.get(guildId)
    if (!cfg.alertChannelId) return
    if (this.trainAlerts.get(guildId, laneKey)) return

    const channel = await this.resolveChannel(guildId, cfg.alertChannelId)
    if (!channel) return

    const leadMin = cfg.leadMinutes[0] ?? 5

    if (!hasActiveRaidTrain(bosses, serverOffsetMs)) {
      const candidates = engine.tick(cfg.leadMinutes)
      for (const candidate of candidates) {
        if (engine.hasNotified(candidate.leadMin, candidate.notifyKey)) continue
        await this.sendTrainAlert(guildId, laneKey, engine, channel, cfg, candidate, true)
      }
      return
    }

    const catchUp = engine.buildActiveTrainCatchUp()
    if (!catchUp) return

    const anchorMs = TrainAlertTracker.cycleAnchorMs(catchUp)
    const prePingKey = trainNotifyKey(anchorMs, leadMin)
    const withPing = !engine.hasNotified(leadMin, prePingKey)
    await this.sendTrainAlert(guildId, laneKey, engine, channel, cfg, catchUp, withPing, leadMin, prePingKey)
  }

  private async sendTrainAlert(
    guildId: string,
    laneKey: string,
    engine: BossAlertEngine,
    channel: TextChannel,
    cfg: ReturnType<GuildConfigManager['get']>,
    candidate: BossAlertCandidate,
    withPing: boolean,
    prePingLeadMin?: number,
    prePingKey?: string,
  ): Promise<void> {
    try {
      const sent = await channel.send({
        content: withPing ? rolePingContent(cfg.pingRoleId) : undefined,
        embeds: [buildTrainAlertEmbed(candidate)],
        allowedMentions:
          withPing && cfg.pingRoleId ? { roles: [cfg.pingRoleId] } : { parse: [] },
      })
      engine.markNotified(candidate.leadMin, candidate.notifyKey)
      if (prePingKey != null && prePingLeadMin != null && withPing) {
        engine.markNotified(prePingLeadMin, prePingKey)
      }
      this.trainAlerts.track(
        guildId,
        laneKey,
        TrainAlertTracker.fromCandidate(channel.id, sent.id, candidate),
      )
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? (err as { code: number }).code
          : null
      if (code === 50013) {
        console.error(
          `[poll] missing permissions to send train alert in guild ${guildId} — grant Send Messages, Embed Links, and Mention Roles in the alert channel`,
        )
      } else {
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
