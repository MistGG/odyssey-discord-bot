const WIKI_MONSTERS_URL = 'https://thedigitalodyssey.com/api/wiki/monsters'

export type MonsterDrop = {
  item_id: string
  item_name: string
  item_icon_id: string
  quantity: number
  drop_type: string
}

export type MonsterRaidReward = {
  item_id: string
  item_name: string
  item_icon_id: string
  rate_permil: number
  min: number
  max: number
}

export type MonsterRaidBand = {
  start: number
  end: number
  rewards: MonsterRaidReward[]
}

export type MonsterDetail = {
  id: string
  name: string
  model_id: string
  drops?: MonsterDrop[]
  raid_rankings?: MonsterRaidBand[]
}

export type LootReward = {
  key: string
  item_name: string
  min: number
  max: number
  rate_label: string
}

const monsterCache = new Map<string, Promise<MonsterDetail | null>>()

function titleCase(value: string): string {
  const clean = value.replace(/[_-]+/g, ' ').trim()
  if (!clean) return 'Drop'
  return clean.replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatDropRatePermille(permil: number): string {
  const p = permil / 100
  return `${p.toFixed(permil % 100 ? 1 : 0)}%`
}

function parseMonsterDetail(raw: unknown): MonsterDetail | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const drops: MonsterDrop[] = []
  if (Array.isArray(o.drops)) {
    for (const row of o.drops) {
      if (!row || typeof row !== 'object') continue
      const d = row as Record<string, unknown>
      drops.push({
        item_id: String(d.item_id ?? ''),
        item_name: String(d.item_name ?? ''),
        item_icon_id: String(d.item_icon_id ?? ''),
        quantity: Number(d.quantity ?? 1),
        drop_type: String(d.drop_type ?? ''),
      })
    }
  }

  const raid_rankings: MonsterRaidBand[] = []
  if (Array.isArray(o.raid_rankings)) {
    for (const bandRaw of o.raid_rankings) {
      if (!bandRaw || typeof bandRaw !== 'object') continue
      const band = bandRaw as Record<string, unknown>
      const rewards: MonsterRaidReward[] = []
      if (Array.isArray(band.rewards)) {
        for (const rewardRaw of band.rewards) {
          if (!rewardRaw || typeof rewardRaw !== 'object') continue
          const r = rewardRaw as Record<string, unknown>
          rewards.push({
            item_id: String(r.item_id ?? ''),
            item_name: String(r.item_name ?? ''),
            item_icon_id: String(r.item_icon_id ?? ''),
            rate_permil: Number(r.rate_permil ?? 0),
            min: Number(r.min ?? 1),
            max: Number(r.max ?? r.min ?? 1),
          })
        }
      }
      raid_rankings.push({
        start: Number(band.start ?? 0),
        end: Number(band.end ?? 0),
        rewards,
      })
    }
  }

  return {
    id: String(o.id ?? ''),
    name: String(o.name ?? ''),
    model_id: String(o.model_id ?? ''),
    ...(drops.length ? { drops } : {}),
    ...(raid_rankings.length ? { raid_rankings } : {}),
  }
}

export function wikiBossPortraitUrl(modelId: string): string {
  const id = modelId.trim()
  if (!id) return ''
  return `https://thedigitalodyssey.com/models/${id}l.png`
}

export function wikiItemIconUrl(iconId: string): string {
  const id = iconId.trim()
  if (!id) return ''
  return `https://thedigitalodyssey.com/game_icons/items/${id}.png`
}

export async function fetchMonsterDetail(monsterId: string): Promise<MonsterDetail | null> {
  const safe = monsterId.trim()
  if (!safe) return null

  const cached = monsterCache.get(safe)
  if (cached) return cached

  const pending = (async () => {
    try {
      const res = await fetch(`${WIKI_MONSTERS_URL}?id=${encodeURIComponent(safe)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return null
      return parseMonsterDetail(await res.json())
    } catch {
      return null
    }
  })()

  monsterCache.set(safe, pending)
  return pending
}

export async function fetchMonsterDetailsForBosses(
  monsterIds: string[],
): Promise<Map<string, MonsterDetail>> {
  const unique = [...new Set(monsterIds.map((id) => id.trim()).filter(Boolean))]
  const entries = await Promise.all(
    unique.map(async (id) => [id, await fetchMonsterDetail(id)] as const),
  )
  const out = new Map<string, MonsterDetail>()
  for (const [id, detail] of entries) {
    if (detail) out.set(id, detail)
  }
  return out
}

export function flattenMonsterLoot(monster: MonsterDetail | null): LootReward[] {
  if (!monster) return []
  const out: LootReward[] = []

  for (const [i, drop] of (monster.drops ?? []).entries()) {
    const qty = Math.max(1, Math.round(drop.quantity || 1))
    out.push({
      key: `drop:${drop.item_id}:${i}`,
      item_name: drop.item_name,
      min: qty,
      max: qty,
      rate_label: titleCase(drop.drop_type),
    })
  }

  for (const [bandIndex, band] of (monster.raid_rankings ?? []).entries()) {
    for (const [rewardIndex, reward] of band.rewards.entries()) {
      out.push({
        key: `raid:${bandIndex}:${reward.item_id}:${rewardIndex}`,
        item_name: reward.item_name,
        min: reward.min,
        max: reward.max,
        rate_label: formatDropRatePermille(reward.rate_permil),
      })
    }
  }

  return out
}

function formatQty(min: number, max: number): string {
  return min === max ? `×${min}` : `×${min}–${max}`
}

export function formatLootBrief(rewards: LootReward[], maxItems = 4): string {
  if (rewards.length === 0) return '_No wiki loot listed_'
  return rewards
    .slice(0, maxItems)
    .map((r) => `• **${r.item_name}** ${formatQty(r.min, r.max)} (${r.rate_label})`)
    .join('\n')
}

export function formatLootOneLine(rewards: LootReward[], maxItems = 3): string {
  if (rewards.length === 0) return 'No wiki loot'
  return rewards
    .slice(0, maxItems)
    .map((r) => `${r.item_name} ${formatQty(r.min, r.max)}`)
    .join(' · ')
}
