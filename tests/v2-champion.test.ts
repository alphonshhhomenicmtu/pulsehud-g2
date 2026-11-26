import { afterEach, describe, expect, it, vi } from 'vitest'
import { inflateSync } from 'node:zlib'
import {
  createFallbackHyperliquidSignals,
  createFallbackPolymarketSignals,
  createFallbackWatchedWallet,
} from '../server/feeds/fallbackSnapshot.js'
import {
  DEFAULT_WATCHED_HL_ADDRESS,
  isValidEthAddress,
  parseClearinghouseState,
} from '../server/feeds/hyperliquid.js'
import { PaperLedger } from '../server/engine/paperLedger.js'
import { detectMentionedCoin, TelegramBridge } from '../server/telegram/bridge.js'
import { parseVoiceIntent } from '../server/voice/intent.js'
import type { PulseStateSnapshot, StagedAction } from '../shared/types.js'
import { GlassesAudioCapture, renderVoiceMeter } from '../src/hud/audio.js'
import {
  encodeGray8ToPng,
  renderHyperliquidCandlesTiles,
  renderPolymarketSparklineTiles,
  renderUndoCountdownRing,
  renderWalletRiskBarTiles,
} from '../src/hud/chartRaster.js'
import { PulseHudController } from '../src/hud/controller.js'
import { evaluateThresholdAlerts } from '../src/hud/alerts.js'
import { buildHudPage, MENU_IDS, toStartUpPageContainer } from '../src/hud/layout.js'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'

function makeState(): PulseStateSnapshot {
  const hl = createFallbackHyperliquidSignals(1_764_000_000_000)
  const pm = createFallbackPolymarketSignals(1_764_000_000_000)
  const ledger = new PaperLedger()
  ledger.seedIfEmpty(hl, pm)
  const tg = new TelegramBridge({ botToken: '', chatId: '' })
  tg.seedDeskMessages(hl, pm)
  return {
    serverTime: 1_764_000_000_000,
    offlineReplay: false,
    health: {
      hyperliquid: {
        status: 'live',
        latencyMs: 95,
        lastSyncAt: 1_764_000_000_000,
        candlesLoaded: true,
      },
      polymarket: {
        status: 'live',
        latencyMs: 130,
        lastSyncAt: 1_764_000_000_000,
        clobVerified: true,
      },
      telegram: tg.getHealth(),
      stt: { provider: 'local_command' },
    },
    hyperliquid: hl,
    polymarket: pm,
    telegram: tg.getMessages(),
    watchedWallet: createFallbackWatchedWallet(1_764_000_000_000),
    portfolio: ledger.snapshot(),
  }
}

function decodeIdatPayload(png: Uint8Array): Buffer {
  let offset = 8
  const idatParts: Buffer[] = []
  while (offset < png.length) {
    const len =
      ((png[offset] << 24) |
        (png[offset + 1] << 16) |
        (png[offset + 2] << 8) |
        png[offset + 3]) >>>
      0
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString('ascii')
    const data = Buffer.from(png.subarray(offset + 8, offset + 8 + len))
    offset += 12 + len
    if (type === 'IDAT') idatParts.push(data)
    if (type === 'IEND') break
  }
  return inflateSync(Buffer.concat(idatParts))
}

