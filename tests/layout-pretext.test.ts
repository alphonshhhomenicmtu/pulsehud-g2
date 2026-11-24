import { describe, expect, it } from 'vitest'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { createFallbackHyperliquidSignals, createFallbackPolymarketSignals } from '../server/feeds/fallbackSnapshot.js'
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
      hyperliquid: { status: 'live', latencyMs: 120, lastSyncAt: 1_764_000_000_000 },
      polymarket: { status: 'live', latencyMs: 180, lastSyncAt: 1_764_000_000_000, clobVerified: true },
      telegram: tg.getHealth(),
      stt: { provider: 'local_command' },
    },
    hyperliquid: hl,
    polymarket: pm,
    telegram: tg.getMessages(),
    portfolio: ledger.snapshot(),
  }
}

describe('Even G2 576x288 HUD layout & SDK container compliance', () => {
  const state = createSampleState()
  const screens: HudScreenKind[] = ['feed', 'actions', 'confirm', 'voice', 'portfolio']

  for (const screen of screens) {
    it(`produces a valid SDK container payload for "${screen}" screen`, () => {
      const page = buildHudPage({
        screen,
        channel: 'all',
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
            riskNote: 'PAPER MODE ONLY',
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
          riskNote: 'PAPER MODE ONLY',
          source: 'tap',
        },
        confirmSelection: 'confirm',
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
        expect(encoder.encode(slot.content).byteLength).toBeLessThanOrEqual(MAX_TEXT_CONTAINER_BYTES)
      }

      // Official SDK container & menu validation
      const startup = toStartUpPageContainer(page)
      const validation = validateEvenHubPageContainer(startup)
      expect(validation.valid).toBe(true)
    })
  }
})
