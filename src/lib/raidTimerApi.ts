const RAID_TIMER_URL = 'https://thedigitalodyssey.com/api/raid-timer'

export type RaidBossStatus = 'alive' | 'ready' | 'respawning'

export type RaidBossEntry = {
  monster_id: string
  monster_name: string
  model_id: string
  level: number
  map_id: string
  map_name: string
  status: RaidBossStatus
  next_spawn_ts: number
  respawn_sec: number
  despawn_sec: number
  count: number
  cross_channel: boolean
}

export type RaidTimerResponse = {
  now: number
  live: boolean
  bosses: RaidBossEntry[]
  /** Client clock offset so countdowns match server: serverNowMs ≈ Date.now() + serverOffsetMs */
  serverOffsetMs: number
}

export function formatDurationCountdown(totalMs: number): string {
  const s = Math.ceil(Math.max(0, totalMs) / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function normalizeStatus(raw: unknown): RaidBossStatus {
  if (raw === 'alive' || raw === 'ready' || raw === 'respawning') return raw
  return 'respawning'
}

function normalizeBoss(raw: unknown): RaidBossEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const monster_id = typeof o.monster_id === 'string' ? o.monster_id.trim() : ''
  const monster_name = typeof o.monster_name === 'string' ? o.monster_name.trim() : ''
  if (!monster_id || !monster_name) return null
  const next_spawn_ts = Number(o.next_spawn_ts)
  const respawn_sec = Number(o.respawn_sec)
  const despawn_sec = Number(o.despawn_sec)
  if (!Number.isFinite(next_spawn_ts) || !Number.isFinite(respawn_sec)) return null
  return {
    monster_id,
    monster_name,
    model_id: typeof o.model_id === 'string' ? o.model_id.trim() : '',
    level: Number.isFinite(Number(o.level)) ? Math.round(Number(o.level)) : 0,
    map_id: typeof o.map_id === 'string' ? o.map_id.trim() : '',
    map_name: typeof o.map_name === 'string' ? o.map_name.trim() : '',
    status: normalizeStatus(o.status),
    next_spawn_ts: Math.round(next_spawn_ts),
    respawn_sec: Math.round(respawn_sec),
    despawn_sec: Number.isFinite(despawn_sec) ? Math.round(despawn_sec) : 0,
    count: Number.isFinite(Number(o.count)) ? Math.round(Number(o.count)) : 1,
    cross_channel: Boolean(o.cross_channel),
  }
}

export async function fetchRaidTimer(): Promise<RaidTimerResponse> {
  const res = await fetch(RAID_TIMER_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    throw new Error(`Raid timer API failed (${res.status})`)
  }
  const body = (await res.json()) as Record<string, unknown>
  const serverNowSec = Number(body.now)
  const serverOffsetMs = Number.isFinite(serverNowSec) ? serverNowSec * 1000 - Date.now() : 0
  const bossesRaw = Array.isArray(body.bosses) ? body.bosses : []
  const bosses = bossesRaw.map(normalizeBoss).filter((b): b is RaidBossEntry => b !== null)
  return {
    now: Number.isFinite(serverNowSec) ? Math.round(serverNowSec) : Math.floor(Date.now() / 1000),
    live: Boolean(body.live),
    bosses,
    serverOffsetMs,
  }
}

export function serverNowMs(serverOffsetMs: number): number {
  return Date.now() + serverOffsetMs
}

export function nextSpawnUtcMs(boss: RaidBossEntry): number {
  return boss.next_spawn_ts * 1000
}

export function msUntilSpawn(boss: RaidBossEntry, serverOffsetMs: number): number {
  return Math.max(0, nextSpawnUtcMs(boss) - serverNowMs(serverOffsetMs))
}

export function isBossAlive(boss: RaidBossEntry): boolean {
  return boss.status === 'alive'
}

export function isBossReady(boss: RaidBossEntry): boolean {
  return boss.status === 'ready'
}

/** Max gap from train lead to last boss in the same spawn wave (Neptunemon trails ~22m behind). */
export const TRAIN_WAVE_TAIL_MS = 30 * 60_000

/** Boss was killed this cycle — respawning with the next window near the full respawn cycle. */
export function isBossSlain(
  boss: RaidBossEntry,
  serverOffsetMs: number,
  allBosses?: RaidBossEntry[],
): boolean {
  if (boss.status === 'alive' || boss.status === 'ready') return false
  const until = msUntilSpawn(boss, serverOffsetMs)
  const cycleMs = Math.max(boss.respawn_sec, 60) * 1000
  // After a kill the timer resets to ~full respawn_sec; upcoming spawns are much sooner.
  if (until <= cycleMs * 0.85) return false

  if (allBosses && allBosses.length > 0) {
    const nowMs = serverNowMs(serverOffsetMs)
    const soonestSpawn = Math.min(...allBosses.map((b) => bossTrainSpawnMs(b, nowMs)))
    const bossMs = bossTrainSpawnMs(boss, nowMs)
    // Same spawn wave as the lead boss — staggered train, not a fresh-cycle kill.
    if (bossMs - soonestSpawn <= TRAIN_WAVE_TAIL_MS) return false
  }

  return true
}

export function isBossSlainSnapshot(
  boss: RaidBossAlertSnapshot,
  serverOffsetMs: number,
  allBosses?: RaidBossAlertSnapshot[],
): boolean {
  const nowMs = serverNowMs(serverOffsetMs)
  const pool = allBosses ?? [boss]
  return isBossSlainSnapshotAt(boss, pool, nowMs)
}

export function bossStatusLabel(boss: RaidBossEntry, serverOffsetMs: number): string {
  if (boss.status === 'alive') return 'Alive'
  if (boss.status === 'ready') return 'Ready'
  return formatDurationCountdown(msUntilSpawn(boss, serverOffsetMs))
}

export function formatRespawnCycleMinutes(respawnSec: number): string {
  const min = respawnSec / 60
  if (Number.isInteger(min)) return `${min} min`
  return `${Math.floor(min)}m ${Math.round((min % 1) * 60)}s`
}

/** Payload for spawn reminders. */
export type RaidBossAlertSnapshot = {
  monsterName: string
  mapName: string
  status: RaidBossStatus
  nextSpawnUtcMs: number
  respawnSec: number
}

export function toAlertSnapshots(bosses: RaidBossEntry[]): RaidBossAlertSnapshot[] {
  return bosses.map((boss) => ({
    monsterName: boss.monster_name,
    mapName: boss.map_name,
    status: boss.status,
    nextSpawnUtcMs: nextSpawnUtcMs(boss),
    respawnSec: boss.respawn_sec,
  }))
}

/** 10-min Verdandi spawn — not part of the 3h world-raid train. */
const IGNORED_TRAIN_BOSS_IDS = new Set(['m1urpnvk'])
const IGNORED_TRAIN_BOSS_NAMES = new Set(['dexdorugreymon'])

/** Own cycle (5h). Separate 1-boss train; ends when this boss dies. */
const SOLO_TRAIN_BOSS_IDS = new Set(['mb4wgy4'])
const SOLO_TRAIN_BOSS_NAMES = new Set(['omegamon'])

export const MAIN_TRAIN_LANE_KEY = 'main'

function normalizeTrainBossName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, '')
}

