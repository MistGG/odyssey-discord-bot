import type { BossAlertCandidate } from '../lib/bossTimerAlerts.js'

export type TrackedTrainAlert = {
  channelId: string
  messageId: string
  rosterNames: string[]
  leadMin: number
  notifyKey: string
  copy: { title: string; body: string }
}

export class TrainAlertTracker {
  private readonly byGuild = new Map<string, TrackedTrainAlert[]>()

  track(guildId: string, alert: TrackedTrainAlert): void {
    const list = this.byGuild.get(guildId) ?? []
    list.push(alert)
    this.byGuild.set(guildId, list)
  }

  list(guildId: string): TrackedTrainAlert[] {
    return this.byGuild.get(guildId) ?? []
  }

  remove(guildId: string, messageId: string): void {
    const list = this.byGuild.get(guildId)
    if (!list) return
    const next = list.filter((a) => a.messageId !== messageId)
    if (next.length === 0) this.byGuild.delete(guildId)
    else this.byGuild.set(guildId, next)
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
      leadMin: candidate.leadMin,
      notifyKey: candidate.notifyKey,
      copy: candidate.copy,
    }
  }
}
