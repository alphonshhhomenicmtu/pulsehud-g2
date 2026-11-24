import type {
  ExecuteActionResponse,
  FeedHealth,
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PulseStateSnapshot,
  StagedAction,
} from '../../shared/types.js'
import { PaperLedger } from '../engine/paperLedger.js'
import { TelegramBridge, formatDigestText } from '../telegram/bridge.js'
import { detectSttProvider } from '../voice/intent.js'
import { createFallbackHyperliquidSignals, createFallbackPolymarketSignals } from './fallbackSnapshot.js'
import { fetchLiveHyperliquidSignals } from './hyperliquid.js'
import { fetchLivePolymarketSignals } from './polymarket.js'

type Listener = (snapshot: PulseStateSnapshot) => void

export class MarketHub {
  private hlSignals: HyperliquidPerpSignal[] = createFallbackHyperliquidSignals()
  private pmSignals: PolymarketOddsSignal[] = createFallbackPolymarketSignals()
  private offlineReplay: boolean
  private ledger = new PaperLedger()
  private telegram: TelegramBridge
  private listeners = new Set<Listener>()
  private pollTimer: NodeJS.Timeout | null = null
  private refreshing = false

  private health: FeedHealth = {
    hyperliquid: { status: 'replay', latencyMs: null, lastSyncAt: null },
    polymarket: { status: 'replay', latencyMs: null, lastSyncAt: null, clobVerified: false },
    telegram: {
      mode: 'desk_bridge',
      botUsername: null,
      chatIdConfigured: false,
      unreadCount: 0,
      lastSyncAt: null,
    },
    stt: { provider: detectSttProvider() },
  }

  constructor() {
    this.offlineReplay = process.env.OFFLINE_REPLAY === 'true'
    this.telegram = new TelegramBridge({
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    })
  }

  public async start(): Promise<void> {
    await this.refresh()
    this.pollTimer = setInterval(() => {
      void this.refresh()
    }, 10_000)
  }

  public stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private broadcast(): void {
    const snap = this.getSnapshot()
    for (const listener of this.listeners) {
      try {
        listener(snap)
      } catch {
        // Ignore broken SSE client
      }
    }
  }

  public setOfflineReplay(enabled: boolean): PulseStateSnapshot {
    this.offlineReplay = enabled
    if (enabled) {
      this.health.hyperliquid.status = 'replay'
      this.health.polymarket.status = 'replay'
      this.broadcast()
    } else {
      void this.refresh()
    }
    return this.getSnapshot()
  }

  public async refresh(): Promise<PulseStateSnapshot> {
    if (this.refreshing) return this.getSnapshot()
    this.refreshing = true

    try {
      if (this.offlineReplay) {
        this.health.hyperliquid.status = 'replay'
        this.health.polymarket.status = 'replay'
      } else {
        const [hlRes, pmRes] = await Promise.allSettled([
          fetchLiveHyperliquidSignals(),
          fetchLivePolymarketSignals(),
        ])

        if (hlRes.status === 'fulfilled' && hlRes.value.signals.length > 0) {
          this.hlSignals = hlRes.value.signals
          this.health.hyperliquid = {
            status: 'live',
            latencyMs: hlRes.value.latencyMs,
            lastSyncAt: Date.now(),
          }
        } else {
          this.health.hyperliquid = {
            status: 'replay',
            latencyMs: null,
            lastSyncAt: this.health.hyperliquid.lastSyncAt,
            error: hlRes.status === 'rejected' ? String(hlRes.reason?.message ?? hlRes.reason) : 'Empty response',
          }
        }

        if (pmRes.status === 'fulfilled' && pmRes.value.signals.length > 0) {
          this.pmSignals = pmRes.value.signals
          this.health.polymarket = {
            status: 'live',
            latencyMs: pmRes.value.latencyMs,
            lastSyncAt: Date.now(),
            clobVerified: pmRes.value.clobVerified,
          }
        } else {
          this.health.polymarket = {
            status: 'replay',
            latencyMs: null,
            lastSyncAt: this.health.polymarket.lastSyncAt,
            clobVerified: false,
            error: pmRes.status === 'rejected' ? String(pmRes.reason?.message ?? pmRes.reason) : 'Empty response',
          }
        }
      }

      this.ledger.seedIfEmpty(this.hlSignals, this.pmSignals)
      this.ledger.markToMarket(this.hlSignals, this.pmSignals)
      this.telegram.seedDeskMessages(this.hlSignals, this.pmSignals)
      this.telegram.refreshDrafts(this.hlSignals, this.pmSignals)
      await this.telegram.pollLiveTelegram(this.hlSignals, this.pmSignals, this.ledger.snapshot())

      this.health.telegram = this.telegram.getHealth()
      this.health.stt.provider = detectSttProvider()
      this.broadcast()
    } finally {
      this.refreshing = false
    }

    return this.getSnapshot()
  }

  public async executeAction(action: StagedAction): Promise<ExecuteActionResponse> {
    if (
      action.type === 'tg_reply' ||
      action.type === 'tg_share_signal' ||
      action.type === 'tg_broadcast_digest'
    ) {
      const text =
        action.type === 'tg_broadcast_digest' && !action.telegramText
          ? formatDigestText(this.hlSignals, this.pmSignals, this.ledger.snapshot())
          : (action.telegramText ?? action.summary)

      const { receipt, toast } = await this.telegram.sendReplyOrBroadcast({
        signalId: action.signalId,
        chatId: action.telegramChatId,
        text,
        kind: action.type,
      })
      this.ledger.recordExternalReceipt(receipt)
      this.health.telegram = this.telegram.getHealth()
      const state = this.getSnapshot()
      this.broadcast()
      return { ok: true, receipt, toast, state }
    }

    const { receipt, toast } = this.ledger.executeTradeAction(action, this.hlSignals, this.pmSignals)
    const state = this.getSnapshot()
    this.broadcast()
    return { ok: true, receipt, toast, state }
  }

  public injectTelegramMessage(sender: string, chatName: string, text: string) {
    const msg = this.telegram.injectInboundMessage(sender, chatName, text, this.hlSignals, this.pmSignals)
    this.health.telegram = this.telegram.getHealth()
    this.broadcast()
    return msg
  }

  public configureTelegram(botToken: string, chatId: string): PulseStateSnapshot {
    this.telegram.configure({ botToken, chatId })
    this.health.telegram = this.telegram.getHealth()
    void this.refresh()
    return this.getSnapshot()
  }

  public getSnapshot(): PulseStateSnapshot {
    this.health.telegram = this.telegram.getHealth()
    return {
      serverTime: Date.now(),
      offlineReplay: this.offlineReplay,
      health: structuredClone(this.health),
      hyperliquid: this.hlSignals.map((s) => ({ ...s })),
      polymarket: this.pmSignals.map((s) => ({ ...s })),
      telegram: this.telegram.getMessages(),
      portfolio: this.ledger.snapshot(),
    }
  }
}
