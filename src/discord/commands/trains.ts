import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { fetchRaidTimer } from '../../lib/raidTimerApi.js'
import { buildTrainsMessage } from '../trainsView.js'

const RENDER_TIMEOUT_MS = 20_000

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const trainsCommand = new SlashCommandBuilder()
  .setName('trains')
  .setDescription('Show the next raid train spawn times (only you can see this)')

export async function handleTrainsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  try {
    const data = await withTimeout(fetchRaidTimer(), RENDER_TIMEOUT_MS, 'Raid timer fetch')
    const payload = await withTimeout(buildTrainsMessage(data), RENDER_TIMEOUT_MS, 'Train render')
    await interaction.editReply({
      components: payload.components,
      flags: payload.flags,
    })
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.error('[trains] render failed:', err)
    await interaction.editReply({
      content: `Failed to load raid trains: ${errMessage}`,
      components: [],
      embeds: [],
    })
  }
}
