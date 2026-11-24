import type { HyperliquidPerpSignal } from '../../shared/types.js'

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info'
const FEATURED_COINS = ['BTC', 'ETH', 'SOL', 'HYPE']

interface RawMetaUniverseItem {
  name: string
  szDecimals?: number
}

interface RawAssetCtx {
  funding?: string
  openInterest?: string
  prevDayPx?: string
  dayNtlVlm?: string
  markPx?: string
  midPx?: string
}

interface RawL2Book {
  levels?: [Array<{ px: string; sz: string }>, Array<{ px: string; sz: string }>]
}

async function fetchJson<T>(url: string, body: unknown, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PulseHUD-EvenG2/1.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      throw new Error(`Hyperliquid HTTP ${res.status}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTopOfBook(coin: string): Promise<{ bestBid: number | null; bestAsk: number | null; spreadBps: number | null }> {
  try {
    const book = await fetchJson<RawL2Book>(HL_INFO_URL, { type: 'l2Book', coin }, 5000)
    const bids = book.levels?.[0] ?? []
    const asks = book.levels?.[1] ?? []
    const bestBid = bids.length > 0 ? Number(bids[0].px) : null
    const bestAsk = asks.length > 0 ? Number(asks[0].px) : null
    if (bestBid && bestAsk && bestBid > 0 && bestAsk > 0) {
      const mid = (bestBid + bestAsk) / 2
      const spreadBps = Number((((bestAsk - bestBid) / mid) * 10000).toFixed(2))
      return { bestBid, bestAsk, spreadBps }
    }
    return { bestBid, bestAsk, spreadBps: null }
  } catch {
    return { bestBid: null, bestAsk: null, spreadBps: null }
  }
}

function classifyHyperliquidAlert(change24hPct: number, fundingAprPct: number, volume24hUsd: number): string {
  if (Math.abs(fundingAprPct) >= 20) {
    return fundingAprPct > 0 ? 'FUNDING HOT' : 'NEG FUNDING'
  }
  if (Math.abs(change24hPct) >= 4) {
    return change24hPct > 0 ? 'BREAKOUT UP' : 'SHARP DIP'
  }
  if (volume24hUsd >= 1_000_000_000) {
    return 'TOP LIQUIDITY'
  }
  return fundingAprPct >= 0 ? 'LONG BIAS' : 'SHORT BIAS'
}

export async function fetchLiveHyperliquidSignals(): Promise<{
  signals: HyperliquidPerpSignal[]
  latencyMs: number
}> {
  const started = Date.now()
  const payload = await fetchJson<[{ universe: RawMetaUniverseItem[] }, RawAssetCtx[]]>(
    HL_INFO_URL,
    { type: 'metaAndAssetCtxs' },
    8500,
  )

  const universe = payload[0]?.universe ?? []
  const ctxs = payload[1] ?? []
  const now = Date.now()

  const parsed: HyperliquidPerpSignal[] = []
  for (let i = 0; i < Math.min(universe.length, ctxs.length); i += 1) {
    const coin = universe[i]?.name
    const ctx = ctxs[i]
    if (!coin || !ctx) continue
    const markPx = Number(ctx.markPx ?? ctx.midPx ?? 0)
    const prevDayPx = Number(ctx.prevDayPx ?? markPx)
    const volume24hUsd = Number(ctx.dayNtlVlm ?? 0)
    const openInterestCoins = Number(ctx.openInterest ?? 0)
    const fundingHourly = Number(ctx.funding ?? 0)
    if (!Number.isFinite(markPx) || markPx <= 0 || volume24hUsd <= 0) continue

    const change24hPct = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0
    const fundingAprPct = fundingHourly * 24 * 365 * 100
    const openInterestUsd = openInterestCoins * markPx

    parsed.push({
      id: `hl-${coin.toLowerCase()}`,
      kind: 'hyperliquid',
      coin,
      markPx,
      prevDayPx,
      change24hPct: Number(change24hPct.toFixed(2)),
      fundingHourly,
      fundingAprPct: Number(fundingAprPct.toFixed(1)),
      openInterestUsd: Math.round(openInterestUsd),
      volume24hUsd: Math.round(volume24hUsd),
      bestBid: null,
      bestAsk: null,
      spreadBps: null,
      alertTag: classifyHyperliquidAlert(change24hPct, fundingAprPct, volume24hUsd),
      updatedAt: now,
    })
  }

  // Pick featured liquid majors + highest funding anomaly outside majors
  const selected: HyperliquidPerpSignal[] = []
  const seen = new Set<string>()
  for (const coin of FEATURED_COINS) {
    const found = parsed.find((p) => p.coin === coin)
    if (found) {
      selected.push(found)
      seen.add(found.coin)
    }
  }

  const fundingMover = parsed
    .filter((p) => !seen.has(p.coin) && p.volume24hUsd >= 15_000_000)
    .sort((a, b) => Math.abs(b.fundingAprPct) - Math.abs(a.fundingAprPct))[0]
  if (fundingMover) {
    selected.push({
      ...fundingMover,
      alertTag: Math.abs(fundingMover.fundingAprPct) >= 15 ? 'FUNDING SPIKE' : fundingMover.alertTag,
    })
  }

  const topFive = selected.slice(0, 5)

  // Enrich top 3 with real L2 top-of-book spreads concurrently
  const l2Results = await Promise.all(topFive.slice(0, 3).map((item) => fetchTopOfBook(item.coin)))
  for (let i = 0; i < l2Results.length; i += 1) {
    topFive[i] = {
      ...topFive[i],
      ...l2Results[i],
    }
  }

  return {
    signals: topFive,
    latencyMs: Date.now() - started,
  }
}
