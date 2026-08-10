import { outlineMarkdownToDiscord, stripHtmlToPlainText } from './releaseNotesText.js'

export type PatchNoteEntry = {
  id: string
  title: string
  url: string
  preview: string
  /** Preferred Discord-ready body (from Outline document text + children). */
  bodyText: string
  /** HTML scrape fallback when document text APIs are unavailable. */
  bodyHtml: string
}

export type OutlineShareTreeNode = {
  id: string
  title: string
  url: string
  children?: OutlineShareTreeNode[]
}

export type PatchNoteSection = {
  title: string | null
  text: string
}

export function sanitizeOutlineContentHtml(html: string): string {
  return html
    .replace(/<span class="heading-actions[^"]*"[\s\S]*?<\/span>/gi, '')
    .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .trim()
}

function readOutlineTitle(html: string): string {
  const fromTag = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim()
  if (fromTag) return fromTag

  const articleMatch = html.match(/<div class="screenreader-only">([\s\S]*?)<\/div>\s*<script/i)
  if (!articleMatch?.[1]) return 'Patch note'

  const titleMatch = articleMatch[1].match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  return stripHtmlToPlainText(titleMatch?.[1] ?? 'Patch note')
}

export function parseOutlineDocSummary(html: string, url: string): PatchNoteEntry {
  const id = docSlugFromUrl(url)
  return {
    id,
    title: readOutlineTitle(html),
    url,
    preview: '',
    bodyText: '',
    bodyHtml: '',
  }
}

export function parseOutlineDocPage(html: string, url: string): PatchNoteEntry {
  const summary = parseOutlineDocSummary(html, url)
  const articleMatch = html.match(/<div class="screenreader-only">([\s\S]*?)<\/div>\s*<script/i)
  if (!articleMatch?.[1]) {
    return summary
  }

  const contentMatch = articleMatch[1].match(/<div id="content"[^>]*>([\s\S]*?)<\/div>/i)
  const bodyHtml = sanitizeOutlineContentHtml(contentMatch?.[1] ?? '')
  const bodyText = stripHtmlToPlainText(bodyHtml)

  return { ...summary, bodyHtml, bodyText }
}

export function parsePatchNotesSitemap(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+\/doc\/[^<]+)<\/loc>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
}

export function docSlugFromUrl(url: string): string {
  return url.split('/doc/')[1]?.replace(/\/$/, '') ?? url
}

export function latestReleaseFromShareTree(
  tree: OutlineShareTreeNode | null | undefined,
): OutlineShareTreeNode | null {
  const releases = tree?.children
  if (!releases?.length) return null
  return releases[0] ?? null
}

export function composePatchNoteBody(sections: PatchNoteSection[]): string {
  const parts: string[] = []

  for (const section of sections) {
    const text = outlineMarkdownToDiscord(section.text)
    if (!text) continue

    if (section.title) {
      parts.push(`**${section.title.trim()}**\n\n${text}`)
    } else {
      parts.push(text)
    }
  }

  return parts.join('\n\n').trim()
}

export function patchNoteBody(note: PatchNoteEntry): string {
  if (note.bodyText.trim()) return note.bodyText.trim()
  return stripHtmlToPlainText(note.bodyHtml)
}

export function patchNoteDisplayParts(title: string): { date: string | null; label: string } {
  const bracketed = title.match(/^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/s)
  if (bracketed) {
    const label = bracketed[2].trim()
    return { date: bracketed[1], label: label || 'Update' }
  }

  const leading = title.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/s)
  if (leading) {
    return { date: leading[1], label: leading[2]?.trim() || 'Update' }
  }

  const embedded = title.match(/(\d{4}-\d{2}-\d{2})/)
  if (embedded) {
    const date = embedded[1]
    const label = title
      .replace(new RegExp(`\\[?${date}\\]?`), '')
      .replace(/\s+/g, ' ')
      .trim()
    return { date, label: label || 'Update' }
  }

  return { date: null, label: title }
}

export function patchNoteKind(title: string): 'Hotfix' | 'Patch' {
  return title.toLowerCase().includes('hotfix') ? 'Hotfix' : 'Patch'
}
