import type {
  HyperliquidPerpSignal,
  OhlcCandle,
  WatchedWalletPosition,
  WatchedWalletSnapshot,
} from '../../shared/types.js'

const HL_INFO_URL = 'https://api.hyperliquid.xyz/info'
const FEATURED_COINS = ['BTC', 'ETH', 'SOL', 'HYPE']

export const DEFAULT_WATCHED_HL_ADDRESS = '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00'

export const WATCHED_WALLET_PRESETS: ReadonlyArray<{ address: string; label: string }> = [
  {
    address: '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00',
    label: 'HL Multi-Asset Whale',
  },
  {
    address: '0xf5d81a135f756ca16544e53c20fc20643ec3ad53',
    label: 'HL Quant Desk',
  },
  {
    address: '0xdf9ea6ec3b7109935ccb4fb267e15ac1fb077ab1',
    label: 'HL High-Lev HYPE',
  },
]

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

interface RawCandle {
  t: number
  T?: number
  o: string
  h: string
  l: string
  c: string
  v: string
}

export interface RawClearinghouseState {
  marginSummary?: {
    accountValue?: string
    totalNtlPos?: string
    totalRawUsd?: string
    totalMarginUsed?: string
  }
  crossMarginSummary?: {
    accountValue?: string
    totalMarginUsed?: string
  }
  withdrawable?: string
  assetPositions?: Array<{
    type?: string
    position?: {
      coin?: string
      szi?: string
      leverage?: { type?: string; value?: number }
      entryPx?: string
      positionValue?: string
      unrealizedPnl?: string
      returnOnEquity?: string
      liquidationPx?: string | null
      cumFunding?: { sinceOpen?: string; allTime?: string }
    }
  }>
}

export function isValidEthAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim())
}

export function shortenAddress(address: string): string {
  const clean = address.trim()
  if (clean.length < 12) return clean
  return `${clean.slice(0, 6)}..${clean.slice(-4)}`
}

