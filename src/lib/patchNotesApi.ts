import {
  parseOutlineDocPage,
  parseOutlineDocSummary,
  parsePatchNotesSitemap,
  type PatchNoteEntry,
} from './patchNotes.js'

export const PATCH_NOTES_SHARE_ID = '2bb157c9-224d-48ab-a6f2-697589ebe97a'

export const PATCH_NOTES_INDEX_URL = `https://docs.thedigitalodyssey.com/s/${PATCH_NOTES_SHARE_ID}/?theme=dark`

const SITEMAP_URL = `https://docs.thedigitalodyssey.com/api/shares.sitemap?id=${PATCH_NOTES_SHARE_ID}`

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'User-Agent': USER_AGENT,
} as const

const FETCH_TIMEOUT_MS = 20_000

let sitemapInFlight: Promise<string[]> | null = null

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: FETCH_HEADERS })
  } finally {
    clearTimeout(timer)
  }
}

function docIdFromUrl(url: string): string {
  return url.split('/doc/')[1]?.replace(/\/$/, '') ?? url
}

async function fetchSitemapDocUrls(): Promise<string[]> {
  if (sitemapInFlight) return sitemapInFlight

  sitemapInFlight = (async () => {
    const res = await fetchWithTimeout(SITEMAP_URL)
    if (!res.ok) {
      throw new Error(`Patch notes sitemap returned ${res.status}`)
    }
    const xml = await res.text()
    const urls = parsePatchNotesSitemap(xml)
    if (urls.length === 0) {
      throw new Error('No patch notes found in docs sitemap')
    }
    return urls
  })()

  try {
    return await sitemapInFlight
  } finally {
    sitemapInFlight = null
  }
}

export async function fetchLatestPatchNoteMeta(): Promise<{ id: string; url: string } | null> {
  const urls = await fetchSitemapDocUrls()
  const url = urls[0]
  if (!url) return null
  return { id: docIdFromUrl(url), url }
}

async function fetchDocSummary(url: string): Promise<PatchNoteEntry> {
  const res = await fetchWithTimeout(url)
  if (!res.ok) {
    throw new Error(`Patch note returned ${res.status}`)
  }
  const html = await res.text()
  return parseOutlineDocSummary(html, url)
}

async function fetchDocFull(url: string): Promise<PatchNoteEntry> {
  const res = await fetchWithTimeout(url)
  if (!res.ok) {
    throw new Error(`Patch note returned ${res.status}`)
  }
  const html = await res.text()
  return parseOutlineDocPage(html, url)
}

export async function fetchPatchNoteDetail(url: string): Promise<PatchNoteEntry> {
  const safe = url.trim()
  if (!safe) throw new Error('Missing patch note URL')
  return fetchDocFull(safe)
}

export async function fetchLatestPatchNoteDetail(): Promise<PatchNoteEntry> {
  const meta = await fetchLatestPatchNoteMeta()
  if (!meta) throw new Error('No patch notes available')
  return fetchDocFull(meta.url)
}

export async function fetchLatestPatchNoteSummary(): Promise<PatchNoteEntry> {
  const meta = await fetchLatestPatchNoteMeta()
  if (!meta) throw new Error('No patch notes available')
  return fetchDocSummary(meta.url)
}
