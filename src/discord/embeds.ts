import { EmbedBuilder } from 'discord.js'
import type { RaidBossAlertSnapshot } from '../lib/raidTimerApi.js'
import type { BossAlertCandidate } from '../lib/bossTimerAlerts.js'

const EMBED_COLOR = 0x3ee0ff

function discordTimestamp(ms: number, style: 'R' | 'f' = 'R'): string {
  return `<t:${Math.floor(ms / 1000)}:${style}>`
}

function bossFieldLine(boss: RaidBossAlertSnapshot): string {
  const place = boss.mapName?.trim() || 'Unknown map'
  if (boss.status === 'alive') return `🟢 **${boss.monsterName}** · ${place} · **Alive**`
  if (boss.status === 'ready') return `🟡 **${boss.monsterName}** · ${place} · **Ready**`
  return `**${boss.monsterName}** · ${place} · ${discordTimestamp(boss.nextSpawnUtcMs, 'R')}`
}

export function buildTrainAlertEmbed(candidate: BossAlertCandidate): EmbedBuilder {
  const { train, leadMin, copy } = candidate
  const title = `${copy.title} — ~${leadMin} min`

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(title)
    .setFooter({ text: 'Odyssey Calc · live' })
    .setTimestamp()

  if (train.length === 1) {
    embed.setDescription(copy.body)
  } else {
    for (const boss of train) {
      embed.addFields({ name: bossFieldLine(boss), value: discordTimestamp(boss.nextSpawnUtcMs, 'f'), inline: false })
    }
  }

  return embed
}

export function rolePingContent(roleId: string | null): string | undefined {
  if (!roleId) return undefined
  return `<@&${roleId}>`
}
