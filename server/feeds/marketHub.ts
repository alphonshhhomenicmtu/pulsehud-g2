import type {
  ExecuteActionResponse,
  FeedHealth,
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PulseStateSnapshot,
  StagedAction,
  WatchedWalletSnapshot,
} from '../../shared/types.js'
import { PaperLedger } from '../engine/paperLedger.js'
import { TelegramBridge, formatDigestText } from '../telegram/bridge.js'
import { detectRuntimeSttProvider } from '../voice/localStt.js'
import {
  createFallbackHyperliquidSignals,
  createFallbackPolymarketSignals,
  createFallbackWatchedWallet,
} from './fallbackSnapshot.js'
import {
  DEFAULT_WATCHED_HL_ADDRESS,
  fetchLiveClearinghouseState,
  fetchLiveHyperliquidSignals,
  isValidEthAddress,
  shortenAddress,
  WATCHED_WALLET_PRESETS,
} from './hyperliquid.js'
import { fetchLivePolymarketSignals } from './polymarket.js'

type Listener = (snapshot: PulseStateSnapshot) => void

export class MarketHub {
  private hlSignals: HyperliquidPerpSignal[] = createFallbackHyperliquidSignals()
  private pmSignals: PolymarketOddsSignal[] = createFallbackPolymarketSignals()
  private markMap = new Map<string, number>()
  private watchedAddress: string
  private watchedLabel: string
  private watchedWallet: WatchedWalletSnapshot = createFallbackWatchedWallet()
  private offlineReplay: boolean
  private ledger = new PaperLedger()
  private telegram: TelegramBridge
  private listeners = new Set<Listener>()
  private pollTimer: NodeJS.Timeout | null = null
  private refreshing = false

  private health: FeedHealth = {
    hyperliquid: { status: 'replay', latencyMs: null, lastSyncAt: null, candlesLoaded: false },
    polymarket: { status: 'replay', latencyMs: null, lastSyncAt: null, clobVerified: false },
    telegram: {
      mode: 'desk_bridge',
      botUsername: null,
      chatIdConfigured: false,
      unreadCount: 0,
      lastSyncAt: null,
    },
    stt: { provider: detectRuntimeSttProvider() },
  }

  constructor() {
    this.offlineReplay = process.env.OFFLINE_REPLAY === 'true'
    const envAddr = process.env.WATCHED_HL_ADDRESS?.trim()
    this.watchedAddress =
      envAddr && isValidEthAddress(envAddr) ? envAddr : DEFAULT_WATCHED_HL_ADDRESS
    const preset = WATCHED_WALLET_PRESETS.find(
      (p) => p.address.toLowerCase() === this.watchedAddress.toLowerCase(),
    )
    this.watchedLabel = preset?.label ?? shortenAddress(this.watchedAddress)

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
      this.watchedWallet = createFallbackWatchedWallet()
      this.broadcast()
    } else {
      void this.refresh()
    }
    return this.getSnapshot()
  }

  public async setWatchedWallet(address: string, label?: string): Promise<PulseStateSnapshot> {
    const clean = address.trim()
    if (!isValidEthAddress(clean)) {
      throw new Error('Please enter a valid 42-character 0x Hyperliquid public address.')
    }
    this.watchedAddress = clean
    const preset = WATCHED_WALLET_PRESETS.find(
      (p) => p.address.toLowerCase() === clean.toLowerCase(),
    )
    this.watchedLabel = label?.trim() || preset?.label || shortenAddress(clean)

    if (this.offlineReplay) {
      this.watchedWallet = {
        ...createFallbackWatchedWallet(),
        address: this.watchedAddress,
        label: this.watchedLabel,
      }
    } else {
      try {
        this.watchedWallet = await fetchLiveClearinghouseState(
          this.watchedAddress,
          this.watchedLabel,
          this.markMap,
        )
      } catch (err) {
        this.watchedWallet = {
          address: this.watchedAddress,
          label: this.watchedLabel,
          status: 'error',
          accountValueUsd: 0,
          totalMarginUsedUsd: 0,
          marginRatioPct: 0,
          totalUnrealizedPnlUsd: 0,
          withdrawableUsd: 0,
          positions: [],
          updatedAt: Date.now(),
          error: err instanceof Error ? err.message : 'Failed to fetch clearinghouseState',
        }
      }
    }

    this.broadcast()
    return this.getSnapshot()
  }

  public async refresh(): Promise<PulseStateSnapshot> {
    if (this.refreshing) return this.getSnapshot()
    this.refreshing = true

    try {
      if (this.offlineReplay) {
        this.health.hyperliquid.status = 'replay'
        this.health.polymarket.status = 'replay'
        this.watchedWallet = createFallbackWatchedWallet()
      } else {
        const [hlRes, pmRes] = await Promise.allSettled([
          fetchLiveHyperliquidSignals(),
          fetchLivePolymarketSignals(),
        ])

        if (hlRes.status === 'fulfilled' && hlRes.value.signals.length > 0) {
          this.hlSignals = hlRes.value.signals
          this.markMap = hlRes.value.markMap
          this.health.hyperliquid = {
            status: 'live',
            latencyMs: hlRes.value.latencyMs,
            lastSyncAt: Date.now(),
            candlesLoaded: hlRes.value.candlesLoaded,
          }
        } else {
          this.health.hyperliquid = {
            status: 'replay',
            latencyMs: null,
            lastSyncAt: this.health.hyperliquid.lastSyncAt,
            candlesLoaded: false,
            error:
              hlRes.status === 'rejected'
                ? String(hlRes.reason?.message ?? hlRes.reason)
                : 'Empty response',
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
            error:
              pmRes.status === 'rejected'
                ? String(pmRes.reason?.message ?? pmRes.reason)
                : 'Empty response',
          }
        }

        try {
          this.watchedWallet = await fetchLiveClearinghouseState(
            this.watchedAddress,
            this.watchedLabel,
            this.markMap,
          )
        } catch (err) {
          if (this.watchedWallet.status !== 'live') {
            this.watchedWallet = {
              ...createFallbackWatchedWallet(),
              address: this.watchedAddress,
              label: this.watchedLabel,
              error: err instanceof Error ? err.message : 'clearinghouseState fallback',
            }
          }
        }
      }

      this.ledger.seedIfEmpty(this.hlSignals, this.pmSignals)
      this.ledger.markToMarket(this.hlSignals, this.pmSignals)
      this.telegram.seedDeskMessages(this.hlSignals, this.pmSignals)
      this.telegram.refreshDrafts(this.hlSignals, this.pmSignals)
      await this.telegram.pollLiveTelegram(this.hlSignals, this.pmSignals, this.ledger.snapshot())

      this.health.telegram = this.telegram.getHealth()
      this.health.stt.provider = detectRuntimeSttProvider()
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
    const msg = this.telegram.injectInboundMessage(
      sender,
      chatName,
      text,
      this.hlSignals,
      this.pmSignals,
    )
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
      hyperliquid: this.hlSignals.map((s) => ({
        ...s,
        candles15m: s.candles15m.map((c) => ({ ...c })),
      })),
      polymarket: this.pmSignals.map((s) => ({
        ...s,
        sparkline24h: [...s.sparkline24h],
      })),
      telegram: this.telegram.getMessages(),
      watchedWallet: {
        ...this.watchedWallet,
        positions: this.watchedWallet.positions.map((p) => ({ ...p })),
      },
      portfolio: this.ledger.snapshot(),
    }
  }
}
