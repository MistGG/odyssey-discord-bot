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
  private readonly byGuild = new Map<string, TrackedTrainAlert>()

  track(guildId: string, alert: TrackedTrainAlert): void {
    this.byGuild.set(guildId, alert)
  }

  get(guildId: string): TrackedTrainAlert | null {
    return this.byGuild.get(guildId) ?? null
  }

  list(guildId: string): TrackedTrainAlert[] {
    const alert = this.byGuild.get(guildId)
    return alert ? [alert] : []
  }

  update(guildId: string, patch: Partial<TrackedTrainAlert>): void {
    const current = this.byGuild.get(guildId)
    if (!current) return
    this.byGuild.set(guildId, { ...current, ...patch })
  }

  remove(guildId: string): void {
    this.byGuild.delete(guildId)
  }

  static cycleAnchorMs(candidate: BossAlertCandidate): number {
    const respawning = candidate.train.filter((b) => b.status === 'respawning')
    if (respawning.length > 0) {
      return Math.min(...respawning.map((b) => b.nextSpawnUtcMs))
    }
    return Math.min(...candidate.train.map((b) => b.nextSpawnUtcMs))
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
      cycleAnchorMs: TrainAlertTracker.cycleAnchorMs(candidate),
      leadMin: candidate.leadMin,
      notifyKey: candidate.notifyKey,
      copy: candidate.copy,
      defeatedNames: [],
      seenAliveNames: [],
    }
  }
}
