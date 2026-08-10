import { EmbedBuilder } from 'discord.js'
import {
  patchNoteBody,
  patchNoteDisplayParts,
  patchNoteKind,
  type PatchNoteEntry,
} from '../lib/patchNotes.js'
import { splitTextForDiscord } from '../lib/releaseNotesText.js'

const EMBED_COLOR = 0x3ee0ff
const MAX_DESCRIPTION = 4096
const FALLBACK_DESCRIPTION = 'Open the link below for full patch notes.'

function embedTitle(note: PatchNoteEntry, part?: { index: number; total: number }): string {
  const { date, label } = patchNoteDisplayParts(note.title)
  const kind = patchNoteKind(note.title)
  const datePart = date ? `[${date}] ` : ''
  const base = `${datePart}${kind} · ${label}`
  if (!part || part.total <= 1) return base
  return `${base} (${part.index}/${part.total})`
}

export function buildPatchNoteEmbeds(
  note: PatchNoteEntry,
  options?: { test?: boolean },
): EmbedBuilder[] {
  const body = patchNoteBody(note)
  const chunks = body ? splitTextForDiscord(body, MAX_DESCRIPTION) : [FALLBACK_DESCRIPTION]
  const total = chunks.length
  const footer = options?.test
    ? 'Odyssey Calc · patch notes · test preview'
    : 'Odyssey Calc · patch notes'

  return chunks.map((description, index) =>
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(embedTitle(note, { index: index + 1, total }))
      .setURL(note.url)
      .setDescription(description)
      .setFooter({ text: total > 1 ? `${footer} · ${index + 1}/${total}` : footer })
      .setTimestamp(),
  )
}

export function buildPatchNoteEmbed(
  note: PatchNoteEntry,
  options?: { test?: boolean },
): EmbedBuilder {
  return buildPatchNoteEmbeds(note, options)[0]!
}
