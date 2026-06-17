import {
  type Client,
  type Message,
  type MessageEditOptions,
  type Snowflake,
  type TextChannel,
} from 'discord.js'
import { fetchRaidTimer, TRAINS_LIVE_LOOKAHEAD_MS } from '../../lib/raidTimerApi.js'
import { buildTrainsMessage } from '../trainsView.js'
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'

const LIVE_REFRESH_MS = 30_000
const ACTIVE_TRAIN_REFRESH_MS = 10_000
const RENDER_TIMEOUT_MS = 20_000
/** Stop after this many consecutive edit failures (message gone, permissions, etc.). */
const MAX_CONSECUTIVE_FAILURES = 10

type LiveSessionRef = {
  client: Client
  channelId: Snowflake
  messageId: Snowflake
}

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

function isTerminalMessageError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false
  const code = (err as { code: number }).code
  return code === 10008 || code === 10003
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

async function renderLiveTrainsMessage() {
  const data = await fetchRaidTimer()
  return buildTrainsMessage(data, {
    horizonMs: TRAINS_LIVE_LOOKAHEAD_MS,
    updatedAtMs: Date.now(),
  })
}

async function renderTrainsMessage() {
  const data = await fetchRaidTimer()
  return buildTrainsMessage(data)
}

async function resolveLiveMessage(ref: LiveSessionRef): Promise<Message | null> {
  try {
    const channel = await ref.client.channels.fetch(ref.channelId)
    if (!channel?.isTextBased() || channel.isDMBased()) return null
    return await (channel as TextChannel).messages.fetch(ref.messageId)
  } catch (err) {
    if (isTerminalMessageError(err)) return null
    throw err
  }
}

async function editTrainsMessage(
  message: Message,
  payload: Awaited<ReturnType<typeof renderTrainsMessage>>,
): Promise<void> {
  const edit: MessageEditOptions = {
    components: payload.components,
    flags: payload.flags,
  }
  await message.edit(edit)
}

async function replyWithTrainsPayload(
  interaction: ChatInputCommandInteraction,
  payload: Awaited<ReturnType<typeof renderTrainsMessage>>,
): Promise<LiveSessionRef> {
  await interaction.editReply({
    components: payload.components,
    flags: payload.flags,
  })
  const message = await interaction.fetchReply()
  if (!message.channelId) {
    throw new Error('Could not resolve channel for live trains message')
  }
  return {
    client: interaction.client,
    channelId: message.channelId,
    messageId: message.id,
  }
}

async function replyWithError(interaction: ChatInputCommandInteraction, message: string): Promise<void> {
  await interaction.editReply({
    content: message,
    components: [],
    embeds: [],
  })
}

async function runLiveRefresh(ref: LiveSessionRef, signal: AbortSignal): Promise<void> {
  let consecutiveFailures = 0

  while (!signal.aborted) {
    let refreshMs = LIVE_REFRESH_MS
    try {
      const message = await resolveLiveMessage(ref)
      if (!message) {
        console.warn(`[trains] live refresh stopped: message ${ref.messageId} not found`)
        return
      }

      const payload = await withTimeout(renderLiveTrainsMessage(), RENDER_TIMEOUT_MS, 'Train refresh')
      await editTrainsMessage(message, payload)
      consecutiveFailures = 0
      refreshMs = payload.activeTrain ? ACTIVE_TRAIN_REFRESH_MS : LIVE_REFRESH_MS
    } catch (err) {
      if (signal.aborted || isTerminalMessageError(err)) {
        console.warn('[trains] live refresh stopped:', err)
        return
      }
      consecutiveFailures++
      console.error(`[trains] live refresh failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err)
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[trains] live refresh giving up after repeated failures')
        return
      }
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
      .setDescription('Keep refreshing until you run /trains again (default: on)'),
  )

export async function handleTrainsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply()

  const live = interaction.options.getBoolean('live') ?? true
  const key = sessionKey(interaction)
  liveSessions.get(key)?.abort()

  let sessionRef: LiveSessionRef
  try {
    const payload = await withTimeout(renderTrainsMessage(), RENDER_TIMEOUT_MS, 'Raid timer fetch')
    sessionRef = await replyWithTrainsPayload(interaction, payload)
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    console.error('[trains] initial render failed:', err)
    await replyWithError(interaction, `Failed to load raid trains: ${errMessage}`)
    return
  }

  if (!live) return

  const controller = new AbortController()
  liveSessions.set(key, controller)
  void runLiveRefresh(sessionRef, controller.signal).finally(() => {
    if (liveSessions.get(key) === controller) {
      liveSessions.delete(key)
    }
  })
}
