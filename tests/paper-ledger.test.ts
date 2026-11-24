import { describe, expect, it } from 'vitest'
import { createFallbackHyperliquidSignals, createFallbackPolymarketSignals } from '../server/feeds/fallbackSnapshot.js'
import { PaperLedger } from '../server/engine/paperLedger.js'
import { generateSmartDrafts, TelegramBridge } from '../server/telegram/bridge.js'

describe('PaperLedger & Telegram Desk smart drafts', () => {
  it('executes Hyperliquid paper short/long and updates live PnL ledger', () => {
    const hl = createFallbackHyperliquidSignals()
    const pm = createFallbackPolymarketSignals()
    const ledger = new PaperLedger()
    ledger.seedIfEmpty(hl, pm)

    const before = ledger.snapshot()
    expect(before.positions.length).toBe(2)

    const res = ledger.executeTradeAction(
      {
        id: 't1',
        type: 'hl_paper_long',
        label: 'Paper Long $1,000 ETH',
        headline: 'HYPERLIQUID PAPER LONG ETH',
        summary: '$1,000 ETH',
        riskNote: 'PAPER',
        coin: 'ETH',
        notionalUsd: 1000,
        source: 'tap',
      },
      hl,
      pm,
    )

    expect(res.receipt.venue).toBe('hyperliquid-paper')
    const after = ledger.snapshot()
    expect(after.positions.some((p) => p.symbol === 'ETH-PERP')).toBe(true)
    expect(after.receipts.length).toBe(1)
  })

  it('executes Polymarket paper YES trade and deducts paper cash stake', () => {
    const hl = createFallbackHyperliquidSignals()
    const pm = createFallbackPolymarketSignals()
    const ledger = new PaperLedger()
    ledger.seedIfEmpty(hl, pm)

    const cashBefore = ledger.snapshot().cashUsd
    const res = ledger.executeTradeAction(
      {
        id: 't2',
        type: 'pm_paper_yes',
        label: 'Paper YES $50',
        headline: 'POLYMARKET PAPER YES $50',
        summary: 'BTC above 60k',
        riskNote: 'PAPER',
        marketId: pm[1].marketId,
        notionalUsd: 50,
        source: 'tap',
      },
      hl,
      pm,
    )

    expect(res.receipt.venue).toBe('polymarket-paper')
    expect(ledger.snapshot().cashUsd).toBeCloseTo(cashBefore - 50, 2)
  })

  it('generates contextual smart replies referencing live market prices', async () => {
    const hl = createFallbackHyperliquidSignals()
    const pm = createFallbackPolymarketSignals()
    const drafts = generateSmartDrafts('BTC funding is getting spicy, should we hedge?', hl, pm)
    expect(drafts.length).toBe(3)
    expect(drafts[0]).toContain('$61,581')

    const bridge = new TelegramBridge({ botToken: '', chatId: '' })
    bridge.seedDeskMessages(hl, pm)
    const target = bridge.getMessages()[0]
    expect(target.unread).toBe(true)

    const sent = await bridge.sendReplyOrBroadcast({
      signalId: target.id,
      chatId: target.chatId,
      text: drafts[0],
      kind: 'tg_reply',
    })
    expect(sent.receipt.venue).toBe('telegram')
    expect(bridge.getMessages().find((m) => m.id === target.id)?.unread).toBe(false)
  })
})