function trainBossName(boss: RaidBossEntry | RaidBossAlertSnapshot): string {
  return 'monster_name' in boss ? boss.monster_name : boss.monsterName
}

function trainBossId(boss: RaidBossEntry | RaidBossAlertSnapshot): string {
  return 'monster_id' in boss ? boss.monster_id : ''
}

export function isIgnoredTrainBoss(boss: RaidBossEntry | RaidBossAlertSnapshot | string): boolean {
  if (typeof boss === 'string') return IGNORED_TRAIN_BOSS_NAMES.has(normalizeTrainBossName(boss))
  if (trainBossId(boss) && IGNORED_TRAIN_BOSS_IDS.has(trainBossId(boss))) return true
  return IGNORED_TRAIN_BOSS_NAMES.has(normalizeTrainBossName(trainBossName(boss)))
}

export function isSoloTrainBoss(boss: RaidBossEntry | RaidBossAlertSnapshot | string): boolean {
  if (typeof boss === 'string') return SOLO_TRAIN_BOSS_NAMES.has(normalizeTrainBossName(boss))
  if (trainBossId(boss) && SOLO_TRAIN_BOSS_IDS.has(trainBossId(boss))) return true
  return SOLO_TRAIN_BOSS_NAMES.has(normalizeTrainBossName(trainBossName(boss)))
}

export function soloTrainLaneKey(boss: RaidBossEntry | RaidBossAlertSnapshot | string): string {
  const name = typeof boss === 'string' ? boss : trainBossName(boss)
  return `solo:${name}`
}

export type TrainLane<T> = {
  key: string
  bosses: T[]
}

