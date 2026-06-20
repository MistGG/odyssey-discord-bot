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
