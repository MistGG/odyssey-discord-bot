import { EmbedBuilder } from 'discord.js'
import {
  patchNoteDisplayParts,
  patchNoteKind,
  type PatchNoteEntry,
} from '../lib/patchNotes.js'
import { stripHtmlToPlainText } from '../lib/releaseNotesText.js'
const EMBED_COLOR = 0x3ee0ff
const MAX_DESCRIPTION = 4096

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function embedTitle(note: PatchNoteEntry): string {
  const { date, label } = patchNoteDisplayParts(note.title)
  const kind = patchNoteKind(note.title)
  const datePart = date ? `[${date}] ` : ''
  return `${datePart}${kind} · ${label}`
}

export function buildPatchNoteEmbed(note: PatchNoteEntry, options?: { test?: boolean }): EmbedBuilder {
  const plainBody = stripHtmlToPlainText(note.bodyHtml)
  const description = plainBody
    ? truncate(plainBody, MAX_DESCRIPTION)
    : 'Open the link below for full patch notes.'

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(embedTitle(note))
    .setURL(note.url)
    .setDescription(description)
    .setFooter({
      text: options?.test
        ? 'Odyssey Calc · patch notes · test preview'
        : 'Odyssey Calc · patch notes',
    })
    .setTimestamp()
}