async function fetchJson<T>(url: string, body: unknown, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

async function fetchTopOfBook(
  coin: string,
): Promise<{ bestBid: number | null; bestAsk: number | null; spreadBps: number | null }> {
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

export async function fetchCandles15m(coin: string, count = 24): Promise<OhlcCandle[]> {
  try {
    const endTime = Date.now()
    const startTime = endTime - (count + 4) * 15 * 60 * 1000
    const raw = await fetchJson<RawCandle[]>(
      HL_INFO_URL,
      {
        type: 'candleSnapshot',
        req: { coin, interval: '15m', startTime, endTime },
      },
      6000,
    )
    if (!Array.isArray(raw)) return []
    const parsed: OhlcCandle[] = []
    for (const c of raw) {
      const o = Number(c.o)
      const h = Number(c.h)
      const l = Number(c.l)
      const cl = Number(c.c)
      const v = Number(c.v ?? 0)
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(cl)) {
        continue
      }
      parsed.push({ t: Number(c.t), o, h, l, c: cl, v: Number.isFinite(v) ? v : 0 })
    }
    return parsed.slice(-count)
  } catch {
    return []
  }
}

export function synthesizeFallbackCandles(
  markPx: number,
  prevDayPx: number,
  count = 24,
  now = Date.now(),
): OhlcCandle[] {
  const startPx = prevDayPx > 0 ? prevDayPx : markPx * 0.992
  const out: OhlcCandle[] = []
  let prev = startPx
  const stepMs = 15 * 60 * 1000
  const seed = Math.round(markPx * 10) % 97

  for (let i = 0; i < count; i += 1) {
    const progress = (i + 1) / count
    const target = startPx + (markPx - startPx) * progress
    const wave = Math.sin((i + seed) * 0.65) * markPx * 0.0022
    const close = i === count - 1 ? markPx : Number((target + wave).toFixed(4))
    const open = Number(prev.toFixed(4))
    const wickSpread = Math.abs(close - open) * 0.65 + markPx * 0.0009
    const high = Number((Math.max(open, close) + wickSpread * 0.7).toFixed(4))
    const low = Number(Math.max(0.0001, Math.min(open, close) - wickSpread * 0.65).toFixed(4))
    out.push({
      t: now - (count - 1 - i) * stepMs,
      o: open,
      h: high,
      l: low,
      c: close,
      v: Number((100 + Math.abs(Math.cos(i + seed)) * 380).toFixed(2)),
    })
    prev = close
  }
  return out
}

function classifyHyperliquidAlert(
  change24hPct: number,
  fundingAprPct: number,
  volume24hUsd: number,
): string {
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
  markMap: Map<string, number>
  candlesLoaded: boolean
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
  const markMap = new Map<string, number>()

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
    if (!Number.isFinite(markPx) || markPx <= 0) continue

    markMap.set(coin, markPx)
    if (volume24hUsd <= 0) continue

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
      candles15m: [],
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

  // Concurrently enrich L2 top-of-book spreads AND live 15m OHLC candles
  const [l2Results, candleResults] = await Promise.all([
    Promise.all(topFive.slice(0, 4).map((item) => fetchTopOfBook(item.coin))),
    Promise.all(topFive.map((item) => fetchCandles15m(item.coin, 24))),
  ])

  let candlesLoaded = false
  for (let i = 0; i < topFive.length; i += 1) {
    const l2 = l2Results[i] ?? { bestBid: null, bestAsk: null, spreadBps: null }
    const rawCandles = candleResults[i] ?? []
    if (rawCandles.length >= 6) {
      candlesLoaded = true
    }
    const candles15m =
      rawCandles.length >= 6
        ? rawCandles
        : synthesizeFallbackCandles(topFive[i].markPx, topFive[i].prevDayPx, 24, now)

    topFive[i] = {
      ...topFive[i],
      ...l2,
      candles15m,
    }
  }

  return {
    signals: topFive,
    markMap,
    candlesLoaded,
    latencyMs: Date.now() - started,
  }
}

export function parseClearinghouseState(
  address: string,
  label: string,
  raw: RawClearinghouseState,
  markMap: Map<string, number>,
  now = Date.now(),
): WatchedWalletSnapshot {
  const accountValueUsd = Number(raw.marginSummary?.accountValue ?? raw.crossMarginSummary?.accountValue ?? 0)
  const totalMarginUsedUsd = Number(
    raw.marginSummary?.totalMarginUsed ?? raw.crossMarginSummary?.totalMarginUsed ?? 0,
  )
  const withdrawableUsd = Number(raw.withdrawable ?? 0)
  const marginRatioPct =
    accountValueUsd > 0 ? Number(((totalMarginUsedUsd / accountValueUsd) * 100).toFixed(2)) : 0

  const positions: WatchedWalletPosition[] = []
  let totalUnrealizedPnlUsd = 0

  for (const wrapper of raw.assetPositions ?? []) {
    const pos = wrapper?.position
    if (!pos?.coin) continue
    const rawSzi = Number(pos.szi ?? 0)
    if (!Number.isFinite(rawSzi) || Math.abs(rawSzi) < 1e-10) continue

    const side: 'LONG' | 'SHORT' = rawSzi > 0 ? 'LONG' : 'SHORT'
    const size = Math.abs(rawSzi)
    const entryPx = Number(pos.entryPx ?? 0)
    const positionValueUsd = Math.abs(Number(pos.positionValue ?? 0))
    const markPx =
      markMap.get(pos.coin) ??
      (size > 0 && positionValueUsd > 0 ? positionValueUsd / size : entryPx)
    const unrealizedPnlUsd = Number(pos.unrealizedPnl ?? 0)
    const returnOnEquityPct = Number((Number(pos.returnOnEquity ?? 0) * 100).toFixed(2))
    const rawLiq = pos.liquidationPx != null ? Number(pos.liquidationPx) : null
    const liquidationPx = rawLiq && Number.isFinite(rawLiq) && rawLiq > 0 ? rawLiq : null

    let liqDistancePct: number | null = null
    if (liquidationPx !== null && markPx > 0) {
      const dist =
        side === 'LONG'
          ? ((markPx - liquidationPx) / markPx) * 100
          : ((liquidationPx - markPx) / markPx) * 100
      liqDistancePct = Number(Math.max(0, dist).toFixed(2))
    }

    const leverage = Number(pos.leverage?.value ?? 1)
    const leverageType: 'cross' | 'isolated' =
      pos.leverage?.type === 'isolated' ? 'isolated' : 'cross'
    const cumFundingUsd = Number(pos.cumFunding?.sinceOpen ?? 0)

    totalUnrealizedPnlUsd += unrealizedPnlUsd
    positions.push({
      coin: pos.coin,
      side,
      size: Number(size.toFixed(4)),
      leverage,
      leverageType,
      entryPx,
      markPx,
      positionValueUsd: Number(positionValueUsd.toFixed(2)),
      unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
      returnOnEquityPct,
      liquidationPx,
      liqDistancePct,
      cumFundingUsd: Number(cumFundingUsd.toFixed(2)),
    })
  }

  // Prioritize majors and largest live notional exposure
  const majorRank = (coin: string) => {
    const idx = FEATURED_COINS.indexOf(coin)
    return idx >= 0 ? idx : 99
  }
  positions.sort((a, b) => {
    const aMajor = majorRank(a.coin) < 99 ? 1 : 0
    const bMajor = majorRank(b.coin) < 99 ? 1 : 0
    if (aMajor !== bMajor) return bMajor - aMajor
    return b.positionValueUsd - a.positionValueUsd
  })

  return {
    address: address.trim(),
    label: label.trim() || shortenAddress(address),
    status: positions.length > 0 || accountValueUsd > 0 ? 'live' : 'empty',
    accountValueUsd: Number(accountValueUsd.toFixed(2)),
    totalMarginUsedUsd: Number(totalMarginUsedUsd.toFixed(2)),
    marginRatioPct,
    totalUnrealizedPnlUsd: Number(totalUnrealizedPnlUsd.toFixed(2)),
    withdrawableUsd: Number(withdrawableUsd.toFixed(2)),
    positions: positions.slice(0, 12),
    updatedAt: now,
  }
}

export async function fetchLiveClearinghouseState(
  address: string,
  label: string,
  markMap: Map<string, number> = new Map(),
): Promise<WatchedWalletSnapshot> {
  const clean = address.trim()
  if (!isValidEthAddress(clean)) {
    throw new Error('Invalid 0x Ethereum/Hyperliquid address')
  }
  const raw = await fetchJson<RawClearinghouseState>(
    HL_INFO_URL,
    { type: 'clearinghouseState', user: clean },
    7000,
  )
  return parseClearinghouseState(clean, label, raw, markMap, Date.now())
}
