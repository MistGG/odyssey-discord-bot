import {
  BOSS_TRAIN_WINDOW_MS,
  buildUnifiedAlertTrain,
  groupAlertSnapshotsForNotify,
  type RaidBossAlertSnapshot,
} from './raidTimerApi.js'

/** Must match poll interval order of magnitude for cold-start detection. */
export const BOSS_TIMER_ALERT_TICK_MS = 15_000

/** Stable key for one train spawn cycle — anchored to first spawn, not roster. */
export function trainNotifyKey(anchorSpawnUtcMs: number, leadMin: number): string {
  const spawnBucket = Math.floor(anchorSpawnUtcMs / 60_000)
  return `${spawnBucket}:train:${leadMin}`
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

function formatBossLine(boss: RaidBossAlertSnapshot): string {
  const place = boss.mapName?.trim() || 'world boss location'
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  if (boss.status === 'alive') return `• ${boss.monsterName} · ${place} (alive)`
  if (boss.status === 'ready') return `• ${boss.monsterName} · ${place} (ready)`
  const time = timeFmt.format(new Date(boss.nextSpawnUtcMs))
  return `• ${boss.monsterName} · ${place} (${time})`
}

export function activeTrainCopy(
  train: RaidBossAlertSnapshot[],
): { title: string; body: string } {
  if (train.length === 1) {
    const boss = train[0]!
    const place = boss.mapName?.trim() || 'world boss location'
    return {
      title: boss.monsterName,
      body: `**${boss.monsterName}** is up at ${place}.`,
    }
  }

  const lines = train.map((boss) => formatBossLine(boss))
  return {
    title: `Boss train (${train.length} spawns)`,
    body: `Train in progress.\n${lines.join('\n')}`,
  }
}

export function relaxedTrainCopy(
  train: RaidBossAlertSnapshot[],
  minsApprox: number,
): { title: string; body: string } {
  if (train.length === 1) return relaxedBossCopy(train[0]!, minsApprox)

  const lines = train.map((boss) => formatBossLine(boss))

  return {
    title: `Boss train (${train.length} spawns)`,
    body: `About ${minsApprox} min until the train starts.\n${lines.join('\n')}`,
  }
}

/** Notify key for a train already in progress (bot restart / missed pre-ping). */
export function activeTrainNotifyKey(anchorSpawnUtcMs: number): string {
  return `active:${trainNotifyKey(anchorSpawnUtcMs, 0)}`
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
 * One ping per lead time for the whole train (stable cycle anchor).
 */
export class BossAlertEngine {
  private activeBossAlerts: RaidBossAlertSnapshot[] = []
  private readonly leadStates = new Map<number, LeadState>()
  private trainCycleAnchorMs: number | null = null

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

  private resetCycleIfComplete(train: RaidBossAlertSnapshot[]): void {
    const respawning = train.filter((b) => b.status === 'respawning')
    if (respawning.length > 0) return

    this.trainCycleAnchorMs = null
    for (const state of this.leadStates.values()) {
      state.notifiedKeys.clear()
      state.lastFirstRemainingMs.clear()
    }
  }

  private syncCycleAnchor(train: RaidBossAlertSnapshot[]): number | null {
    const respawning = train.filter((b) => b.status === 'respawning')
    if (respawning.length === 0) return null

    if (this.trainCycleAnchorMs == null) {
      this.trainCycleAnchorMs = Math.min(...respawning.map((b) => b.nextSpawnUtcMs))
    }

    return this.trainCycleAnchorMs
  }

  tick(leadMinutes: number[], now = Date.now()): BossAlertCandidate[] {
    const normalized = leadMinutes
      .map((m) => Math.min(120, Math.max(1, Math.round(m))))
      .filter((m, i, arr) => arr.indexOf(m) === i)
      .sort((a, b) => b - a)

    const trains = groupAlertSnapshotsForNotify(this.activeBossAlerts, now)
    if (trains.length === 0) {
      this.resetCycleIfComplete(buildUnifiedAlertTrain(this.activeBossAlerts, now))
      return []
    }

    const train = trains[0]!
    const trainAlreadyStarted = train.some(
      (b) => b.status === 'alive' || b.status === 'ready',
    )
    this.resetCycleIfComplete(train)

    const anchorMs = this.syncCycleAnchor(train)
    if (anchorMs == null) return []

    const firstRemaining = anchorMs - now
    const candidates: BossAlertCandidate[] = []

    for (const leadMin of normalized) {
      const leadMs = leadMin * 60_000
      const state = this.leadState(leadMin)
      const notifyKey = trainNotifyKey(anchorMs, leadMin)
      const prevRemaining = state.lastFirstRemainingMs.get(notifyKey)

      if (firstRemaining <= 0) {
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
      const coldStartInLeadWindow =
        prevRemaining == null &&
        !trainAlreadyStarted &&
        firstRemaining > 0 &&
        firstRemaining <= leadMs

      if (!crossedIntoLead && !coldStartInLeadWindow) {
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

    return candidates
  }

  /** Post once when a train is already active and no pre-spawn ping went out this cycle. */
  tickActiveTrain(now = Date.now()): BossAlertCandidate | null {
    const train = buildUnifiedAlertTrain(this.activeBossAlerts, now)
    if (!train.some((b) => b.status === 'alive' || b.status === 'ready')) {
      return null
    }

    const anchorMs =
      this.trainCycleAnchorMs ?? Math.min(...train.map((b) => b.nextSpawnUtcMs))
    const notifyKey = activeTrainNotifyKey(anchorMs)
    const state = this.leadState(0)

    if (state.notifiedKeys.has(notifyKey)) {
      return null
    }

    for (const [leadMin, leadState] of this.leadStates) {
      if (leadMin === 0) continue
      if (leadState.notifiedKeys.has(trainNotifyKey(anchorMs, leadMin))) {
        return null
      }
    }

    state.notifiedKeys.add(notifyKey)

    return {
      train,
      leadMin: 0,
      notifyKey,
      copy: activeTrainCopy(train),
    }
  }
}

export { BOSS_TRAIN_WINDOW_MS, groupAlertSnapshotsForNotify }
