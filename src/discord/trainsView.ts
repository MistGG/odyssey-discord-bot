import {
  ContainerBuilder,
  MessageFlags,
} from 'discord.js'
import {
  bossTrainSpawnMs,
  isBossAlive,
  isBossReady,
  isBossSlain,
  MAIN_TRAIN_LANE_KEY,
  nextSpawnUtcMs,
  pickDisplayBossTrains,
  serverNowMs,
  type BossTimerVisibleTrain,
  type RaidBossEntry,
  type RaidTimerResponse,
} from '../lib/raidTimerApi.js'

const COLOR_TRAIN = 0x6366f1

export const TRAINS_MESSAGE_FLAGS = MessageFlags.IsComponentsV2

function discordTimestamp(ms: number, style: 'R' | 'f' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`
}

function bossLine(boss: RaidBossEntry, serverOffsetMs: number, allBosses: RaidBossEntry[]): string {
  const map = boss.map_name?.trim() || 'Unknown map'
  if (isBossSlain(boss, serverOffsetMs, allBosses)) {
    return `• ~~${boss.monster_name}~~ · ${map} · Defeated`
  }
  if (isBossAlive(boss)) {
    return `• **${boss.monster_name}** · ${map} · Alive`
  }
  if (isBossReady(boss)) {
    return `• **${boss.monster_name}** · ${map} · Ready`
  }
  return `• **${boss.monster_name}** · ${map} · ${discordTimestamp(nextSpawnUtcMs(boss), 'R')}`
}

function trainHeading(train: BossTimerVisibleTrain, multiple: boolean): string {
  if (train.laneKey !== MAIN_TRAIN_LANE_KEY) {
    return `## ${train.bosses[0]?.monster_name ?? 'Solo train'}`
  }
  return multiple ? '## Raid train' : '## Next raid train'
}

function trainSection(
  data: RaidTimerResponse,
  train: BossTimerVisibleTrain,
  multiple: boolean,
): string {
  const nowMs = serverNowMs(data.serverOffsetMs)
  const bosses = [...train.bosses].sort(
    (a, b) => bossTrainSpawnMs(a, nowMs) - bossTrainSpawnMs(b, nowMs),
  )
  const lead = bosses[0]
  const leadLine = !lead
    ? null
    : isBossAlive(lead) || isBossReady(lead)
      ? 'active now'
      : isBossSlain(lead, data.serverOffsetMs, bosses)
        ? 'in progress'
        : `first ${discordTimestamp(bossTrainSpawnMs(lead, nowMs), 'R')}`

  const headerBits = [
    `${bosses.length} boss${bosses.length === 1 ? '' : 'es'}`,
    leadLine,
    data.live ? null : 'stale timer',
  ].filter(Boolean)

  return [
    trainHeading(train, multiple),
    headerBits.join(' · '),
    '',
    ...bosses.map((boss) => bossLine(boss, data.serverOffsetMs, bosses)),
  ].join('\n')
}

function buildSnapshotText(data: RaidTimerResponse, trains: BossTimerVisibleTrain[]): string {
  const multiple = trains.length > 1
  return [
    ...trains.map((train) => trainSection(data, train, multiple)),
    '_Run /trains again to refresh_',
  ].join('\n\n')
}

export type TrainsMessagePayload = {
  components: ContainerBuilder[]
  flags: typeof TRAINS_MESSAGE_FLAGS
}

export type TrainsMessageOptions = {
  horizonMs?: number
}

export async function buildTrainsMessage(
  data: RaidTimerResponse,
  options?: TrainsMessageOptions,
): Promise<TrainsMessagePayload> {
  const trains = pickDisplayBossTrains(data.bosses, data.serverOffsetMs, options?.horizonMs)
  const container = new ContainerBuilder().setAccentColor(COLOR_TRAIN)

  if (trains.length === 0) {
    const emptyText =
      data.bosses.length > 0
        ? '## Next raid train\nNo raid train in the current lookahead window.'
        : '## Next raid train\nNo upcoming raid bosses in the timer response.'
    container.addTextDisplayComponents((text) => text.setContent(emptyText))
    return { components: [container], flags: TRAINS_MESSAGE_FLAGS }
  }

  container.addTextDisplayComponents((text) => text.setContent(buildSnapshotText(data, trains)))
  return { components: [container], flags: TRAINS_MESSAGE_FLAGS }
}

export async function buildTrainsViewEmbeds(data: RaidTimerResponse) {
  const { components } = await buildTrainsMessage(data)
  return components
}

export async function buildTrainsSnapshotEmbed(data: RaidTimerResponse) {
  const { components } = await buildTrainsMessage(data)
  return components[0]!
}
