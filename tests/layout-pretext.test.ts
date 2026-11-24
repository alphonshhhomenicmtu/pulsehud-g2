import { describe, expect, it } from 'vitest'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import {
  createFallbackHyperliquidSignals,
  createFallbackPolymarketSignals,
  createFallbackWatchedWallet,
} from '../server/feeds/fallbackSnapshot.js'
import { PaperLedger } from '../server/engine/paperLedger.js'
import { TelegramBridge } from '../server/telegram/bridge.js'
import type { PulseStateSnapshot } from '../shared/types.js'
import {
  buildHudPage,
  G2_CANVAS_H,
  G2_CANVAS_W,
  MAX_TEXT_CONTAINER_BYTES,
  toStartUpPageContainer,
  type HudScreenKind,
} from '../src/hud/layout.js'

function createSampleState(): PulseStateSnapshot {
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
        latencyMs: 120,
        lastSyncAt: 1_764_000_000_000,
        candlesLoaded: true,
      },
      polymarket: {
        status: 'live',
        latencyMs: 180,
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

describe('Even G2 576x288 HUD layout & SDK v0.0.16 container + image compliance', () => {
  const state = createSampleState()
  const screens: HudScreenKind[] = ['feed', 'actions', 'confirm', 'voice', 'wallet', 'portfolio']

  for (const screen of screens) {
    it(`produces a valid SDK container payload for "${screen}" screen`, () => {
      const page = buildHudPage({
        screen,
        channel: 'all',
        borderlessOptics: true,
        hlOrderSizeUsd: 1000,
        pmStakeSizeUsd: 50,
        state,
        signals: [...state.hyperliquid, ...state.polymarket, ...state.telegram],
        signalIndex: 0,
        actions: [
          {
            id: 'a1',
            type: 'hl_paper_short',
            label: 'Paper Short $1,000 BTC (Hedge)',
            headline: 'HYPERLIQUID PAPER SHORT BTC',
            summary: '$1,000 notional @ $61,579.00',
            riskNote: 'PAPER MODE ONLY · 2.0s undo window.',
            source: 'tap',
          },
        ],
        actionIndex: 0,
        stagedAction: {
          id: 'a1',
          type: 'hl_paper_short',
          label: 'Paper Short $1,000 BTC (Hedge)',
          headline: 'HYPERLIQUID PAPER SHORT BTC',
          summary: '$1,000 notional @ $61,579.00',
          riskNote: 'PAPER MODE ONLY · 2.0s undo window.',
          source: 'tap',
        },
        confirmSelection: 'confirm',
        confirmPhase: screen === 'confirm' ? 'armed' : 'idle',
        confirmArmed: screen === 'confirm',
        confirmRemainingMs: 1400,
        confirmTotalMs: 2000,
        voiceActive: true,
        voiceStatusLine: 'Listening...',
        voiceDurationMs: 1400,
        voiceLevel: 0.6,
        voiceTick: 2,
        toast: null,
      })

      // Hardware limits
      expect(page.slots.length).toBeGreaterThanOrEqual(1)
      expect(page.slots.length).toBeLessThanOrEqual(8)
      expect(page.imageSlots.length).toBeLessThanOrEqual(4)
      expect(page.slots.length + page.imageSlots.length).toBeLessThanOrEqual(12)

      // Exactly one event-capturing container per page
      const captureCount = page.slots.filter((s) => s.isEventCapture === 1).length
      expect(captureCount).toBe(1)

      const encoder = new TextEncoder()
      for (const slot of page.slots) {
        expect(slot.containerName.length).toBeLessThanOrEqual(16)
        expect(slot.xPosition).toBeGreaterThanOrEqual(0)
        expect(slot.yPosition).toBeGreaterThanOrEqual(0)
        expect(slot.xPosition + slot.width).toBeLessThanOrEqual(G2_CANVAS_W)
        expect(slot.yPosition + slot.height).toBeLessThanOrEqual(G2_CANVAS_H)
        expect(slot.textColor).toBeGreaterThanOrEqual(0)
        expect(slot.textColor).toBeLessThanOrEqual(4)
        expect(encoder.encode(slot.content).byteLength).toBeLessThanOrEqual(
          MAX_TEXT_CONTAINER_BYTES,
        )
      }

      // Image container firmware bounds (width 20..288, height 20..144)
      for (const img of page.imageSlots) {
        expect(img.containerName.length).toBeLessThanOrEqual(16)
        expect(img.width).toBeGreaterThanOrEqual(20)
        expect(img.width).toBeLessThanOrEqual(288)
        expect(img.height).toBeGreaterThanOrEqual(20)
        expect(img.height).toBeLessThanOrEqual(144)
        expect(img.xPosition + img.width).toBeLessThanOrEqual(G2_CANVAS_W)
        expect(img.yPosition + img.height).toBeLessThanOrEqual(G2_CANVAS_H)
        // Verify valid PNG magic header
        expect(Array.from(img.pngBytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      }

      // Official SDK container & menu validation
      const startup = toStartUpPageContainer(page)
      const validation = validateEvenHubPageContainer(startup)
      expect(validation.valid).toBe(true)
    })
  }

  it('builds borderless dual-tile 15m chart on Hyperliquid feed and ring image on Confirm Gate', () => {
    const hlPage = buildHudPage({
      screen: 'feed',
      channel: 'hyperliquid',
      borderlessOptics: true,
      hlOrderSizeUsd: 1000,
      pmStakeSizeUsd: 50,
      state,
      signals: state.hyperliquid,
      signalIndex: 0,
      actions: [],
      actionIndex: 0,
      stagedAction: null,
      confirmSelection: 'confirm',
      confirmPhase: 'idle',
      confirmArmed: false,
      confirmRemainingMs: 2000,
      confirmTotalMs: 2000,
      voiceActive: false,
      voiceStatusLine: '',
      voiceDurationMs: 0,
      voiceLevel: 0,
      voiceTick: 0,
      toast: null,
    })

    expect(hlPage.layoutKey).toBe('feed-chart')
    expect(hlPage.slots[1].borderWidth).toBe(0)
    expect(hlPage.imageSlots.length).toBe(2)
    expect(hlPage.imageSlots[0].width).toBe(276)
    expect(hlPage.imageSlots[1].width).toBe(276)
    // Fallback synthetic candles MUST NEVER be labeled LIVE
    expect(hlPage.slots[0].content).toContain('FALLBACK')
    expect(hlPage.slots[0].content).not.toContain('· LIVE')
  })

  it('labels live Hyperliquid candles LIVE, synthetic fallback FALLBACK, and missing candles SYNC', () => {
    const baseModel = {
      screen: 'feed' as const,
      channel: 'hyperliquid' as const,
      borderlessOptics: true,
      hlOrderSizeUsd: 1000,
      pmStakeSizeUsd: 50,
      state,
      signalIndex: 0,
      actions: [],
      actionIndex: 0,
      stagedAction: null,
      confirmSelection: 'confirm' as const,
      confirmPhase: 'idle' as const,
      confirmArmed: false,
      confirmRemainingMs: 2000,
      confirmTotalMs: 2000,
      voiceActive: false,
      voiceStatusLine: '',
      voiceDurationMs: 0,
      voiceLevel: 0,
      voiceTick: 0,
      toast: null,
    }

    // 1. Live candles -> LIVE
    const liveSignal = { ...state.hyperliquid[0], candlesSource: 'live' as const }
    const livePage = buildHudPage({ ...baseModel, signals: [liveSignal] })
    expect(livePage.slots[0].content).toContain('LIVE')
    expect(livePage.imageSlots[0].fingerprint).toContain(':live:')

    // 2. Synthetic fallback candles -> FALLBACK (never LIVE)
    const synthSignal = { ...state.hyperliquid[0], candlesSource: 'synthetic' as const }
    const synthPage = buildHudPage({ ...baseModel, signals: [synthSignal] })
    expect(synthPage.slots[0].content).toContain('FALLBACK')
    expect(synthPage.slots[0].content).not.toContain('· LIVE')
    expect(synthPage.imageSlots[0].fingerprint).toContain(':synthetic:')

    // 3. Unavailable / <6 candles -> SYNC tile (never LIVE)
    const syncSignal = { ...state.hyperliquid[0], candles15m: [], candlesSource: 'unavailable' as const }
    const syncPage = buildHudPage({ ...baseModel, signals: [syncSignal] })
    expect(syncPage.slots[0].content).toContain('SYNC')
    expect(syncPage.slots[0].content).not.toContain('· LIVE')
    expect(syncPage.imageSlots[0].fingerprint).toContain('hl-sync:')
  })

  it('leads the wallet lens with nearest liquidation distance, marks portfolio DEMO, and validates committing confirm state', () => {
    const baseModel = {
      channel: 'all' as const,
      borderlessOptics: true,
      hlOrderSizeUsd: 1000,
      pmStakeSizeUsd: 50,
      state,
      signals: state.hyperliquid,
      signalIndex: 0,
      actions: [],
      actionIndex: 0,
      stagedAction: {
        id: 'c1',
        type: 'hl_paper_short' as const,
        label: 'Paper Short $1,000 BTC',
        headline: 'HYPERLIQUID PAPER SHORT BTC',
        summary: '$1,000 notional @ $61,579.00',
        riskNote: 'PAPER MODE ONLY · 2.0s undo window.',
        source: 'tap' as const,
      },
      confirmSelection: 'confirm' as const,
      confirmPhase: 'committing' as const,
      confirmArmed: false,
      confirmRemainingMs: 0,
      confirmTotalMs: 2000,
      voiceActive: false,
      voiceStatusLine: '',
      voiceDurationMs: 0,
      voiceLevel: 0,
      voiceTick: 0,
      toast: null,
    }

    const walletPage = buildHudPage({ ...baseModel, screen: 'wallet', confirmPhase: 'idle' })
    const walletFirstLine = walletPage.slots[1].content.split('\n')[0]
    expect(walletFirstLine).toContain('NEAREST LIQ')
    expect(walletFirstLine).toContain('BTC')
    expect(walletFirstLine).toContain('12.7%')

    const portfolioPage = buildHudPage({ ...baseModel, screen: 'portfolio', confirmPhase: 'idle' })
    expect(portfolioPage.slots[0].content).toContain('DEMO')

    const committingPage = buildHudPage({ ...baseModel, screen: 'confirm', confirmPhase: 'committing' })
    expect(committingPage.slots[0].content).toContain('SENDING')
    expect(committingPage.imageSlots[0].fingerprint).toBe('ring:commit:-2')
    expect(validateEvenHubPageContainer(toStartUpPageContainer(committingPage)).valid).toBe(true)
  })
})
