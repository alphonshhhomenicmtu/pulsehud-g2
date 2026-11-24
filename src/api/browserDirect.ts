import type {
  ExecuteActionResponse,
  FeedHealth,
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PulseStateSnapshot,
  StagedAction,
  VoiceCommandResponse,
  WatchedWalletSnapshot,
} from '../../shared/types.js'
import { PaperLedger } from '../../server/engine/paperLedger.js'
import {
  createFallbackHyperliquidSignals,
  createFallbackPolymarketSignals,
  createFallbackWatchedWallet,
} from '../../server/feeds/fallbackSnapshot.js'
import {
  DEFAULT_WATCHED_HL_ADDRESS,
  fetchLiveClearinghouseState,
  fetchLiveHyperliquidSignals,
  isValidEthAddress,
  shortenAddress,
  WATCHED_WALLET_PRESETS,
} from '../../server/feeds/hyperliquid.js'
import { fetchLivePolymarketSignals } from '../../server/feeds/polymarket.js'
import { formatDigestText, TelegramBridge } from '../../server/telegram/bridge.js'
import { parseVoiceIntent } from '../../server/voice/intent.js'

type Listener = (snapshot: PulseStateSnapshot) => void

/**
 * Zero-install browser-direct market & execution engine for the hosted GitHub Pages
 * 576x288 G2 Simulator Preview. Hits public CORS-enabled Hyperliquid & Polymarket
 * APIs directly from the browser with zero local backend required and zero console errors.
 */
export class BrowserDirectEngine {
  private hlSignals: HyperliquidPerpSignal[] = createFallbackHyperliquidSignals()
  private pmSignals: PolymarketOddsSignal[] = createFallbackPolymarketSignals()
  private markMap = new Map<string, number>()
  private watchedAddress = DEFAULT_WATCHED_HL_ADDRESS
  private watchedLabel = WATCHED_WALLET_PRESETS[0].label
  private watchedWallet: WatchedWalletSnapshot = createFallbackWatchedWallet()
  private offlineReplay = false
  private ledger = new PaperLedger()
  private telegram = new TelegramBridge({ botToken: '', chatId: '' })
  private listeners = new Set<Listener>()
  private pollTimer: number | null = null
  private initialized = false
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
    stt: { provider: 'local_command' },
  }

  public async init(): Promise<PulseStateSnapshot> {
    if (!this.initialized) {
      this.initialized = true
      this.ledger.seedIfEmpty(this.hlSignals, this.pmSignals)
      this.telegram.seedDeskMessages(this.hlSignals, this.pmSignals)
      await this.refresh()
      if (typeof window !== 'undefined' && this.pollTimer === null) {
        this.pollTimer = window.setInterval(() => {
          void this.refresh()
        }, 15_000)
      }
    }
    return this.getSnapshot()
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private broadcast(): void {
    const snap = this.getSnapshot()
    for (const listener of this.listeners) {
      listener(snap)
    }
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
        }

        if (pmRes.status === 'fulfilled' && pmRes.value.signals.length > 0) {
          this.pmSignals = pmRes.value.signals
          this.health.polymarket = {
            status: 'live',
            latencyMs: pmRes.value.latencyMs,
            lastSyncAt: Date.now(),
            clobVerified: pmRes.value.clobVerified,
          }
        }

        try {
          this.watchedWallet = await fetchLiveClearinghouseState(
            this.watchedAddress,
            this.watchedLabel,
            this.markMap,
          )
        } catch {
          if (this.watchedWallet.status !== 'live') {
            this.watchedWallet = createFallbackWatchedWallet()
          }
        }
      }

      this.ledger.seedIfEmpty(this.hlSignals, this.pmSignals)
      this.ledger.markToMarket(this.hlSignals, this.pmSignals)
      this.telegram.seedDeskMessages(this.hlSignals, this.pmSignals)
      this.telegram.refreshDrafts(this.hlSignals, this.pmSignals)
      this.health.telegram = this.telegram.getHealth()
      this.broadcast()
    } finally {
      this.refreshing = false
    }
    return this.getSnapshot()
  }

  public async setWatchedWallet(address: string, label?: string): Promise<PulseStateSnapshot> {
    const clean = address.trim()
    if (!isValidEthAddress(clean)) {
      throw new Error('Please enter a valid 42-character 0x Hyperliquid address.')
    }
    this.watchedAddress = clean
    const preset = WATCHED_WALLET_PRESETS.find(
      (p) => p.address.toLowerCase() === clean.toLowerCase(),
    )
    this.watchedLabel = label?.trim() || preset?.label || shortenAddress(clean)

    if (this.offlineReplay) {
      this.watchedWallet = {
        ...createFallbackWatchedWallet(),
        address: clean,
        label: this.watchedLabel,
      }
    } else {
      this.watchedWallet = await fetchLiveClearinghouseState(
        this.watchedAddress,
        this.watchedLabel,
        this.markMap,
      )
    }

    this.broadcast()
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

  public processVoiceCommand(payload: {
    transcript?: string
    activeSignalId?: string
  }): VoiceCommandResponse {
    const transcript = (payload.transcript ?? '').trim()
    const snap = this.getSnapshot()
    const stagedAction = transcript
      ? parseVoiceIntent(transcript, {
          hl: snap.hyperliquid,
          pm: snap.polymarket,
          tg: snap.telegram,
          portfolio: snap.portfolio,
          activeSignalId: payload.activeSignalId,
        })
      : null

    return {
      ok: true,
      transcript,
      provider: 'local_command',
      stagedAction,
      notice: stagedAction
        ? 'Parsed spoken intent — tap arms 2.0s undo countdown on G2'
        : transcript
          ? `Heard "${transcript}" — try "Paper short 1000 BTC", "Take 50% BTC", or "Reply: hedging now"`
          : 'Speak using Browser Mic or enter a command below to stage on G2.',
    }
  }

  public injectInboundTelegram(payload: {
    sender: string
    chatName: string
    text: string
  }): { ok: boolean; state: PulseStateSnapshot } {
    this.telegram.injectInboundMessage(
      payload.sender,
      payload.chatName,
      payload.text,
      this.hlSignals,
      this.pmSignals,
    )
    this.health.telegram = this.telegram.getHealth()
    const state = this.getSnapshot()
    this.broadcast()
    return { ok: true, state }
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
