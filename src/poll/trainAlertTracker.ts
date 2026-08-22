import type { BossAlertCandidate } from '../lib/bossTimerAlerts.js'

export type TrackedTrainAlert = {
  channelId: string
  messageId: string
  /** Roster locked at ping time — current train only. */
  rosterNames: string[]
  /** First spawn in this train cycle (ms). */
  cycleAnchorMs: number
  leadMin: number
  notifyKey: string
  copy: { title: string; body: string }
  /** Defeated this cycle — sticky; ignores later respawns. */
  defeatedNames: string[]
  /** Bosses seen alive/ready this cycle (for kill detection). */
  seenAliveNames: string[]
}

export class TrainAlertTracker {
  private readonly byGuild = new Map<string, Map<string, TrackedTrainAlert>>()

  track(guildId: string, laneKey: string, alert: TrackedTrainAlert): void {
    let lanes = this.byGuild.get(guildId)
    if (!lanes) {
      lanes = new Map()
      this.byGuild.set(guildId, lanes)
    }
    lanes.set(laneKey, alert)
  }

  get(guildId: string, laneKey: string): TrackedTrainAlert | null {
    return this.byGuild.get(guildId)?.get(laneKey) ?? null
  }

  list(guildId: string): { laneKey: string; alert: TrackedTrainAlert }[] {
    const lanes = this.byGuild.get(guildId)
    if (!lanes) return []
    return [...lanes.entries()].map(([laneKey, alert]) => ({ laneKey, alert }))
  }

  update(guildId: string, laneKey: string, patch: Partial<TrackedTrainAlert>): void {
    const current = this.get(guildId, laneKey)
    if (!current) return
    this.byGuild.get(guildId)!.set(laneKey, { ...current, ...patch })
  }

  remove(guildId: string, laneKey: string): void {
    const lanes = this.byGuild.get(guildId)
    if (!lanes) return
    lanes.delete(laneKey)
    if (lanes.size === 0) this.byGuild.delete(guildId)
  }

  hasAny(guildId?: string): boolean {
    if (guildId) return (this.byGuild.get(guildId)?.size ?? 0) > 0
    for (const lanes of this.byGuild.values()) {
      if (lanes.size > 0) return true
    }
    return false
  }

  static fromCandidate(
    channelId: string,
    messageId: string,
    candidate: BossAlertCandidate,
  ): TrackedTrainAlert {
    return {
      channelId,
      messageId,
      rosterNames: candidate.train.map((b) => b.monsterName),
      cycleAnchorMs: candidate.cycleAnchorMs,
      leadMin: candidate.leadMin,
      notifyKey: candidate.notifyKey,
      copy: candidate.copy,
      defeatedNames: [],
      seenAliveNames: candidate.train
        .filter((b) => b.status === 'alive' || b.status === 'ready')
        .map((b) => b.monsterName),
    }
  }

  static cycleAnchorMs(candidate: BossAlertCandidate): number {
    return candidate.cycleAnchorMs
  }
}