/** Drop ignored bosses and split solo bosses (Omegamon) onto their own lanes. */
export function partitionTrainLanes<T extends RaidBossEntry | RaidBossAlertSnapshot>(
  bosses: T[],
): TrainLane<T>[] {
  const main: T[] = []
  const solos = new Map<string, T[]>()

  for (const boss of bosses) {
    if (isIgnoredTrainBoss(boss)) continue
    if (isSoloTrainBoss(boss)) {
      const key = soloTrainLaneKey(boss)
      const list = solos.get(key) ?? []
      list.push(boss)
      solos.set(key, list)
      continue
    }
    main.push(boss)
  }

  const lanes: TrainLane<T>[] = []
  if (main.length > 0) lanes.push({ key: MAIN_TRAIN_LANE_KEY, bosses: main })
  for (const [key, list] of solos) {
    lanes.push({ key, bosses: list })
  }
  return lanes
}

export function bossesForTrainLane<T extends RaidBossEntry | RaidBossAlertSnapshot>(
  bosses: T[],
  laneKey: string,
): T[] {
  return partitionTrainLanes(bosses).find((lane) => lane.key === laneKey)?.bosses ?? []
}

function isBossSlainSnapshotAt(
  boss: RaidBossAlertSnapshot,
  allBosses: RaidBossAlertSnapshot[],
  nowMs: number,
): boolean {
  if (boss.status === 'alive' || boss.status === 'ready') return false
  const until = Math.max(0, boss.nextSpawnUtcMs - nowMs)
  const cycleMs = Math.max(boss.respawnSec, 60) * 1000
  if (until <= cycleMs * 0.85) return false

  const soonestSpawn = Math.min(...allBosses.map((b) => alertTrainSpawnMs(b, nowMs)))
  const bossMs = alertTrainSpawnMs(boss, nowMs)
  if (bossMs - soonestSpawn <= TRAIN_WAVE_TAIL_MS) return false

  return true
}

export type CurrentTrainWave = {
  train: RaidBossAlertSnapshot[]
  cycleAnchorMs: number
}

/** Alert roster for the current train wave only — excludes next-cycle (~3h) respawns. */
export function buildCurrentTrainWaveForAlerts(
  snapshots: RaidBossAlertSnapshot[],
  nowMs = Date.now(),
): CurrentTrainWave | null {
  const all = buildUnifiedAlertTrain(snapshots, nowMs)
  if (all.length === 0) return null

  const trainActive = all.some((b) => b.status === 'alive' || b.status === 'ready')

  const inCycle = all.filter((b) => !isBossSlainSnapshotAt(b, all, nowMs))
  if (inCycle.length === 0) return null

  if (!trainActive) {
    const respawning = inCycle.filter((b) => b.status === 'respawning')
    if (respawning.length === 0) return null
    const anchorMs = Math.min(...respawning.map((b) => b.nextSpawnUtcMs))
    const train = inCycle.filter((b) => {
      if (b.status === 'alive' || b.status === 'ready') return true
      return b.nextSpawnUtcMs <= anchorMs + TRAIN_WAVE_TAIL_MS
    })
    if (train.length === 0) return null
    return { train, cycleAnchorMs: anchorMs }
  }

  const wave = inCycle.filter((b) => {
    if (b.status === 'alive' || b.status === 'ready') return true
    const until = b.nextSpawnUtcMs - nowMs
    return until <= TRAIN_WAVE_TAIL_MS
  })
  if (wave.length === 0) return null

  const pastSlots = wave
    .filter((b) => b.status === 'respawning' && b.nextSpawnUtcMs <= nowMs)
    .map((b) => b.nextSpawnUtcMs)
  const anchorMs =
    pastSlots.length > 0
      ? Math.min(...pastSlots)
      : Math.min(...wave.map((b) => alertTrainSpawnMs(b, nowMs)))

  const train = wave.filter((b) => {
    if (b.status === 'alive' || b.status === 'ready') return true
    return b.nextSpawnUtcMs <= anchorMs + TRAIN_WAVE_TAIL_MS
  })

  return { train, cycleAnchorMs: anchorMs }
}

/** Consecutive spawns within this gap form one train (e.g. Suka → Crowmon → Goatmon). */
export const BOSS_TRAIN_WINDOW_MS = 5 * 60_000

/** How far ahead to show the next train after the current one ends (alerts / snapshot). */
export const TRAIN_LOOKAHEAD_MS = 5 * 60 * 60_000

/** Typical world raid respawn cycle (3h). Used for stable alert dedupe per train. */
export const RAID_TRAIN_CYCLE_MS = 3 * 60 * 60_000

/** Spawn groups tighter than this are simultaneous spawns, not a train. */
export const BOSS_TRAIN_MIN_SPAN_MS = 10_000

