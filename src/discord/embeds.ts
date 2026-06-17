import { EmbedBuilder } from 'discord.js'
import type { RaidBossAlertSnapshot } from '../lib/raidTimerApi.js'
import type { BossAlertCandidate } from '../lib/bossTimerAlerts.js'

const EMBED_COLOR = 0x3ee0ff

function discordTimestamp(ms: number, style: 'R' | 'f' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`
}

function formatBossName(name: string, slain: boolean): string {
  return slain ? `~~${name}~~` : `**${name}**`
}

function bossFieldLine(boss: RaidBossAlertSnapshot, slain: boolean): string {
  const place = boss.mapName?.trim() || 'Unknown map'
  const name = formatBossName(boss.monsterName, slain)
  if (slain) return `💀 ${name} · ${place} · **Defeated**`
  if (boss.status === 'alive') return `🟢 ${name} · ${place} · **Alive**`
  if (boss.status === 'ready') return `🟡 ${name} · ${place} · **Ready**`
  return `${name} · ${place} · ${discordTimestamp(boss.nextSpawnUtcMs, 'R')}`
}

function bossFieldValue(boss: RaidBossAlertSnapshot, slain: boolean): string {
  if (slain) return 'Defeated'
  if (boss.status === 'alive') return 'Alive now'
  if (boss.status === 'ready') return 'Ready to spawn'
  return discordTimestamp(boss.nextSpawnUtcMs, 'f')
}

function singleBossDescription(boss: RaidBossAlertSnapshot, slain: boolean, leadMin: number): string {
  const place = boss.mapName?.trim() || 'world boss location'
  const name = formatBossName(boss.monsterName, slain)
  if (slain) return `${name} · ${place} · **Defeated**`
  if (boss.status === 'alive') return `${name} · ${place} · **Alive now**`
  if (boss.status === 'ready') return `${name} · ${place} · **Ready**`
  return `About ${leadMin} min until the next window. ${name} · ${place} · ${discordTimestamp(boss.nextSpawnUtcMs, 'R')}`
}

export type TrainAlertEmbedOptions = {
  slainNames?: ReadonlySet<string>
  liveTrain?: RaidBossAlertSnapshot[]
}

export function buildTrainAlertEmbed(
  candidate: BossAlertCandidate,
  options?: TrainAlertEmbedOptions,
): EmbedBuilder {
  const { train, leadMin, copy } = candidate
  const slainNames = options?.slainNames ?? new Set<string>()
  const displayTrain = options?.liveTrain ?? train
  const title =
    leadMin > 0 ? `${copy.title} · ~${leadMin} min` : `${copy.title} · Active now`

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setFooter({ text: 'Odyssey Calc · live' })
    .setTimestamp()

  if (displayTrain.length === 1) {
    const boss = displayTrain[0]!
    embed.setDescription(singleBossDescription(boss, slainNames.has(boss.monsterName), leadMin))
  } else {
    for (const boss of displayTrain) {
      const slain = slainNames.has(boss.monsterName)
      embed.addFields({
        name: bossFieldLine(boss, slain),
        value: bossFieldValue(boss, slain),
        inline: false,
      })
    }
  }

  return embed
}

export function rolePingContent(roleId: string | null): string | undefined {
  if (!roleId) return undefined
  return `<@&${roleId}>`
}
