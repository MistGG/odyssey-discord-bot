import {
  BOSS_TRAIN_WINDOW_MS,
  groupAlertSnapshotsForNotify,
  type RaidBossAlertSnapshot,
} from './raidTimerApi.js'

/** Must match poll interval order of magnitude for cold-start detection. */
export const BOSS_TIMER_ALERT_TICK_MS = 15_000

/** Stable key for one train spawn cycle — minute bucket absorbs raid-timer API jitter. */
export function trainNotifyKey(train: RaidBossAlertSnapshot[], leadMin: number): string {
  const first = train[0]!
  const spawnBucket = Math.floor(first.nextSpawnUtcMs / 60_000)
  const roster = train
    .map((b) => b.monsterName)
    .sort()
    .join('|')
  return `${spawnBucket}:${roster}:${leadMin}`
}

export function relaxedBossCopy(
  boss: RaidBossAlertSnapshot,
  minsApprox: number,
): { title: string; body: string } {
  const place = boss.mapName?.trim() || 'world boss location'
  return {
    title: boss.monsterName,
    body: `About ${minsApprox} min until the next window. ${place}.`,
  }
}

export function relaxedTrainCopy(
  train: RaidBossAlertSnapshot[],
  minsApprox: number,
): { title: string; body: string } {
  if (train.length === 1) return relaxedBossCopy(train[0]!, minsApprox)

  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  const lines = train.map((boss) => {
    const place = boss.mapName?.trim() || 'world boss location'
    const time = timeFmt.format(new Date(boss.nextSpawnUtcMs))
    return `• ${boss.monsterName} — ${place} (${time})`
  })

  return {
    title: `Boss train (${train.length} spawns)`,
    body: `About ${minsApprox} min until the train starts.\n${lines.join('\n')}`,
  }
}

export type BossAlertCandidate = {
  train: RaidBossAlertSnapshot[]
  leadMin: number
  notifyKey: string
  copy: { title: string; body: string }
}

type LeadState = {
  notifiedKeys: Set<string>
  lastFirstRemainingMs: Map<string, number>
}

/**
 * Pre-spawn alerts for bosses in `respawning` state (raid timer API).
 * Trains share one alert when the first boss crosses into a lead window (~N min before spawn).
 */
export class BossAlertEngine {
  private activeBossAlerts: RaidBossAlertSnapshot[] = []
  private readonly leadStates = new Map<number, LeadState>()

  setSnapshots(snapshots: RaidBossAlertSnapshot[]): void {
    this.activeBossAlerts = snapshots
  }

  private leadState(leadMin: number): LeadState {
    let state = this.leadStates.get(leadMin)
    if (!state) {
      state = { notifiedKeys: new Set(), lastFirstRemainingMs: new Map() }
      this.leadStates.set(leadMin, state)
    }
    return state
  }

  tick(leadMinutes: number[], now = Date.now()): BossAlertCandidate[] {
    const normalized = leadMinutes
      .map((m) => Math.min(120, Math.max(1, Math.round(m))))
      .filter((m, i, arr) => arr.indexOf(m) === i)
      .sort((a, b) => b - a)

    const respawning = this.activeBossAlerts.filter((boss) => boss.status === 'respawning')
    const trains = groupAlertSnapshotsForNotify(respawning, now)
    const candidates: BossAlertCandidate[] = []

    for (const leadMin of normalized) {
      const leadMs = leadMin * 60_000
      const state = this.leadState(leadMin)

      for (const train of trains) {
        const first = train[0]!
        const firstRemaining = first.nextSpawnUtcMs - now
        const notifyKey = trainNotifyKey(train, leadMin)
        const prevRemaining = state.lastFirstRemainingMs.get(notifyKey)

        if (firstRemaining <= 0) {
          state.notifiedKeys.delete(notifyKey)
          state.lastFirstRemainingMs.delete(notifyKey)
          continue
        }

        if (firstRemaining > leadMs) {
          state.notifiedKeys.delete(notifyKey)
          state.lastFirstRemainingMs.set(notifyKey, firstRemaining)
          continue
        }

        state.lastFirstRemainingMs.set(notifyKey, firstRemaining)

        const crossedIntoLead =
          prevRemaining != null && prevRemaining > leadMs && firstRemaining <= leadMs
        const coldStartNearLead =
          prevRemaining == null &&
          firstRemaining <= leadMs &&
          firstRemaining >= leadMs - BOSS_TIMER_ALERT_TICK_MS * 2

        if (!crossedIntoLead && !coldStartNearLead) {
          continue
        }

        if (state.notifiedKeys.has(notifyKey)) {
          continue
        }
        state.notifiedKeys.add(notifyKey)

        candidates.push({
          train,
          leadMin,
          notifyKey,
          copy: relaxedTrainCopy(train, leadMin),
        })
      }
    }

    return candidates
  }
}

export { BOSS_TRAIN_WINDOW_MS, groupAlertSnapshotsForNotify }
