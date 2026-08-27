export type DiscordContentImage = {
  url: string
  alt?: string
  width?: number
  height?: number
}

export type DiscordContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; image: DiscordContentImage }

const MIN_USEFUL_IMAGE_PX = 80
const GENERIC_TABLE_HEADER =
  /^(currency|item|items|name|names|material|materials|qty|quantity|amount|count|value|cost|type)?$/i

const IMAGE_MD_RE = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/gi
const IMAGE_PLACEHOLDER_RE = /<<<IMG:(\d+)>>>/g

export function likelyHtmlReleaseNotes(s: string): boolean {
  if (!s.includes('<')) return false
  if (/<\/[a-z][\s\S]*?>/i.test(s)) return true
  return /<(?:br|p|div|span|ul|ol|li|h[1-6]|strong|em|a|img|table|tr|td|th|pre|code)\b/i.test(
    s,
  )
}

export function stripHtmlToPlainText(raw: string): string {
  const blocks = htmlReleaseNotesToBlocks(raw)
  return blocksToPlainText(blocks)
}

export function htmlReleaseNotesToBlocks(raw: string): DiscordContentBlock[] {
  const s = raw.trim()
  if (!s) return []
  if (!likelyHtmlReleaseNotes(s)) return outlineMarkdownToBlocks(raw)

  const images: DiscordContentImage[] = []
  let html = s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')

  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = decodeEntities(attrValue(tag, 'src') ?? '')
    if (!src) return '\n'
    const url = absolutizeDocsUrl(src)
    if (!url) return '\n'
    const alt = decodeEntities(attrValue(tag, 'alt') ?? '')
    images.push({ url, alt })
    return `\n<<<IMG:${images.length - 1}>>>\n`
  })

  html = html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => `\n${htmlTableToDiscord(table)}\n`)

  const text = decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|section|article|blockquote|header|footer)>/gi, '\n\n')
      .replace(/<\/(li|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, ''),
  )

  return placeholderTextToBlocks(text, images)
}

/** Convert Outline markdown into Discord-embed-friendly text. */
export function outlineMarkdownToDiscord(raw: string): string {
  return blocksToPlainText(outlineMarkdownToBlocks(raw))
}

export function outlineMarkdownToBlocks(raw: string): DiscordContentBlock[] {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const blocks: DiscordContentBlock[] = []
  let textLines: string[] = []
  let i = 0

  const flushText = () => {
    const text = formatMarkdownText(textLines.join('\n'))
    if (text) blocks.push({ type: 'text', text })
    textLines = []
  }

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const image = parseStandaloneImage(line)
    if (image) {
      flushText()
      if (!isTinyImage(image)) blocks.push({ type: 'image', image })
      i += 1
      continue
    }

    const table = parseMarkdownTable(lines, i)
    if (table) {
      textLines.push(table.text)
      i = table.end
      continue
    }

    textLines.push(line)
    i += 1
  }

  flushText()
  return mergeAdjacentTextBlocks(blocks)
}