describe('V2 Champion Upgrade: Graphics Rasterizer, clearinghouseState, Coin-Lock, Partial/BE, 2s Undo', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('encodes valid RFC-2083 8-bit grayscale PNGs for 15m HL candles, PM sparkline, Wallet gauge, and 2.0s Undo Ring', () => {
    const state = makeState()
    const hlTiles = renderHyperliquidCandlesTiles(
      state.hyperliquid[0],
      state.watchedWallet.positions[0],
      state.portfolio.positions[0],
    )
    expect(hlTiles).toHaveLength(2)
    expect(hlTiles[0].width).toBe(276)
    expect(hlTiles[0].height).toBe(68)

    // Verify transparent waveguide black background ratio (>70% black pixels!)
    let blackPixels = 0
    let totalPixels = 0
    for (const tile of hlTiles) {
      const inflated = decodeIdatPayload(tile.pngBytes)
      expect(inflated.length).toBe((tile.width + 1) * tile.height)
      for (const px of tile.pixels) {
        totalPixels += 1
        if (px === 0) blackPixels += 1
      }
    }
    expect(blackPixels / totalPixels).toBeGreaterThan(0.7)

    // Verify Polymarket sparkline, Wallet risk gauge, and 2.0s Undo Ring decode cleanly
    const pmTiles = renderPolymarketSparklineTiles(state.polymarket[0])
    expect(decodeIdatPayload(pmTiles[0].pngBytes).length).toBe((276 + 1) * 68)

    const walletTiles = renderWalletRiskBarTiles(state.watchedWallet)
    expect(decodeIdatPayload(walletTiles[0].pngBytes).length).toBe((276 + 1) * 56)

    const ringArmed = renderUndoCountdownRing(1200, 2000, true)
    expect(ringArmed.width).toBe(76)
    expect(ringArmed.height).toBe(76)
    expect(decodeIdatPayload(ringArmed.pngBytes).length).toBe((76 + 1) * 76)

    // Custom small PNG round-trip check
    const raw = new Uint8Array([0, 255, 136, 0])
    const miniPng = encodeGray8ToPng(raw, 2, 2)
    const rawDecoded = decodeIdatPayload(miniPng)
    expect(Array.from(rawDecoded)).toEqual([0, 0, 255, 0, 136, 0])
  })

  it('parses live Hyperliquid clearinghouseState with accurate margin ratio and liquidation distance', () => {
    expect(isValidEthAddress(DEFAULT_WATCHED_HL_ADDRESS)).toBe(true)
    expect(isValidEthAddress('0x123')).toBe(false)

    const markMap = new Map([
      ['BTC', 60000],
      ['ETH', 2000],
    ])
    const parsed = parseClearinghouseState(
      DEFAULT_WATCHED_HL_ADDRESS,
      'Test Whale',
      {
        marginSummary: { accountValue: '100000', totalMarginUsed: '25000' },
        withdrawable: '75000',
        assetPositions: [
          {
            position: {
              coin: 'BTC',
              szi: '1.5',
              leverage: { type: 'cross', value: 10 },
              entryPx: '59000',
              positionValue: '90000',
              unrealizedPnl: '1500',
              returnOnEquity: '0.166',
              liquidationPx: '54000',
              cumFunding: { sinceOpen: '-12.5' },
            },
          },
          {
            position: {
              coin: 'ETH',
              szi: '-10',
              leverage: { type: 'isolated', value: 5 },
              entryPx: '2100',
              positionValue: '20000',
              unrealizedPnl: '1000',
              returnOnEquity: '0.25',
              liquidationPx: '2300',
              cumFunding: { sinceOpen: '4.2' },
            },
          },
        ],
      },
      markMap,
    )

    expect(parsed.status).toBe('live')
    expect(parsed.marginRatioPct).toBe(25)
    expect(parsed.totalUnrealizedPnlUsd).toBe(2500)
    expect(parsed.positions).toHaveLength(2)

    // Sorted by nearest liquidation distance ascending (BTC 10% before ETH 15%)
    expect(parsed.positions[0].coin).toBe('BTC')
    expect(parsed.positions[0].side).toBe('LONG')
    expect(parsed.positions[0].liqDistancePct).toBeCloseTo(10, 1) // (60000 - 54000) / 60000 = 10%

    expect(parsed.positions[1].coin).toBe('ETH')
    expect(parsed.positions[1].side).toBe('SHORT')
    expect(parsed.positions[1].liqDistancePct).toBeCloseTo(15, 1) // (2300 - 2000) / 2000 = 15%

    // Verify altcoin with closer liquidation leads ahead of larger BTC notional, and null liq goes last
    const altSorted = parseClearinghouseState(
      DEFAULT_WATCHED_HL_ADDRESS,
      'Nearest Risk Check',
      {
        marginSummary: { accountValue: '500000', totalMarginUsed: '200000' },
        assetPositions: [
          {
            position: {
              coin: 'BTC',
              szi: '10',
              leverage: { type: 'cross', value: 5 },
              entryPx: '60000',
              positionValue: '600000',
              unrealizedPnl: '2000',
              liquidationPx: '45000', // 25% away
            },
          },
          {
            position: {
              coin: 'DOGE',
              szi: '50000',
              leverage: { type: 'isolated', value: 20 },
              entryPx: '0.20',
              positionValue: '10000',
              unrealizedPnl: '-400',
              liquidationPx: '0.193', // 3.5% away -> MUST lead!
            },
          },
          {
            position: {
              coin: 'ETH',
              szi: '5',
              leverage: { type: 'cross', value: 2 },
              entryPx: '2000',
              positionValue: '10000',
              unrealizedPnl: '100',
              liquidationPx: null, // null -> MUST sort last!
            },
          },
        ],
      },
      new Map([
        ['BTC', 60000],
        ['DOGE', 0.2],
        ['ETH', 2000],
      ]),
    )
    expect(altSorted.positions.map((p) => p.coin)).toEqual(['DOGE', 'BTC', 'ETH'])
    expect(altSorted.positions[0].liqDistancePct).toBeCloseTo(3.5, 1)
    expect(altSorted.positions[2].liqDistancePct).toBeNull()
  })

  it('supports 50% Partial Close and Move Stop to Break-Even in PaperLedger', () => {
    const hl = createFallbackHyperliquidSignals()
    const pm = createFallbackPolymarketSignals()
    const ledger = new PaperLedger()
    ledger.seedIfEmpty(hl, pm)

    const btcBefore = ledger.snapshot().positions.find((p) => p.symbol === 'BTC-PERP')!
    const origSize = btcBefore.size

    // Arm Break-Even stop
    const beRes = ledger.executeTradeAction(
      {
        id: 'be-1',
        type: 'hl_move_sl_be',
        label: 'Move BTC Stop -> BE',
        headline: 'BE STOP BTC',
        summary: 'BE',
        riskNote: 'PAPER',
        coin: 'BTC',
        source: 'tap',
      },
      hl,
      pm,
    )
    expect(beRes.receipt.title).toContain('BE STOP')
    const afterBe = ledger.snapshot().positions.find((p) => p.symbol === 'BTC-PERP')!
    expect(afterBe.stopLossMode).toBe('breakeven')
    expect(afterBe.stopLossPx).toBe(afterBe.entryPrice)

    // Take 50% partial close
    const partialRes = ledger.executeTradeAction(
      {
        id: 'p-1',
        type: 'hl_partial_close',
        label: 'Take 50% BTC',
        headline: 'PARTIAL 50% BTC',
        summary: 'Trim 50%',
        riskNote: 'PAPER',
        coin: 'BTC',
        closeFraction: 0.5,
        source: 'tap',
      },
      hl,
      pm,
    )
    expect(partialRes.receipt.title).toContain('PARTIAL 50%')
    const afterPartial = ledger.snapshot().positions.find((p) => p.symbol === 'BTC-PERP')!
    expect(afterPartial.size).toBeCloseTo(origSize / 2, 4)
    expect(ledger.snapshot().realizedPnlUsd).toBeGreaterThan(0)
  })

  it('detects Coin-Locked Telegram mentions and jumps directly into coin trade controls with dynamic size cycling', async () => {
    const state = makeState()
    expect(detectMentionedCoin('SOL funding exploding +24% APR — hedge?', state.hyperliquid)).toBe('SOL')
    expect(detectMentionedCoin('HYPE breakout above $25', state.hyperliquid)).toBe('HYPE')
    expect(detectMentionedCoin('Lunch at 1pm?', state.hyperliquid)).toBeUndefined()

    const ctrl = new PulseHudController(null, state)
    await ctrl.handleMenuSelection(MENU_IDS.TELEGRAM_DESK)
    // Tap first TG message (mentions BTC) -> opens actions with Coin-Lock jump
    await ctrl.dispatchGesture({ kind: 'click' })
    const tgActions = ctrl.getRenderModel().actions
    const jumpIdx = tgActions.findIndex((a) => a.uiCommand === 'jump_coin_trade')
    expect(jumpIdx).toBeGreaterThan(0)
    expect(tgActions[jumpIdx].coin).toBe('BTC')

    // Scroll to Coin-Lock jump and tap -> jumps directly to BTC-PERP trade controls!
    for (let i = 0; i < jumpIdx; i += 1) {
      await ctrl.dispatchGesture({ kind: 'scroll_down' })
    }
    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getRenderModel().screen).toBe('actions')
    expect(ctrl.getRenderModel().channel).toBe('hyperliquid')

    // Scroll down twice to Order Size Cycler (index 2) and tap to cycle $1,000 -> $2,500
    await ctrl.dispatchGesture({ kind: 'scroll_down' })
    await ctrl.dispatchGesture({ kind: 'scroll_down' })
    expect(ctrl.getHlOrderSizeUsd()).toBe(1000)
    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getHlOrderSizeUsd()).toBe(2500)
  })

  it('enforces the 2.0-second Post-Tap Undo Safety Window: single tap cancels cleanly with zero writes, untouched commits after 2.0s', async () => {
    vi.useFakeTimers()
    const state = makeState()
    const executed: StagedAction[] = []

    const ctrl = new PulseHudController(null, state, {
      undoWindowMs: 2000,
      executeActionFn: async (action) => {
        executed.push(action)
        return {
          ok: true,
          receipt: {
            id: 'r1',
            timestamp: Date.now(),
            type: action.type,
            title: 'MOCK FILLED',
            detail: action.summary,
            venue: 'hyperliquid-paper',
            deliveredExternal: false,
          },
          toast: 'MOCK FILLED',
          state,
        }
      },
    })

    // Stage action: HL feed -> Tap -> Tap Paper Short (index 0 -> opens Confirm Gate)
    await ctrl.dispatchGesture({ kind: 'click' })
    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getRenderModel().screen).toBe('confirm')
    expect(ctrl.getRenderModel().confirmArmed).toBe(false)

    // First tap on Confirm arms 2.0s undo countdown (DOES NOT execute yet!)
    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getRenderModel().confirmArmed).toBe(true)
    expect(executed).toHaveLength(0)

    // Advance 900ms, then single tap -> UNDO cancels cleanly!
    vi.advanceTimersByTime(900)
    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getRenderModel().screen).toBe('feed')
    expect(ctrl.getRenderModel().confirmArmed).toBe(false)
    expect(ctrl.getRenderModel().toast).toContain('UNDONE')

    // Even after 3 more seconds, ZERO writes occurred!
    vi.advanceTimersByTime(3000)
    expect(executed).toHaveLength(0)

    // Now stage again, arm, and leave untouched for 2.0s -> executes cleanly once!
    await ctrl.dispatchGesture({ kind: 'click' })
    await ctrl.dispatchGesture({ kind: 'click' })
    await ctrl.dispatchGesture({ kind: 'click' }) // Arm 2.0s window
    expect(executed).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2050)
    expect(executed).toHaveLength(1)
    expect(executed[0].type).toBe('hl_paper_short')
    expect(ctrl.getRenderModel().confirmPhase).toBe('done')
    ctrl.destroy()
  })

  it('prevents a tap at 0.0s from ever re-arming or double-sending an in-flight commit (explicit committing phase)', async () => {
    vi.useFakeTimers()
    const state = makeState()
    const executed: StagedAction[] = []

    let resolveInFlight!: (res: {
      ok: true
      receipt: {
        id: string
        timestamp: number
        type: StagedAction['type']
        title: string
        detail: string
        venue: 'hyperliquid-paper'
        deliveredExternal: false
      }
      toast: string
      state: PulseStateSnapshot
    }) => void

    const ctrl = new PulseHudController(null, state, {
      undoWindowMs: 2000,
      executeActionFn: (action) => {
        executed.push(action)
        return new Promise((resolve) => {
          resolveInFlight = resolve
        })
      },
    })

    // Stage Paper Short BTC -> Confirm Gate -> Arm 2.0s undo ring
    await ctrl.dispatchGesture({ kind: 'click' })
    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getRenderModel().screen).toBe('confirm')
    expect(ctrl.getRenderModel().confirmPhase).toBe('idle')

    await ctrl.dispatchGesture({ kind: 'click' })
    expect(ctrl.getRenderModel().confirmPhase).toBe('armed')

    // Expire the 2.0s timer so commitStagedAction starts and enters 'committing' before awaiting executeActionFn
    vi.advanceTimersByTime(2000)
    expect(ctrl.getRenderModel().confirmPhase).toBe('committing')
    expect(ctrl.getRenderModel().confirmArmed).toBe(false)
    expect(executed).toHaveLength(1)

    // Hammer click, double-click, scroll, long-press, and menu at 0.0s while executeActionFn is still pending!
    await ctrl.dispatchGesture({ kind: 'click' })
    await ctrl.dispatchGesture({ kind: 'double_click' })
    await ctrl.dispatchGesture({ kind: 'scroll_down' })
    await ctrl.dispatchGesture({ kind: 'long_press' })
    await ctrl.handleMenuSelection(MENU_IDS.PORTFOLIO)

    // Still locked in 'committing', NEVER re-armed, NEVER navigated away, still exactly 1 call!
    expect(ctrl.getRenderModel().confirmPhase).toBe('committing')
    expect(ctrl.getRenderModel().confirmArmed).toBe(false)
    expect(ctrl.getRenderModel().screen).toBe('confirm')
    expect(executed).toHaveLength(1)

    // Even if the network request stalls for > 3.0s (> undoWindowMs), no re-armed timer fires!
    vi.advanceTimersByTime(3500)
    expect(executed).toHaveLength(1)
    expect(ctrl.getRenderModel().confirmPhase).toBe('committing')

    // Settle the single in-flight commit
    resolveInFlight({
      ok: true,
      receipt: {
        id: 'rcpt-single',
        timestamp: Date.now(),
        type: executed[0].type,
        title: 'SINGLE COMMIT',
        detail: executed[0].summary,
        venue: 'hyperliquid-paper',
        deliveredExternal: false,
      },
      toast: 'SINGLE COMMIT OK',
      state,
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(executed).toHaveLength(1)
    expect(ctrl.getRenderModel().confirmPhase).toBe('done')
    expect(ctrl.getRenderModel().screen).toBe('feed')
    expect(ctrl.getRenderModel().toast).toBe('SINGLE COMMIT OK')
    ctrl.destroy()
  })

  it('copies PCM frames defensively and renders voice meter with firmware-verified glyphs only', () => {
    const capture = new GlassesAudioCapture()
    capture.start()

    // Simulate a host bridge reusing the same Uint8Array buffer across consecutive audioEvents
    const sharedBuf = new Uint8Array(64)
    sharedBuf.fill(0x11)
    capture.pushPcm(sharedBuf)
    sharedBuf.fill(0x22)
    capture.pushPcm(sharedBuf)

    const out = capture.stopAndEncodeBase64()
    const decoded = Buffer.from(out.base64, 'base64')
    expect(decoded.length).toBe(128)
    expect(decoded[0]).toBe(0x11)
    expect(decoded[63]).toBe(0x11)
    expect(decoded[64]).toBe(0x22)
    expect(decoded[127]).toBe(0x22)

    // Voice meter uses strictly ━ / ─ (zero U+2581..U+2588 block characters)
    for (let tick = 0; tick < 8; tick += 1) {
      const meter = renderVoiceMeter(0.5, tick)
      expect(meter).toMatch(/^[━─]{8}$/)
    }
  })

  it('passes 30-phrase Voice Intent Evaluation Suite with zero false executions on non-trading chatter', () => {
    const state = makeState()
    const ctx = {
      hl: state.hyperliquid,
      pm: state.polymarket,
      tg: state.telegram,
      portfolio: state.portfolio,
    }

    const cases: Array<[string, string | null]> = [
      ['Paper short 1000 BTC', 'hl_paper_short'],
      ['Short 500 ETH', 'hl_paper_short'],
      ['Hedge 2500 SOL', 'hl_paper_short'],
      ['Sell 750 HYPE', 'hl_paper_short'],
      ['Paper long 1000 BTC', 'hl_paper_long'],
      ['Long 500 Ethereum', 'hl_paper_long'],
      ['Buy 1200 Solana', 'hl_paper_long'],
      ['Take 50% BTC', 'hl_partial_close'],
      ['Partial close ETH', 'hl_partial_close'],
      ['Trim half BTC position', 'hl_partial_close'],
      ['Close half SOL', 'hl_partial_close'],
      ['Move BTC stop to breakeven', 'hl_move_sl_be'],
      ['Break even ETH', 'hl_move_sl_be'],
      ['SL to BE on BTC', 'hl_move_sl_be'],
      ['Flatten BTC position', 'hl_flatten'],
      ['Close position', 'hl_flatten'],
      ['Exit position ETH', 'hl_flatten'],
      ['Buy 50 yes BTC', 'pm_paper_yes'],
      ['Bet 100 yes Polymarket', 'pm_paper_yes'],
      ['Buy 25 no Bitcoin', 'pm_paper_no'],
      ['Reply: hedging 25% now', 'tg_reply'],
      ['Tell desk: taking profit at mark', 'tg_reply'],
      ['Message desk staying flat here', 'tg_reply'],
      ['Send reply: copied on G2', 'tg_reply'],
      ['Send live digest to Telegram', 'tg_broadcast_digest'],
      ['Post BTC alert to Telegram', 'tg_share_signal'],
      // Non-actionable ambient speech MUST return null (0 false executions!)
      ['Hello how is the weather today', null],
      ['Let us grab coffee after the meeting', null],
      ['What time is dinner tonight', null],
      ['Good morning everyone', null],
    ]

    expect(cases).toHaveLength(30)
    for (const [phrase, expectedType] of cases) {
      const result = parseVoiceIntent(phrase, ctx)
      if (expectedType === null) {
        expect(result, `Expected null for ambient speech "${phrase}"`).toBeNull()
      } else {
        expect(result?.type, `Phrase "${phrase}"`).toBe(expectedType)
        expect(result?.source).toBe('voice')
      }
    }
  })

  it('triggers proactive liq (<5%), funding (>=25% APR), and odds (>=5c) alert banners with 1-tap hedge staging and clean ack', async () => {
    const state = makeState()
    // 1. Default fallback has HYPE funding +27.2% APR (>=25%) and Polymarket +19.5c (>=5c), no liq <5% yet
    const baseAlerts = evaluateThresholdAlerts(state, 1000, 50)
    expect(baseAlerts.some((a) => a.kind === 'funding_extreme' && a.coin === 'HYPE')).toBe(true)
    expect(baseAlerts.some((a) => a.kind === 'odds_swing')).toBe(true)
    expect(baseAlerts[0].kind).toBe('funding_extreme')

    // 2. Inject critical liquidation risk (<5%) -> MUST jump to top priority!
    state.watchedWallet.positions[0] = {
      ...state.watchedWallet.positions[0],
      coin: 'BTC',
      side: 'LONG',
      liqDistancePct: 3.4,
    }
    const criticalAlerts = evaluateThresholdAlerts(state, 1000, 50)
    expect(criticalAlerts[0].kind).toBe('liq_risk')
    expect(criticalAlerts[0].severity).toBe('critical')
    expect(criticalAlerts[0].bannerText).toContain('[ALERT]')
    expect(criticalAlerts[0].bannerText).toContain('3.4%')
    expect(criticalAlerts[0].action.type).toBe('hl_paper_short')

    const ctrl = new PulseHudController(null, state)
    const model = ctrl.getRenderModel()
    expect(model.activeAlert?.kind).toBe('liq_risk')

    // HUD page renders [ALERT] banner cleanly within SDK v0.0.16 bounds
    const page = buildHudPage(model)
    expect(page.slots[2].content).toContain('[ALERT]')
    expect(page.slots[2].content).toContain('LIQ BTC 3.4%')
    expect(validateEvenHubPageContainer(toStartUpPageContainer(page)).valid).toBe(true)

    // 1-tap menu/alert action stages counter-hedge onto Confirm Gate (still requires 2.0s Arm/Undo!)
    await ctrl.handleMenuSelection(MENU_IDS.ALERT_ACTION)
    expect(ctrl.getRenderModel().screen).toBe('confirm')
    expect(ctrl.getRenderModel().confirmPhase).toBe('idle')
    expect(ctrl.getRenderModel().stagedAction?.headline).toContain('ALERT HEDGE BTC')

    // Cancel and dismiss critical alert -> falls through cleanly to funding alert!
    await ctrl.dispatchGesture({ kind: 'double_click' })
    await ctrl.dismissActiveAlert()
    expect(ctrl.getRenderModel().activeAlert?.kind).toBe('funding_extreme')
    ctrl.destroy()
  })
})