/** Spawn instant used for train grouping — active bosses count as "now". */
export function bossTrainSpawnMs(boss: RaidBossEntry, nowMs: number): number {
  if (boss.status === 'alive' || boss.status === 'ready') return nowMs
  return nextSpawnUtcMs(boss)
}

function alertTrainSpawnMs(boss: RaidBossAlertSnapshot, nowMs: number): number {
  if (boss.status === 'alive' || boss.status === 'ready') return nowMs
  return boss.nextSpawnUtcMs
}

function isMultiBossTrain<T>(group: T[], spawnMs: (item: T) => number): boolean {
  if (group.length <= 1) return false
  const first = spawnMs(group[0]!)
  const last = spawnMs(group[group.length - 1]!)
  return last - first > BOSS_TRAIN_MIN_SPAN_MS
}

/** Group items when each spawn is within `windowMs` of the previous in sorted order. */
export function groupByNextSpawnWindow<T>(
  items: T[],
  spawnMs: (item: T) => number,
  windowMs = BOSS_TRAIN_WINDOW_MS,
): T[][] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => spawnMs(a) - spawnMs(b))
  const groups: T[][] = []
  let current: T[] = [sorted[0]!]

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i]!
    const prev = current[current.length - 1]!
    if (spawnMs(item) - spawnMs(prev) <= windowMs) {
      current.push(item)
    } else {
      groups.push(current)
      current = [item]
    }
  }
  groups.push(current)
  return groups
}

/** Like `groupByNextSpawnWindow`, but splits groups that are only simultaneous spawns (<10s span). */
export function groupByNextSpawnWindowWithTrains<T>(
  items: T[],
  spawnMs: (item: T) => number,
  windowMs = BOSS_TRAIN_WINDOW_MS,
): T[][] {
  const raw = groupByNextSpawnWindow(items, spawnMs, windowMs)
  const out: T[][] = []
  for (const group of raw) {
    if (isMultiBossTrain(group, spawnMs)) {
      out.push(group)
    } else {
      for (const item of group) out.push([item])
    }
  }
  return out
}

export function groupBossesIntoTrains(
  bosses: RaidBossEntry[],
  nowMs = Date.now(),
  windowMs = BOSS_TRAIN_WINDOW_MS,
): RaidBossEntry[][] {
  return groupByNextSpawnWindowWithTrains(bosses, (b) => bossTrainSpawnMs(b, nowMs), windowMs)
}

export function groupAlertSnapshotsIntoTrains(
  bosses: RaidBossAlertSnapshot[],
  nowMs = Date.now(),
  windowMs = BOSS_TRAIN_WINDOW_MS,
): RaidBossAlertSnapshot[][] {
  return groupByNextSpawnWindowWithTrains(bosses, (b) => alertTrainSpawnMs(b, nowMs), windowMs)
}

/**
 * Group respawning bosses for spawn reminders — one unified train per cycle.
 * Includes alive/ready bosses (e.g. Neptunemon) in the roster for embed copy.
 */
export function buildUnifiedAlertTrain(
  bosses: RaidBossAlertSnapshot[],
  nowMs = Date.now(),
): RaidBossAlertSnapshot[] {
  const inCycle = bosses.filter(
    (b) =>
      !isIgnoredTrainBoss(b) &&
      (b.status === 'alive' || b.status === 'ready' || b.status === 'respawning'),
  )
  if (inCycle.length === 0) return []

  return [...inCycle].sort(
    (a, b) => alertTrainSpawnMs(a, nowMs) - alertTrainSpawnMs(b, nowMs),
  )
}

export function groupAlertSnapshotsForNotify(
  bosses: RaidBossAlertSnapshot[],
  nowMs = Date.now(),
): RaidBossAlertSnapshot[][] {
  const wave = buildCurrentTrainWaveForAlerts(bosses, nowMs)
  if (!wave) return []
  const hasUpcoming = wave.train.some((b) => b.status === 'respawning')
  if (!hasUpcoming) return []
  return [wave.train]
}

export function sortBossesForVisibility(bosses: RaidBossEntry[], nowMs: number): RaidBossEntry[] {
  return [...bosses].sort((a, b) => {
    const da = bossTrainSpawnMs(a, nowMs)
    const db = bossTrainSpawnMs(b, nowMs)
    if (da !== db) return da - db
    return nextSpawnUtcMs(a) - nextSpawnUtcMs(b)
  })
}

/** Soonest spawns first; clamps count to 1–15. */
export function pickVisibleBosses(
  bosses: RaidBossEntry[],
  count: number,
  nowMs = Date.now(),
): RaidBossEntry[] {
  const n = Math.min(15, Math.max(1, Math.round(count)))
  return sortBossesForVisibility(bosses, nowMs).slice(0, n)
}