export function blocksToPlainText(blocks: DiscordContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

/** Split text into chunks that fit Discord embed description limits. */
export function splitTextForDiscord(text: string, max = 4096): string[] {
  const s = text.trim()
  if (!s) return []
  if (s.length <= max) return [s]

  const chunks: string[] = []
  let remaining = s

  while (remaining.length > max) {
    const window = remaining.slice(0, max)
    const breakAt = chooseSplitIndex(window, max)
    const chunk = remaining.slice(0, breakAt).trimEnd()
    if (chunk && !isJunkChunk(chunk)) chunks.push(chunk)
    remaining = remaining.slice(breakAt).trimStart()
  }

  if (remaining && !isJunkChunk(remaining)) chunks.push(remaining)
  return chunks
}

function chooseSplitIndex(window: string, max: number): number {
  const minKeep = max * 0.5
  const separators = ['\n\n**', '\n**', '\n\n', '\n', ' ']
  const idx = lastIndexOfAny(window, separators)
  if (idx > minKeep) {
    if (window.startsWith('\n**', idx) || window.startsWith('\n\n**', idx)) return idx
    return idx + (window.startsWith('\n\n', idx) ? 2 : 1)
  }
  return max
}

function lastIndexOfAny(text: string, separators: string[]): number {
  let best = -1
  for (const sep of separators) {
    const idx = text.lastIndexOf(sep)
    if (idx > best) best = idx
  }
  return best
}

function isJunkChunk(text: string): boolean {
  return /^[\s\\|]+$/.test(text)
}

function formatMarkdownText(raw: string): string {
  const withoutImages = raw.replace(IMAGE_MD_RE, '')
  return collapseBlankLines(
    withoutImages
      .replace(/^[ \t]*\\[ \t]*$/gm, '')
      .replace(/\\[ \t]*$/gm, '')
      .replace(/^#{1,6}\s+(.+)$/gm, (_, heading: string) => `**${unwrapBold(heading.trim())}**`)
      .replace(/^[ \t]*[-*+]\s+/gm, (match) => (match.length > 3 ? '  • ' : '• '))
      .replace(/^\s*(\d+)\.\s+/gm, '$1. ')
      .replace(/\\([\\`*_{}[\]()#+.!>|-])/g, '$1'),
  )
}

function parseStandaloneImage(line: string): DiscordContentImage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  IMAGE_MD_RE.lastIndex = 0
  const match = IMAGE_MD_RE.exec(trimmed)
  if (!match || match[0].trim() !== trimmed) return null
  return imageFromMarkdown(match[1] ?? '', match[2] ?? '', match[3])
}

function imageFromMarkdown(alt: string, url: string, title?: string): DiscordContentImage {
  const dims = title?.match(/=\s*(\d+)\s*x\s*(\d+)/i)
  return {
    url,
    alt: alt.trim() || undefined,
    width: dims ? Number(dims[1]) : undefined,
    height: dims ? Number(dims[2]) : undefined,
  }
}

function isTinyImage(image: DiscordContentImage): boolean {
  if (image.width == null || image.height == null) return false
  return image.width < MIN_USEFUL_IMAGE_PX && image.height < MIN_USEFUL_IMAGE_PX
}

function parseMarkdownTable(
  lines: string[],
  start: number,
): { text: string; end: number } | null {
  if (start + 1 >= lines.length) return null
  const headerLine = lines[start] ?? ''
  const sepLine = lines[start + 1] ?? ''
  if (!looksLikeTableRow(headerLine) || !isTableSeparator(sepLine)) return null

  const rows = [splitTableRow(headerLine)]
  let i = start + 2
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (!looksLikeTableRow(line) || isTableSeparator(line)) break
    const cells = splitTableRow(line)
    if (cells.some((cell) => cell.length > 0)) rows.push(cells)
    i += 1
  }

  if (rows.length < 2) return null
  const text = formatTable(rows)
  return text ? { text, end: i } : { text: '', end: i }
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  return trimmed.split('|').length >= 2
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|?\s*$/.test(line)
}

function splitTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((cell) => unwrapBold(cell.trim()))
}

function formatTable(rows: string[][]): string {
  const headers = rows[0] ?? []
  const data = rows.slice(1)
  if (headers.length === 2) return formatTwoColumnTable(headers, data)

  const lines: string[] = []
  for (const row of data) {
    const label = (row[0] ?? '').trim()
    const parts: { header: string; value: string }[] = []
    for (let col = 1; col < headers.length; col++) {
      const value = (row[col] ?? '').trim()
      if (!value || value === '-') continue
      parts.push({ header: (headers[col] ?? '').trim(), value })
    }
    if (!label && parts.length === 0) continue
    lines.push(formatMultiColumnRow(label, parts))
  }
  return lines.join('\n')
}

function formatTwoColumnTable(headers: string[], data: string[][]): string {
  const left = (headers[0] ?? '').trim()
  const right = (headers[1] ?? '').trim()
  const titled = GENERIC_TABLE_HEADER.test(left) && right && !GENERIC_TABLE_HEADER.test(right)
  const lines: string[] = []

  for (const row of data) {
    const key = (row[0] ?? '').trim()
    const value = (row[1] ?? '').trim()
    if (!key && !value) continue
    if (!value || value === '-') continue
    lines.push(key ? `• **${key}** — ${value}` : `• ${value}`)
  }

  if (lines.length === 0) return ''
  return titled ? `**${right}**\n${lines.join('\n')}` : lines.join('\n')
}

function formatMultiColumnRow(label: string, parts: { header: string; value: string }[]): string {
  if (parts.length === 0) return label ? `**${label}**` : ''
  const values = parts.map((part) => part.value)
  const allSame = values.every((value) => value === values[0])
  if (allSame && parts.length > 1 && /^[\dxTBm.\s]+$/i.test(values[0] ?? '')) {
    return label ? `**${label}** — ${values[0]} each` : `${values[0]} each`
  }
  const cells = parts.map((part) => (part.header ? `${part.header} ${part.value}` : part.value))
  const joined = cells.join(' · ')
  return label ? `**${label}** — ${joined}` : joined
}

function htmlTableToDiscord(tableHtml: string): string {
  const rows: string[][] = []
  for (const rowMatch of tableHtml.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)) {
    const cells: string[] = []
    for (const cellMatch of rowMatch[0].matchAll(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi)) {
      cells.push(
        unwrapBold(
          decodeEntities(cellMatch[0].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''))
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      )
    }
    if (cells.some((cell) => cell.length > 0)) rows.push(cells)
  }
  if (rows.length < 2) return ''
  return formatTable(rows)
}

function placeholderTextToBlocks(raw: string, images: DiscordContentImage[]): DiscordContentBlock[] {
  const blocks: DiscordContentBlock[] = []
  const parts = raw.split(IMAGE_PLACEHOLDER_RE)
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const image = images[Number(parts[i])]
      if (image && !isTinyImage(image)) blocks.push({ type: 'image', image })
      continue
    }
    const text = collapseBlankLines(parts[i] ?? '')
    if (text) blocks.push({ type: 'text', text })
  }
  return mergeAdjacentTextBlocks(blocks)
}

function mergeAdjacentTextBlocks(blocks: DiscordContentBlock[]): DiscordContentBlock[] {
  const merged: DiscordContentBlock[] = []
  for (const block of blocks) {
    const prev = merged[merged.length - 1]
    if (block.type === 'text' && prev?.type === 'text') {
      prev.text = `${prev.text}\n\n${block.text}`
    } else {
      merged.push(block)
    }
  }
  return merged
}

function collapseBlankLines(raw: string): string {
  return raw.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function unwrapBold(s: string): string {
  return s.trim().replace(/^\*\*(.+)\*\*$/s, '$1').trim()
}

function attrValue(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return match?.[1] ?? match?.[2]
}

function absolutizeDocsUrl(src: string): string | null {
  if (/^https?:\/\//i.test(src)) return src
  if (src.startsWith('//')) return `https:${src}`
  if (!src.startsWith('/')) return null
  return `https://docs.thedigitalodyssey.com${src}`
}

function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n)
      return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16)
      return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''
    })
}
