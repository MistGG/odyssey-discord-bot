export function likelyHtmlReleaseNotes(s: string): boolean {
  if (!s.includes('<')) return false
  if (/<\/[a-z][\s\S]*?>/i.test(s)) return true
  return /<(?:br|p|div|span|ul|ol|li|h[1-6]|strong|em|a|table|tr|td|th|pre|code)\b/i.test(
    s,
  )
}

export function stripHtmlToPlainText(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (!likelyHtmlReleaseNotes(s)) return raw

  return s
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|section|article|blockquote|header|footer)>/gi, '\n\n')
    .replace(/<\/(li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
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
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Convert Outline markdown into Discord-embed-friendly text. */
export function outlineMarkdownToDiscord(raw: string): string {
  const s = raw.replace(/\r\n/g, '\n').trim()
  if (!s) return ''

  return s
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\d+\.\s+/gm, (match) => match.trimStart())
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '[$1]($2)')
    .replace(/\n{3,}/g, '\n\n')
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
    const breakAt =
      lastIndexOfAny(window, ['\n\n', '\n', ' ']) > max * 0.5
        ? lastIndexOfAny(window, ['\n\n', '\n', ' '])
        : max

    chunks.push(remaining.slice(0, breakAt).trimEnd())
    remaining = remaining.slice(breakAt).trimStart()
  }

  if (remaining) chunks.push(remaining)
  return chunks
}

function lastIndexOfAny(text: string, separators: string[]): number {
  let best = -1
  for (const sep of separators) {
    const idx = text.lastIndexOf(sep)
    if (idx > best) best = idx
  }
  return best
}
