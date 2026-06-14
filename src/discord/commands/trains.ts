import { SlashCommandBuilder, type ChatInputCommandInteraction, type Message } from 'discord.js'
import { fetchRaidTimer } from '../../lib/raidTimerApi.js'
import { buildTrainsMessage } from '../trainsView.js'

const LIVE_REFRESH_MS = 30_000
const ACTIVE_TRAIN_REFRESH_MS = 10_000
const RENDER_TIMEOUT_MS = 20_000

const liveSessions = new Map<string, AbortController>()

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

function sessionKey(interaction: ChatInputCommandInteraction): string {
  return `${interaction.channelId ?? 'dm'}:${interaction.user.id}`
}

function isUnknownMessageError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 10008
}

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

async function renderTrainsMessage() {
  const data = await fetchRaidTimer()
  const payload = await buildTrainsMessage(data)
  return payload
}

async function editTrainsMessage(
  message: Message,
  payload: Awaited<ReturnType<typeof renderTrainsMessage>>,
): Promise<void> {
  await message.edit({
    components: payload.components,
    flags: payload.flags,
  })
}

async function replyWithTrainsPayload(
  interaction: ChatInputCommandInteraction,
  payload: Awaited<ReturnType<typeof renderTrainsMessage>>,
): Promise<Message> {
  await interaction.editReply({
    components: payload.components,
    flags: payload.flags,
  })
  return interaction.fetchReply()
}

async function replyWithError(interaction: ChatInputCommandInteraction, message: string): Promise<void> {
  await interaction.editReply({
    content: message,
    components: [],
    embeds: [],
  })
}

async function runLiveRefresh(
  message: Message,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let refreshMs = LIVE_REFRESH_MS
    try {
      const payload = await withTimeout(renderTrainsMessage(), RENDER_TIMEOUT_MS, 'Train refresh')
      await editTrainsMessage(message, payload)
      refreshMs = payload.activeTrain ? ACTIVE_TRAIN_REFRESH_MS : LIVE_REFRESH_MS
    } catch (err) {
      if (signal.aborted || isUnknownMessageError(err)) return
      console.error('[trains] live refresh failed:', err)
    }

    try {
      await sleep(refreshMs, signal)
    } catch {
      return
    }
  }
}

export const trainsCommand = new SlashCommandBuilder()
  .setName('trains')
  .setDescription('Show upcoming raid trains with spawn timers')
  .addBooleanOption((opt) =>
    opt
      .setName('live')
      .setDescription('Keep refreshing (10s during active trains, 30s otherwise; default: on)'),
  )

export async function handleTrainsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply()

  const live = interaction.options.getBoolean('live') ?? true
  const key = sessionKey(interaction)
  liveSessions.get(key)?.abort()

  let message: Message
  try {
    const payload = await withTimeout(renderTrainsMessage(), RENDER_TIMEOUT_MS, 'Raid timer fetch')
    message = await replyWithTrainsPayload(interaction, payload)
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.error('[trains] initial render failed:', err)
    await replyWithError(interaction, `Failed to load raid trains: ${errMessage}`)
    return
  }

  if (!live) return

  const controller = new AbortController()
  liveSessions.set(key, controller)
  void runLiveRefresh(message, controller.signal).finally(() => {
    if (liveSessions.get(key) === controller) {
      liveSessions.delete(key)
    }
  })
}
