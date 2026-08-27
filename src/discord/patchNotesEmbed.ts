import { AttachmentBuilder, EmbedBuilder } from 'discord.js'
import {
  patchNoteBlocks,
  patchNoteDisplayParts,
  patchNoteKind,
  type PatchNoteEntry,
} from '../lib/patchNotes.js'
import { fetchPatchNoteImage } from '../lib/patchNotesApi.js'
import {
  splitTextForDiscord,
  type DiscordContentBlock,
  type DiscordContentImage,
} from '../lib/releaseNotesText.js'

const EMBED_COLOR = 0x3ee0ff
const MAX_DESCRIPTION = 4096
const MAX_EMBEDS_PER_MESSAGE = 10
const MAX_FILES_PER_MESSAGE = 10
const MAX_EMBED_CHARS_PER_MESSAGE = 5900
const FALLBACK_DESCRIPTION = 'Open the link below for full patch notes.'

export type PatchNoteMessagePayload = {
  embeds: EmbedBuilder[]
  files: AttachmentBuilder[]
}

type EmbedSpec = {
  description: string
  image?: DiscordContentImage
}

type ResolvedEmbed = {
  description: string
  file: { filename: string; buffer: Buffer } | null
}

function embedTitle(note: PatchNoteEntry, part?: { index: number; total: number }): string {
  const { date, label } = patchNoteDisplayParts(note.title)
  const kind = patchNoteKind(note.title)
  const datePart = date ? `[${date}] ` : ''
  const base = `${datePart}${kind} · ${label}`
  if (!part || part.total <= 1) return base
  return `${base} (${part.index}/${part.total})`
}

export async function buildPatchNoteMessages(
  note: PatchNoteEntry,
  options?: { test?: boolean },
): Promise<PatchNoteMessagePayload[]> {
  const resolved = await resolveEmbeds(note)
  const total = resolved.length
  const footer = options?.test
    ? 'Odyssey Calc · patch notes · test preview'
    : 'Odyssey Calc · patch notes'

  const messages: PatchNoteMessagePayload[] = []
  let current: PatchNoteMessagePayload & { chars: number } = { embeds: [], files: [], chars: 0 }

  const flush = () => {
    if (current.embeds.length === 0) return
    messages.push({ embeds: current.embeds, files: current.files })
    current = { embeds: [], files: [], chars: 0 }
  }

  for (let index = 0; index < resolved.length; index++) {
    const spec = resolved[index]!
    const title = embedTitle(note, { index: index + 1, total })
    const footerText = total > 1 ? `${footer} · ${index + 1}/${total}` : footer
    const chars = title.length + spec.description.length + footerText.length
    const needsFile = spec.file != null

    const wouldOverflow =
      current.embeds.length >= MAX_EMBEDS_PER_MESSAGE ||
      (needsFile && current.files.length >= MAX_FILES_PER_MESSAGE) ||
      (current.embeds.length > 0 && current.chars + chars > MAX_EMBED_CHARS_PER_MESSAGE)

    if (wouldOverflow) flush()

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(title)
      .setURL(note.url)
      .setFooter({ text: footerText })
      .setTimestamp()

    if (spec.description) embed.setDescription(spec.description)
    if (spec.file) {
      embed.setImage(`attachment://${spec.file.filename}`)
      current.files.push(new AttachmentBuilder(spec.file.buffer, { name: spec.file.filename }))
    }

    current.embeds.push(embed)
    current.chars += chars
  }

  flush()
  return messages.length > 0
    ? messages
    : [
        {
          embeds: [
            new EmbedBuilder()
              .setColor(EMBED_COLOR)
              .setTitle(embedTitle(note))
              .setURL(note.url)
              .setDescription(FALLBACK_DESCRIPTION)
              .setFooter({ text: footer })
              .setTimestamp(),
          ],
          files: [],
        },
      ]
}

export async function sendPatchNoteMessages(
  channel: { send: (options: PatchNoteMessagePayload) => Promise<unknown> },
  note: PatchNoteEntry,
  options?: { test?: boolean },
): Promise<number> {
  const messages = await buildPatchNoteMessages(note, options)
  for (const payload of messages) {
    try {
      await channel.send(payload)
    } catch (err) {
      if (payload.files.length === 0) throw err
      console.warn('[patch-notes] could not attach images; posting text only:', err)
      await channel.send({
        embeds: payload.embeds.map(stripAttachmentImage),
        files: [],
      })
    }
  }
  return messages.length
}

function stripAttachmentImage(embed: EmbedBuilder): EmbedBuilder {
  const data = embed.toJSON()
  if (!data.image?.url?.startsWith('attachment://')) return embed
  return new EmbedBuilder({ ...data, image: undefined })
}

async function resolveEmbeds(note: PatchNoteEntry): Promise<ResolvedEmbed[]> {
  const specs = layoutEmbedSpecs(patchNoteBlocks(note))
  const downloads = await Promise.all(
    specs.map(async (spec, index) => {
      if (!spec.image) return null
      return fetchPatchNoteImage(spec.image.url, index)
    }),
  )

  return specs.map((spec, index) => ({
    description: spec.description,
    file: downloads[index] ?? null,
  }))
}

function layoutEmbedSpecs(blocks: DiscordContentBlock[]): EmbedSpec[] {
  const specs: EmbedSpec[] = []
  let current = ''

  const flush = (image?: DiscordContentImage) => {
    if (!current && !image) return
    if (current.length <= MAX_DESCRIPTION) {
      specs.push({ description: current, image })
      current = ''
      return
    }

    const chunks = splitTextForDiscord(current, MAX_DESCRIPTION)
    for (let i = 0; i < chunks.length; i++) {
      specs.push({
        description: chunks[i]!,
        image: i === chunks.length - 1 ? image : undefined,
      })
    }
    current = ''
  }

  for (const block of blocks) {
    if (block.type === 'text') {
      if (!block.text) continue
      if (current && current.length + block.text.length + 2 > MAX_DESCRIPTION) {
        flush()
      }
      if (block.text.length > MAX_DESCRIPTION) {
        flush()
        const chunks = splitTextForDiscord(block.text, MAX_DESCRIPTION)
        for (let i = 0; i < chunks.length; i++) {
          if (i < chunks.length - 1) specs.push({ description: chunks[i]! })
          else current = chunks[i] ?? ''
        }
        continue
      }
      current = current ? `${current}\n\n${block.text}` : block.text
      continue
    }

    const { body, caption } = takeTrailingCaption(current)
    if (caption) {
      current = body
      flush()
      current = caption
    }
    flush(block.image)
  }

  flush()
  if (specs.length === 0) return [{ description: FALLBACK_DESCRIPTION }]
  return specs.filter((spec) => spec.description || spec.image)
}

function takeTrailingCaption(text: string): { body: string; caption: string | null } {
  const heading = text.match(
    /(?:^|\n\n)(\*\*[^*\n]{1,120}\*\*(?:\n+[^\n*]{1,80}){0,3})\s*$/,
  )
  if (heading?.[1]) {
    const body = text.slice(0, heading.index).trim()
    if (body) return { body, caption: heading[1].trim() }
  }
  return { body: text, caption: null }
}
