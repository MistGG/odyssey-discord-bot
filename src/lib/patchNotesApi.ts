import {
  composePatchNoteBody,
  docSlugFromUrl,
  latestReleaseFromShareTree,
  parseOutlineDocPage,
  parseOutlineDocSummary,
  parsePatchNotesSitemap,
  type OutlineShareTreeNode,
  type PatchNoteEntry,
  type PatchNoteSection,
} from './patchNotes.js'

export const PATCH_NOTES_SHARE_ID = '2bb157c9-224d-48ab-a6f2-697589ebe97a'

export const PATCH_NOTES_INDEX_URL = `https://docs.thedigitalodyssey.com/s/${PATCH_NOTES_SHARE_ID}/?theme=dark`

const SITEMAP_URL = `https://docs.thedigitalodyssey.com/api/shares.sitemap?id=${PATCH_NOTES_SHARE_ID}`
const SHARES_INFO_URL = 'https://docs.thedigitalodyssey.com/api/shares.info'
const DOCUMENTS_INFO_URL = 'https://docs.thedigitalodyssey.com/api/documents.info'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const FETCH_HEADERS = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'User-Agent': USER_AGENT,
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
} as const

const JSON_HEADERS = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'User-Agent': USER_AGENT,
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
} as const

const FETCH_TIMEOUT_MS = 20_000

let sitemapInFlight: Promise<string[]> | null = null
let shareTreeInFlight: Promise<OutlineShareTreeNode> | null = null

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...FETCH_HEADERS, ...init?.headers },
      cache: 'no-store',
    } as RequestInit)
  } finally {
    clearTimeout(timer)
  }
}

function absoluteDocUrl(docPathOrUrl: string): string {
  if (docPathOrUrl.startsWith('http://') || docPathOrUrl.startsWith('https://')) {
    return docPathOrUrl
  }
  const path = docPathOrUrl.startsWith('/') ? docPathOrUrl : `/${docPathOrUrl}`
  return `https://docs.thedigitalodyssey.com/s/${PATCH_NOTES_SHARE_ID}${path}`
}

async function fetchSitemapDocUrls(): Promise<string[]> {
  if (sitemapInFlight) return sitemapInFlight

  sitemapInFlight = (async () => {
    const cacheBustUrl = `${SITEMAP_URL}&_=${Date.now()}`
    const res = await fetchWithTimeout(cacheBustUrl)
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

async function fetchShareTree(): Promise<OutlineShareTreeNode> {
  if (shareTreeInFlight) return shareTreeInFlight

  shareTreeInFlight = (async () => {
    const res = await fetchWithTimeout(SHARES_INFO_URL, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ id: PATCH_NOTES_SHARE_ID }),
    })
    if (!res.ok) {
      throw new Error(`Patch notes shares.info returned ${res.status}`)
    }
    const json = (await res.json()) as {
      ok?: boolean
      data?: { sharedTree?: OutlineShareTreeNode }
    }
    const tree = json.data?.sharedTree
    if (!tree?.children?.length) {
      throw new Error('No patch notes found in docs share tree')
    }
    return tree
  })()

  try {
    return await shareTreeInFlight
  } finally {
    shareTreeInFlight = null
  }
}

async function fetchDocumentText(documentId: string): Promise<{ title: string; text: string }> {
  const res = await fetchWithTimeout(DOCUMENTS_INFO_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id: documentId, shareId: PATCH_NOTES_SHARE_ID }),
  })
  if (!res.ok) {
    throw new Error(`documents.info returned ${res.status} for ${documentId}`)
  }
  const json = (await res.json()) as {
    ok?: boolean
    data?: { title?: string; text?: string }
  }
  return {
    title: json.data?.title?.trim() || 'Patch note',
    text: json.data?.text ?? '',
  }
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

async function buildReleaseEntry(release: OutlineShareTreeNode): Promise<PatchNoteEntry> {
  const url = absoluteDocUrl(release.url)
  const id = docSlugFromUrl(release.url)
  const childNodes = release.children ?? []

  const [parentDoc, ...childDocs] = await Promise.all([
    fetchDocumentText(release.id),
    ...childNodes.map((child) => fetchDocumentText(child.id)),
  ])

  const sections: PatchNoteSection[] = []
  if (parentDoc.text.trim()) {
    sections.push({ title: null, text: parentDoc.text })
  }
  for (let i = 0; i < childNodes.length; i++) {
    const child = childNodes[i]!
    const doc = childDocs[i]!
    sections.push({
      title: doc.title || child.title || null,
      text: doc.text,
    })
  }

  let bodyText = composePatchNoteBody(sections)

  // Fallback for older flat docs / API gaps: scrape the HTML page.
  if (!bodyText) {
    try {
      const scraped = await fetchDocFull(url)
      bodyText = scraped.bodyText || scraped.bodyHtml
      return {
        id,
        title: parentDoc.title || release.title || scraped.title,
        url,
        preview: '',
        bodyText: scraped.bodyText,
        bodyHtml: scraped.bodyHtml,
      }
    } catch {
      // keep empty body; embed layer will fall back to link copy
    }
  }

  return {
    id,
    title: parentDoc.title || release.title || 'Patch note',
    url,
    preview: '',
    bodyText,
    bodyHtml: '',
  }
}

export async function fetchLatestPatchNoteMeta(): Promise<{ id: string; url: string } | null> {
  try {
    const tree = await fetchShareTree()
    const latest = latestReleaseFromShareTree(tree)
    if (!latest) return null
    return { id: docSlugFromUrl(latest.url), url: absoluteDocUrl(latest.url) }
  } catch {
    const urls = await fetchSitemapDocUrls()
    const url = urls[0]
    if (!url) return null
    return { id: docSlugFromUrl(url), url }
  }
}

export async function fetchPatchNoteDetail(url: string): Promise<PatchNoteEntry> {
  const safe = url.trim()
  if (!safe) throw new Error('Missing patch note URL')

  try {
    const tree = await fetchShareTree()
    const slug = docSlugFromUrl(safe)
    const release =
      tree.children?.find((node) => docSlugFromUrl(node.url) === slug) ??
      latestReleaseFromShareTree(tree)
    if (release && docSlugFromUrl(release.url) === slug) {
      return buildReleaseEntry(release)
    }
  } catch {
    // fall through to HTML scrape
  }

  return fetchDocFull(safe)
}

export async function fetchLatestPatchNoteDetail(): Promise<PatchNoteEntry> {
  try {
    const tree = await fetchShareTree()
    const latest = latestReleaseFromShareTree(tree)
    if (!latest) throw new Error('No patch notes available')
    return buildReleaseEntry(latest)
  } catch (err) {
    const meta = await fetchLatestPatchNoteMeta()
    if (!meta) throw err instanceof Error ? err : new Error('No patch notes available')
    return fetchDocFull(meta.url)
  }
}

export async function fetchLatestPatchNoteSummary(): Promise<PatchNoteEntry> {
  const meta = await fetchLatestPatchNoteMeta()
  if (!meta) throw new Error('No patch notes available')
  return fetchDocSummary(meta.url)
}
