import type { PolymarketOddsSignal } from '../../shared/types.js'

const GAMMA_EVENTS_BASE = 'https://gamma-api.polymarket.com/events'
const CLOB_BASE = 'https://clob.polymarket.com'

interface RawGammaMarket {
  id: string
  question?: string
  active?: boolean
  closed?: boolean
  enableOrderBook?: boolean
  outcomePrices?: string
  clobTokenIds?: string
  oneDayPriceChange?: number | string | null
  volume24hr?: number | string | null
}

interface RawGammaEvent {
  title?: string
  tags?: Array<{ slug?: string }>
  markets?: RawGammaMarket[]
}

interface RawClobBook {
  bids?: Array<{ price: string; size: string }>
  asks?: Array<{ price: string; size: string }>
}

async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'PulseHUD-EvenG2/1.0',
      },
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Polymarket HTTP ${res.status}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function condenseQuestion(question: string): string {
  const cleaned = question
    .replace(/^Will the price of /i, '')
    .replace(/^Will there be /i, '')
    .replace(/^Will the /i, '')
    .replace(/^Will /i, '')
    .replace(/Bitcoin/g, 'BTC')
    .replace(/Ethereum/g, 'ETH')
    .replace(/Solana/g, 'SOL')
    .replace(/Federal Reserve/gi, 'Fed')
    .replace(/interest rates/gi, 'rates')
    .replace(/by December 31, 2026\?/i, 'in 2026?')
    .replace(/after the December 2026 meeting\?/i, 'at Dec FOMC?')
    .trim()
  return cleaned ? cleaned[0].toUpperCase() + cleaned.slice(1) : cleaned
}

function parseJsonStringArray(raw?: string): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

async function fetchClobDetail(tokenId: string): Promise<{
  clobMidpoint: number | null
  bestBid: number | null
  bestAsk: number | null
  spreadCents: number | null
}> {
  try {
    const [midRes, bookRes] = await Promise.all([
      fetchJson<{ mid?: string }>(`${CLOB_BASE}/midpoint?token_id=${encodeURIComponent(tokenId)}`, 5000),
      fetchJson<RawClobBook>(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`, 5000),
    ])

    const clobMidpoint = midRes.mid ? Number(midRes.mid) : null
    const bidPrices = (bookRes.bids ?? []).map((b) => Number(b.price)).filter((n) => Number.isFinite(n) && n > 0)
    const askPrices = (bookRes.asks ?? []).map((a) => Number(a.price)).filter((n) => Number.isFinite(n) && n > 0)

    const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null
    const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null
    const spreadCents =
      bestBid !== null && bestAsk !== null && bestAsk >= bestBid
        ? Number(((bestAsk - bestBid) * 100).toFixed(1))
        : null

    return { clobMidpoint, bestBid, bestAsk, spreadCents }
  } catch {
    return { clobMidpoint: null, bestBid: null, bestAsk: null, spreadCents: null }
  }
}

function classifyPolymarketAlert(change24hCents: number, volume24hUsd: number): string {
  if (Math.abs(change24hCents) >= 5) {
    return change24hCents > 0 ? 'ODDS SURGE' : 'ODDS DROP'
  }
  if (volume24hUsd >= 500_000) {
    return 'HIGH VOLUME'
  }
  return 'ACTIVE BOOK'
}

export async function fetchLivePolymarketSignals(): Promise<{
  signals: PolymarketOddsSignal[]
  latencyMs: number
  clobVerified: boolean
}> {
  const started = Date.now()
  const now = Date.now()

  const [cryptoEvents, macroEvents] = await Promise.all([
    fetchJson<RawGammaEvent[]>(
      `${GAMMA_EVENTS_BASE}?active=true&closed=false&tag_slug=crypto&limit=16&order=volume24hr&ascending=false`,
      8500,
    ),
    fetchJson<RawGammaEvent[]>(
      `${GAMMA_EVENTS_BASE}?active=true&closed=false&tag_slug=economy&limit=8&order=volume24hr&ascending=false`,
      8500,
    ).catch(() => [] as RawGammaEvent[]),
  ])

  const combined = [...cryptoEvents, ...macroEvents]
  const candidates: PolymarketOddsSignal[] = []
  const seenEvents = new Set<string>()

  for (const event of combined) {
    const eventTitle = (event.title ?? '').trim()
    if (!eventTitle || seenEvents.has(eventTitle)) continue

    // Pick the highest-volume active binary orderbook market inside each event with informative odds
    const markets = (event.markets ?? [])
      .filter((m) => m.active && !m.closed && m.enableOrderBook && m.clobTokenIds)
      .sort((a, b) => Number(b.volume24hr ?? 0) - Number(a.volume24hr ?? 0))

    let chosen: PolymarketOddsSignal | null = null
    for (const m of markets) {
      const prices = parseJsonStringArray(m.outcomePrices).map(Number)
      const tokenIds = parseJsonStringArray(m.clobTokenIds)
      if (prices.length !== 2 || tokenIds.length < 1) continue
      const yes = prices[0]
      if (!Number.isFinite(yes) || yes < 0.05 || yes > 0.95) continue

      const vol24h = Math.round(Number(m.volume24hr ?? 0))
      const rawChange = Number(m.oneDayPriceChange ?? 0)
      const change24hCents = Number.isFinite(rawChange) ? Number((rawChange * 100).toFixed(1)) : 0
      const question = (m.question ?? eventTitle).trim()

      chosen = {
        id: `pm-${m.id}`,
        kind: 'polymarket',
        marketId: String(m.id),
        tokenId: tokenIds[0],
        eventTitle,
        question,
        shortTitle: condenseQuestion(question),
        yesPrice: Number(yes.toFixed(4)),
        noPrice: Number((1 - yes).toFixed(4)),
        clobMidpoint: null,
        bestBid: null,
        bestAsk: null,
        spreadCents: null,
        change24hCents,
        volume24hUsd: vol24h,
        alertTag: classifyPolymarketAlert(change24hCents, vol24h),
        updatedAt: now,
      }
      break
    }

    if (chosen) {
      seenEvents.add(eventTitle)
      candidates.push(chosen)
    }
  }

  // Sort to highlight meaningful 24h odds swings + liquid crypto/macro markets
  const topFive = candidates
    .sort((a, b) => {
      const scoreA = a.volume24hUsd + Math.abs(a.change24hCents) * 25_000
      const scoreB = b.volume24hUsd + Math.abs(b.change24hCents) * 25_000
      return scoreB - scoreA
    })
    .slice(0, 5)

  let clobVerified = false
  const clobDetails = await Promise.all(topFive.slice(0, 3).map((item) => fetchClobDetail(item.tokenId)))
  for (let i = 0; i < clobDetails.length; i += 1) {
    const detail = clobDetails[i]
    if (detail.clobMidpoint !== null) {
      clobVerified = true
      topFive[i] = {
        ...topFive[i],
        yesPrice: Number(detail.clobMidpoint.toFixed(4)),
        noPrice: Number((1 - detail.clobMidpoint).toFixed(4)),
        ...detail,
      }
    } else {
      topFive[i] = { ...topFive[i], ...detail }
    }
  }

  return {
    signals: topFive,
    latencyMs: Date.now() - started,
    clobVerified,
  }
}
