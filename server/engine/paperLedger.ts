import type {
  ExecutionReceipt,
  HyperliquidPerpSignal,
  PaperPosition,
  PolymarketOddsSignal,
  PortfolioSnapshot,
  StagedAction,
} from '../../shared/types.js'

const STARTING_EQUITY_USD = 25_000

export class PaperLedger {
  private cashUsd = STARTING_EQUITY_USD
  private realizedPnlUsd = 0
  private positions: PaperPosition[] = []
  private receipts: ExecutionReceipt[] = []
  private seeded = false

  /**
   * Seeds two small baseline paper positions once live prices arrive so the
   * user immediately sees real mark-to-market PnL on their very first glance.
   */
  public seedIfEmpty(hl: HyperliquidPerpSignal[], pm: PolymarketOddsSignal[]): void {
    if (this.seeded) return
    this.seeded = true
    const now = Date.now()

    const btc = hl.find((s) => s.coin === 'BTC') ?? hl[0]
    if (btc) {
      const entry = Number((btc.markPx * 0.992).toFixed(2))
      const notional = 2500
      const size = Number((notional / entry).toFixed(5))
      this.positions.push({
        id: `pos-hl-${btc.coin.toLowerCase()}`,
        venue: 'hyperliquid',
        symbol: `${btc.coin}-PERP`,
        side: 'LONG',
        size,
        entryPrice: entry,
        markPrice: btc.markPx,
        notionalUsd: notional,
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        openedAt: now - 1000 * 60 * 42,
      })
    }

    const topPm = pm[0]
    if (topPm) {
      const entry = Number(Math.max(0.05, Math.min(0.95, topPm.yesPrice - 0.04)).toFixed(4))
      const notional = 120
      const shares = Number((notional / entry).toFixed(2))
      this.cashUsd -= notional
      this.positions.push({
        id: `pos-pm-${topPm.marketId}`,
        venue: 'polymarket',
        symbol: topPm.shortTitle,
        side: 'YES',
        size: shares,
        entryPrice: entry,
        markPrice: topPm.yesPrice,
        notionalUsd: notional,
        unrealizedPnlUsd: 0,
        unrealizedPnlPct: 0,
        openedAt: now - 1000 * 60 * 25,
      })
    }

    this.markToMarket(hl, pm)
  }