export type BossTimerVisibleTrain = {
  bosses: RaidBossEntry[]
  /** Full roster train size (one unique instance of every raid boss). */
  totalSpawnCount: number
  laneKey: string
}

/** One unique entry per boss id — prefer alive/ready, else soonest spawn. */
export function uniqueBossRoster(bosses: RaidBossEntry[], nowMs = Date.now()): RaidBossEntry[] {
  const byId = new Map<string, RaidBossEntry>()

  for (const boss of bosses) {
    const existing = byId.get(boss.monster_id)
    if (!existing) {
      byId.set(boss.monster_id, boss)
      continue
    }

    const bossActive = isBossAlive(boss) || isBossReady(boss)
    const existingActive = isBossAlive(existing) || isBossReady(existing)
    if (bossActive && !existingActive) {
      byId.set(boss.monster_id, boss)
      continue
    }
    if (!bossActive && !existingActive) {
      if (bossTrainSpawnMs(boss, nowMs) < bossTrainSpawnMs(existing, nowMs)) {
        byId.set(boss.monster_id, boss)
      }
    }
  }

  return [...byId.values()].sort(
    (a, b) => bossTrainSpawnMs(a, nowMs) - bossTrainSpawnMs(b, nowMs),
  )
}

/** Visible bosses as the full-roster train for the timer UI. */
export function pickVisibleBossTrains(
  bosses: RaidBossEntry[],
  _count: number,
  serverOffsetMs = 0,
): BossTimerVisibleTrain[] {
  return pickDisplayBossTrains(bosses, serverOffsetMs, TRAIN_LOOKAHEAD_MS)
}

function isTrainInProgress(
  train: RaidBossEntry[],
  serverOffsetMs: number,
  allBosses: RaidBossEntry[],
): boolean {
  if (train.some((b) => isBossAlive(b) || isBossReady(b))) return true
  const slain = train.filter((b) => isBossSlain(b, serverOffsetMs, allBosses)).length
  return slain > 0 && slain < train.length
}

/** Alert-poller active check — still based on 5-minute spawn clusters. */
export function hasActiveRaidTrain(bosses: RaidBossEntry[], serverOffsetMs = 0): boolean {
  const nowMs = serverNowMs(serverOffsetMs)
  for (const lane of partitionTrainLanes(bosses)) {
    for (const train of groupBossesIntoTrains(lane.bosses, nowMs)) {
      if (isTrainInProgress(train, serverOffsetMs, lane.bosses)) return true
    }
  }
  return false
}

function pickLaneDisplayTrain(
  bosses: RaidBossEntry[],
  laneKey: string,
  serverOffsetMs: number,
  nowMs: number,
  horizonMs: number,
): BossTimerVisibleTrain | null {
  const roster = uniqueBossRoster(bosses, nowMs)
  if (roster.length === 0) return null

  if (isTrainInProgress(roster, serverOffsetMs, roster)) {
    return { bosses: roster, totalSpawnCount: roster.length, laneKey }
  }

  const nonSlain = roster.filter((b) => !isBossSlain(b, serverOffsetMs, roster))
  if (nonSlain.length === 0) return null

  const leadMs = Math.min(...nonSlain.map((b) => bossTrainSpawnMs(b, nowMs))) - nowMs
  if (leadMs > horizonMs) return null

  return { bosses: roster, totalSpawnCount: roster.length, laneKey }
}

/**
 * One train per lane: the 3h world-raid roster, plus solo bosses (Omegamon).
 * DexDoruGreymon is ignored. A solo train disappears once that boss is slain.
 */
export function pickDisplayBossTrains(
  bosses: RaidBossEntry[],
  serverOffsetMs = 0,
  horizonMs = TRAIN_LOOKAHEAD_MS,
): BossTimerVisibleTrain[] {
  const nowMs = serverNowMs(serverOffsetMs)
  const visible: BossTimerVisibleTrain[] = []

  for (const lane of partitionTrainLanes(bosses)) {
    const train = pickLaneDisplayTrain(lane.bosses, lane.key, serverOffsetMs, nowMs, horizonMs)
    if (train) visible.push(train)
  }

  return visible.sort((a, b) => {
    const aLead = Math.min(...a.bosses.map((boss) => bossTrainSpawnMs(boss, nowMs)))
    const bLead = Math.min(...b.bosses.map((boss) => bossTrainSpawnMs(boss, nowMs)))
    return aLead - bLead
  })
}
