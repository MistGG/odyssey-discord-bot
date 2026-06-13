import {
  ContainerBuilder,
  MessageFlags,
  SeparatorSpacingSize,
} from 'discord.js'
import {
  bossTrainSpawnMs,
  isBossAlive,
  isBossReady,
  nextSpawnUtcMs,
  pickVisibleBossTrains,
  serverNowMs,
  type RaidBossEntry,
  type RaidTimerResponse,
} from '../lib/raidTimerApi.js'
import {
  fetchMonsterDetailsForBosses,
  wikiBossPortraitUrl,
  type MonsterDetail,
} from '../lib/wikiApi.js'

const COLOR_TRAIN = 0x6366f1
/** Discord V2: nested section children count toward the 40-component cap. */
const DISCORD_MAX_COMPONENTS = 40
/** One boss row: section + 2 text displays + thumbnail accessory. */
const COMPONENTS_PER_BOSS_ROW = 4
/** Header text + separator below header. */
const COMPONENTS_OVERHEAD = 2
const MAX_BOSSES = Math.floor((DISCORD_MAX_COMPONENTS - COMPONENTS_OVERHEAD) / COMPONENTS_PER_BOSS_ROW)

export const TRAINS_MESSAGE_FLAGS = MessageFlags.IsComponentsV2

function discordTimestamp(ms: number, style: 'R' | 'f' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`
}

function bossPortraitUrl(boss: RaidBossEntry, monster: MonsterDetail | null): string | undefined {
  const modelId = boss.model_id?.trim() || monster?.model_id?.trim()
  if (!modelId) return undefined
  const url = wikiBossPortraitUrl(modelId)
  return url || undefined
}

function spawnLine(boss: RaidBossEntry): string {
  if (isBossAlive(boss)) return '🟢 **Alive now**'
  if (isBossReady(boss)) return '🟡 **Ready**'
  const spawnMs = nextSpawnUtcMs(boss)
  return `⏱ ${discordTimestamp(spawnMs, 'R')} · ${discordTimestamp(spawnMs, 'f')}`
}

type BossRow = {
  boss: RaidBossEntry
  trainSize: number
  isFirstInTrain: boolean
}

function flattenVisibleBossRows(data: RaidTimerResponse): BossRow[] {
  const nowMs = serverNowMs(data.serverOffsetMs)
  const visibleTrains = pickVisibleBossTrains(data.bosses, 15, data.serverOffsetMs)
  const rows: BossRow[] = []

  for (const { bosses, totalSpawnCount } of visibleTrains) {
    const ordered = [...bosses].sort((a, b) => bossTrainSpawnMs(a, nowMs) - bossTrainSpawnMs(b, nowMs))
    for (let i = 0; i < ordered.length; i++) {
      rows.push({
        boss: ordered[i]!,
        trainSize: totalSpawnCount,
        isFirstInTrain: i === 0 && totalSpawnCount > 1,
      })
    }
  }

  return rows
}

function buildHeaderText(data: RaidTimerResponse, rows: BossRow[], truncated: boolean): string {
  const shown = rows.slice(0, MAX_BOSSES)
  const alive = data.bosses.filter((b) => isBossAlive(b)).length
  const ready = data.bosses.filter((b) => isBossReady(b)).length
  const trainRows = shown.filter((r) => r.isFirstInTrain)

  const parts = [
    data.live ? '**Live**' : '**Stale**',
    `${shown.length} boss${shown.length === 1 ? '' : 'es'}`,
    trainRows.length > 0 ? `${trainRows.length} train${trainRows.length === 1 ? '' : 's'}` : null,
    alive > 0 ? `${alive} alive` : null,
    ready > 0 ? `${ready} ready` : null,
  ].filter(Boolean)

  const lines = [`## Raid trains`, parts.join(' · ')]

  for (const row of trainRows) {
    const nowMs = serverNowMs(data.serverOffsetMs)
    const lead = bossTrainSpawnMs(row.boss, nowMs)
    const leadLine =
      isBossAlive(row.boss) || isBossReady(row.boss)
        ? 'active now'
        : `first ${discordTimestamp(lead, 'R')}`
    lines.push(`🚂 **${row.trainSize} spawns** · ${leadLine}`)
  }

  if (truncated) {
    lines.push(`_Showing first ${MAX_BOSSES} of ${rows.length} bosses._`)
  }

  lines.push('', '_Odyssey Calc · spawn times update live · refreshes every 30s_')

  return lines.join('\n')
}

export type TrainsMessagePayload = {
  components: ContainerBuilder[]
  flags: typeof TRAINS_MESSAGE_FLAGS
}

export async function buildTrainsMessage(data: RaidTimerResponse): Promise<TrainsMessagePayload> {
  const rows = flattenVisibleBossRows(data)
  const container = new ContainerBuilder().setAccentColor(COLOR_TRAIN)

  if (rows.length === 0) {
    container.addTextDisplayComponents((text) =>
      text.setContent('## Raid trains\nNo upcoming raid bosses in the timer response.'),
    )
    return { components: [container], flags: TRAINS_MESSAGE_FLAGS }
  }

  const truncated = rows.length > MAX_BOSSES
  const shownRows = rows.slice(0, MAX_BOSSES)
  const needsWiki = shownRows.some((r) => !r.boss.model_id?.trim())
  const monsters = needsWiki
    ? await fetchMonsterDetailsForBosses(shownRows.map((r) => r.boss.monster_id))
    : new Map<string, MonsterDetail>()

  container.addTextDisplayComponents((text) => text.setContent(buildHeaderText(data, rows, truncated)))
  container.addSeparatorComponents((sep) =>
    sep.setDivider(true).setSpacing(SeparatorSpacingSize.Small),
  )

  for (const row of shownRows) {
    const boss = row.boss
    const map = boss.map_name?.trim() || 'Unknown map'
    const portrait = bossPortraitUrl(boss, monsters.get(boss.monster_id) ?? null)

    container.addSectionComponents((section) => {
      section.addTextDisplayComponents(
        (text) => text.setContent(`**${boss.monster_name}**\n📍 ${map}`),
        (text) => text.setContent(spawnLine(boss)),
      )
      if (portrait) {
        section.setThumbnailAccessory((thumb) =>
          thumb.setURL(portrait).setDescription(boss.monster_name),
        )
      }
      return section
    })
  }

  return { components: [container], flags: TRAINS_MESSAGE_FLAGS }
}

/** @deprecated Use buildTrainsMessage for /trains replies. */
export async function buildTrainsViewEmbeds(data: RaidTimerResponse) {
  const { components } = await buildTrainsMessage(data)
  return components
}

export async function buildTrainsSnapshotEmbed(data: RaidTimerResponse) {
  const { components } = await buildTrainsMessage(data)
  return components[0]!
}