  public markToMarket(hl: HyperliquidPerpSignal[], pm: PolymarketOddsSignal[]): void {
    const hlMap = new Map(hl.map((s) => [`${s.coin}-PERP`, s.markPx]))
    const pmMap = new Map(pm.map((s) => [s.shortTitle, s]))

    for (const pos of this.positions) {
      if (pos.venue === 'hyperliquid') {
        const mark = hlMap.get(pos.symbol)
        if (mark && mark > 0) {
          pos.markPrice = mark
        }
        const dir = pos.side === 'LONG' ? 1 : -1
        pos.unrealizedPnlUsd = Number(((pos.markPrice - pos.entryPrice) * pos.size * dir).toFixed(2))
        pos.notionalUsd = Number((pos.markPrice * pos.size).toFixed(2))
        pos.unrealizedPnlPct =
          pos.entryPrice > 0
            ? Number((((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100 * dir).toFixed(2))
            : 0
      } else {
        const market = pmMap.get(pos.symbol)
        if (market) {
          pos.markPrice = pos.side === 'YES' ? market.yesPrice : market.noPrice
        }
        const costBasis = pos.entryPrice * pos.size
        const currentValue = pos.markPrice * pos.size
        pos.notionalUsd = Number(currentValue.toFixed(2))
        pos.unrealizedPnlUsd = Number((currentValue - costBasis).toFixed(2))
        pos.unrealizedPnlPct =
          costBasis > 0 ? Number((((currentValue - costBasis) / costBasis) * 100).toFixed(2)) : 0
      }
    }
  }

  public executeTradeAction(
    action: StagedAction,
    hl: HyperliquidPerpSignal[],
    pm: PolymarketOddsSignal[],
  ): { receipt: ExecutionReceipt; toast: string } {
    const now = Date.now()

    if (action.type === 'hl_paper_long' || action.type === 'hl_paper_short') {
      const coin = (action.coin ?? 'BTC').toUpperCase()
      const market = hl.find((s) => s.coin === coin) ?? hl[0]
      if (!market) {
        throw new Error(`Hyperliquid market ${coin} unavailable`)
      }
      const side = action.type === 'hl_paper_long' ? 'LONG' : 'SHORT'
      const notional = Math.max(50, Math.min(10_000, action.notionalUsd ?? 1000))
      const fillPrice =
        side === 'LONG' ? (market.bestAsk ?? market.markPx) : (market.bestBid ?? market.markPx)
      const qty = Number((notional / fillPrice).toFixed(5))
      const symbol = `${market.coin}-PERP`

      const existingIdx = this.positions.findIndex(
        (p) => p.venue === 'hyperliquid' && p.symbol === symbol,
      )

      if (existingIdx >= 0) {
        const existing = this.positions[existingIdx]
        if (existing.side === side) {
          const totalSize = existing.size + qty
          const avgEntry = (existing.entryPrice * existing.size + fillPrice * qty) / totalSize
          existing.size = Number(totalSize.toFixed(5))
          existing.entryPrice = Number(avgEntry.toFixed(4))
        } else {
          // Reducing or flipping an opposing paper perp position
          const closedQty = Math.min(existing.size, qty)
          const dir = existing.side === 'LONG' ? 1 : -1
          const pnl = (fillPrice - existing.entryPrice) * closedQty * dir
          this.realizedPnlUsd = Number((this.realizedPnlUsd + pnl).toFixed(2))
          this.cashUsd = Number((this.cashUsd + pnl).toFixed(2))

          const remaining = existing.size - qty
          if (Math.abs(remaining) < 1e-6) {
            this.positions.splice(existingIdx, 1)
          } else if (remaining > 0) {
            existing.size = Number(remaining.toFixed(5))
          } else {
            existing.side = side
            existing.size = Number(Math.abs(remaining).toFixed(5))
            existing.entryPrice = fillPrice
          }
        }
      } else {
        this.positions.unshift({
          id: `pos-hl-${market.coin.toLowerCase()}-${now}`,
          venue: 'hyperliquid',
          symbol,
          side,
          size: qty,
          entryPrice: fillPrice,
          markPrice: market.markPx,
          notionalUsd: notional,
          unrealizedPnlUsd: 0,
          unrealizedPnlPct: 0,
          openedAt: now,
        })
      }

      this.markToMarket(hl, pm)
      const receipt: ExecutionReceipt = {
        id: `rcpt-${now}`,
        timestamp: now,
        type: action.type,
        title: `PAPER ${side} ${market.coin}`,
        detail: `${qty} ${market.coin} @ $${formatNumber(fillPrice)} ($${notional} notional)`,
        venue: 'hyperliquid-paper',
        deliveredExternal: false,
      }
      this.receipts.unshift(receipt)
      this.receipts = this.receipts.slice(0, 30)
      return {
        receipt,
        toast: `FILLED: PAPER ${side} ${market.coin} @ $${formatNumber(fillPrice)}`,
      }
    }

    if (action.type === 'hl_flatten') {
      const target =
        this.positions.find(
          (p) =>
            p.venue === 'hyperliquid' &&
            (!action.coin || p.symbol === `${action.coin.toUpperCase()}-PERP`),
        ) ?? this.positions[0]

      if (!target) {
        const receipt: ExecutionReceipt = {
          id: `rcpt-${now}`,
          timestamp: now,
          type: 'hl_flatten',
          title: 'PAPER FLATTEN',
          detail: 'No open positions to close',
          venue: 'hyperliquid-paper',
          deliveredExternal: false,
        }
        this.receipts.unshift(receipt)
        return { receipt, toast: 'Portfolio already flat' }
      }

      this.markToMarket(hl, pm)
      const pnl = target.unrealizedPnlUsd
      this.realizedPnlUsd = Number((this.realizedPnlUsd + pnl).toFixed(2))
      if (target.venue === 'polymarket') {
        this.cashUsd = Number((this.cashUsd + target.notionalUsd).toFixed(2))
      } else {
        this.cashUsd = Number((this.cashUsd + pnl).toFixed(2))
      }
      this.positions = this.positions.filter((p) => p.id !== target.id)

      const sign = pnl >= 0 ? '+' : ''
      const receipt: ExecutionReceipt = {
        id: `rcpt-${now}`,
        timestamp: now,
        type: 'hl_flatten',
        title: `CLOSED ${target.symbol}`,
        detail: `Paper exit ${target.side} @ ${target.venue === 'polymarket' ? `${Math.round(target.markPrice * 100)}c` : `$${formatNumber(target.markPrice)}`} (${sign}$${pnl.toFixed(2)})`,
        venue: target.venue === 'polymarket' ? 'polymarket-paper' : 'hyperliquid-paper',
        deliveredExternal: false,
      }
      this.receipts.unshift(receipt)
      this.receipts = this.receipts.slice(0, 30)
      return {
        receipt,
        toast: `CLOSED ${target.symbol} (${sign}$${pnl.toFixed(2)})`,
      }
    }

    if (action.type === 'pm_paper_yes' || action.type === 'pm_paper_no') {
      const market = pm.find((m) => m.marketId === action.marketId || m.id === action.signalId) ?? pm[0]
      if (!market) {
        throw new Error('Polymarket market unavailable')
      }
      const side = action.type === 'pm_paper_yes' ? 'YES' : 'NO'
      const stake = Math.max(10, Math.min(2000, action.notionalUsd ?? 50))
      const price = side === 'YES' ? (market.bestAsk ?? market.yesPrice) : market.noPrice
      const clampedPrice = Math.max(0.02, Math.min(0.98, price))
      const shares = Number((stake / clampedPrice).toFixed(2))

      this.cashUsd = Number((this.cashUsd - stake).toFixed(2))
      const existing = this.positions.find(
        (p) => p.venue === 'polymarket' && p.symbol === market.shortTitle && p.side === side,
      )
      if (existing) {
        const totalShares = existing.size + shares
        const avgEntry = (existing.entryPrice * existing.size + clampedPrice * shares) / totalShares
        existing.size = Number(totalShares.toFixed(2))
        existing.entryPrice = Number(avgEntry.toFixed(4))
      } else {
        this.positions.unshift({
          id: `pos-pm-${market.marketId}-${side.toLowerCase()}-${now}`,
          venue: 'polymarket',
          symbol: market.shortTitle,
          side,
          size: shares,
          entryPrice: clampedPrice,
          markPrice: clampedPrice,
          notionalUsd: stake,
          unrealizedPnlUsd: 0,
          unrealizedPnlPct: 0,
          openedAt: now,
        })
      }

      this.markToMarket(hl, pm)
      const cents = Math.round(clampedPrice * 100)
      const receipt: ExecutionReceipt = {
        id: `rcpt-${now}`,
        timestamp: now,
        type: action.type,
        title: `PAPER ${side} $${stake}`,
        detail: `${shares} sh @ ${cents}c on "${market.shortTitle}"`,
        venue: 'polymarket-paper',
        deliveredExternal: false,
      }
      this.receipts.unshift(receipt)
      this.receipts = this.receipts.slice(0, 30)
      return {
        receipt,
        toast: `FILLED: PAPER ${side} $${stake} @ ${cents}c`,
      }
    }

    throw new Error(`Unsupported paper trade action: ${action.type}`)
  }

  public recordExternalReceipt(receipt: ExecutionReceipt): void {
    this.receipts.unshift(receipt)
    this.receipts = this.receipts.slice(0, 30)
  }

  public snapshot(): PortfolioSnapshot {
    const unrealizedPnlUsd = Number(
      this.positions.reduce((acc, p) => acc + p.unrealizedPnlUsd, 0).toFixed(2),
    )
    const pmValue = this.positions
      .filter((p) => p.venue === 'polymarket')
      .reduce((acc, p) => acc + p.notionalUsd, 0)
    const hlUnrealized = this.positions
      .filter((p) => p.venue === 'hyperliquid')
      .reduce((acc, p) => acc + p.unrealizedPnlUsd, 0)

    const equityUsd = Number((this.cashUsd + pmValue + hlUnrealized).toFixed(2))

    return {
      startingEquityUsd: STARTING_EQUITY_USD,
      cashUsd: Number(this.cashUsd.toFixed(2)),
      equityUsd,
      unrealizedPnlUsd,
      realizedPnlUsd: Number(this.realizedPnlUsd.toFixed(2)),
      positions: this.positions.map((p) => ({ ...p })),
      receipts: this.receipts.map((r) => ({ ...r })),
    }
  }
}

function formatNumber(n: number): string {
  return n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toFixed(3)
}
