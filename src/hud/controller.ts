import {
  AudioInputSource,
  ImageRawDataUpdate,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type {
  ExecuteActionResponse,
  HudChannel,
  PulseStateSnapshot,
  SignalCard,
  StagedAction,
} from '../../shared/types.js'
import { executeStagedAction, sendVoiceCommand } from '../api/client.js'
import { GlassesAudioCapture } from './audio.js'
import { normalizeEvenHubEvent, type NormalizedHudGesture } from './events.js'
import {
  buildHudPage,
  MENU_IDS,
  toRebuildPageContainer,
  toStartUpPageContainer,
  type BuiltHudPage,
  type ConfirmPhase,
  type HudLayoutKey,
  type HudRenderModel,
  type HudScreenKind,
} from './layout.js'

const HL_ORDER_SIZES = [250, 500, 1000, 2500] as const
const PM_STAKE_SIZES = [25, 50, 100, 250] as const
export const UNDO_SAFETY_WINDOW_MS = 2000

export interface HudSnapshotListener {
  (view: { model: HudRenderModel; page: BuiltHudPage; bridgeConnected: boolean }): void
}

export interface PulseHudControllerOptions {
  undoWindowMs?: number
  executeActionFn?: (action: StagedAction) => Promise<ExecuteActionResponse>
}

export class PulseHudController {
  private bridge: EvenAppBridge | null
  private state: PulseStateSnapshot
  private screen: HudScreenKind = 'feed'
  private channel: HudChannel = 'all'
  private borderlessOptics = true
  private hlSizeIdx = 2 // Default $1,000
  private pmSizeIdx = 1 // Default $50
  private signalIndex = 0
  private actions: StagedAction[] = []
  private actionIndex = 0
  private stagedAction: StagedAction | null = null
  private confirmSelection: 'confirm' | 'cancel' = 'confirm'

  // 2.0-second Post-Tap Undo Safety Window state machine (idle -> armed -> committing -> done)
  private readonly undoWindowMs: number
  private confirmPhase: ConfirmPhase = 'idle'
  private confirmCommitId = 0
  private confirmArmedUntil: number | null = null
  private confirmTickTimer: ReturnType<typeof setInterval> | null = null
  private confirmCommitTimer: ReturnType<typeof setTimeout> | null = null

  private readonly executeActionFn: (action: StagedAction) => Promise<ExecuteActionResponse>

  private voiceCapture = new GlassesAudioCapture()
  private voiceStatusLine = 'Hold temple or R1 ring to dictate a command.'
  private voiceTick = 0
  private voiceTimer: ReturnType<typeof setInterval> | null = null
  private toast: string | null = null
  private toastTimer: ReturnType<typeof setTimeout> | null = null

  private pageInitialized = false
  private currentLayoutKey: HudLayoutKey | null = null
  private lastRenderedContents = new Map<number, string>()
  private lastRenderedImages = new Map<number, string>()
  private renderQueue: Promise<void> = Promise.resolve()
  private listeners = new Set<HudSnapshotListener>()
  private unsubscribeBridge: (() => void) | null = null

  constructor(
    bridge: EvenAppBridge | null,
    initialState: PulseStateSnapshot,
    options: PulseHudControllerOptions = {},
  ) {
    this.bridge = bridge
    this.state = initialState
    this.undoWindowMs = options.undoWindowMs ?? UNDO_SAFETY_WINDOW_MS
    this.executeActionFn = options.executeActionFn ?? executeStagedAction
  }

  public async mount(): Promise<void> {
    if (this.bridge) {
      this.unsubscribeBridge = this.bridge.onEvenHubEvent((event) => {
        void this.handleRawEvent(event)
      })
    }
    await this.syncDisplay(true)
  }

  public destroy(): void {
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = null
    this.confirmCommitId += 1
    this.confirmPhase = 'done'
    this.clearUndoTimers()
    if (this.voiceTimer !== null) {
      clearInterval(this.voiceTimer)
      this.voiceTimer = null
    }
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
      this.toastTimer = null
    }
    if (this.voiceCapture.isActive()) {
      void this.bridge?.audioControl(false)
    }
  }

  public subscribe(listener: HudSnapshotListener): () => void {
    this.listeners.add(listener)
    const model = this.getRenderModel()
    listener({
      model,
      page: buildHudPage(model),
      bridgeConnected: Boolean(this.bridge),
    })
    return () => this.listeners.delete(listener)
  }

  public setState(next: PulseStateSnapshot): void {
    this.state = next
    const list = this.getVisibleSignals()
    if (this.signalIndex >= list.length) {
      this.signalIndex = Math.max(0, list.length - 1)
    }
    void this.syncDisplay(false)
  }

  public toggleBorderlessOptics(): void {
    this.borderlessOptics = !this.borderlessOptics
    // Border geometry changed -> force rebuild next render
    this.currentLayoutKey = null
    void this.syncDisplay(false)
  }

  public getHlOrderSizeUsd(): number {
    return HL_ORDER_SIZES[this.hlSizeIdx]
  }

  public getPmStakeSizeUsd(): number {
    return PM_STAKE_SIZES[this.pmSizeIdx]
  }

  public getVisibleSignals(): SignalCard[] {
    if (this.channel === 'hyperliquid') return this.state.hyperliquid
    if (this.channel === 'polymarket') return this.state.polymarket
    if (this.channel === 'telegram') return this.state.telegram

    const mixed: SignalCard[] = []
    const maxLen = Math.max(
      this.state.hyperliquid.length,
      this.state.polymarket.length,
      this.state.telegram.length,
    )
    for (let i = 0; i < maxLen; i += 1) {
      if (this.state.hyperliquid[i]) mixed.push(this.state.hyperliquid[i])
      if (this.state.polymarket[i]) mixed.push(this.state.polymarket[i])
      if (this.state.telegram[i]) mixed.push(this.state.telegram[i])
    }
    return mixed
  }

  public getActiveSignal(): SignalCard | undefined {
    const list = this.getVisibleSignals()
    return list[this.signalIndex]
  }

  public getRenderModel(): HudRenderModel {
    const armed = this.confirmPhase === 'armed' && this.confirmArmedUntil !== null
    const remainingMs = armed
      ? Math.max(0, this.confirmArmedUntil! - Date.now())
      : this.confirmPhase === 'committing'
        ? 0
        : this.undoWindowMs

    return {
      screen: this.screen,
      channel: this.channel,
      borderlessOptics: this.borderlessOptics,
      hlOrderSizeUsd: this.getHlOrderSizeUsd(),
      pmStakeSizeUsd: this.getPmStakeSizeUsd(),
      state: this.state,
      signals: this.getVisibleSignals(),
      signalIndex: this.signalIndex,
      actions: this.actions,
      actionIndex: this.actionIndex,
      stagedAction: this.stagedAction,
      confirmSelection: this.confirmSelection,
      confirmPhase: this.confirmPhase,
      confirmArmed: armed,
      confirmRemainingMs: remainingMs,
      confirmTotalMs: this.undoWindowMs,
      voiceActive: this.voiceCapture.isActive(),
      voiceStatusLine: this.voiceStatusLine,
      voiceDurationMs: this.voiceCapture.getDurationMs(),
      voiceLevel: this.voiceCapture.getLevel(),
      voiceTick: this.voiceTick,
      toast: this.toast,
    }
  }

  public showToast(message: string, durationMs = 4500): void {
    this.toast = message
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer)
    }
    this.toastTimer = setTimeout(() => {
      this.toast = null
      this.toastTimer = null
      void this.syncDisplay(false)
    }, durationMs)
    void this.syncDisplay(false)
  }

  public async handleRawEvent(event: EvenHubEvent): Promise<void> {
    const gesture = normalizeEvenHubEvent(event)
    await this.dispatchGesture(gesture)
  }

  public async dispatchGesture(gesture: NormalizedHudGesture): Promise<void> {
    if (gesture.kind === 'ignore') return

    if (gesture.kind === 'foreground_change') {
      return
    }

    if (gesture.kind === 'system_exit') {
      this.destroy()
      return
    }

    if (gesture.kind === 'audio_pcm') {
      this.voiceCapture.pushPcm(gesture.pcm)
      return
    }

    // Lock tap, double-tap, scroll, long-press, and menu while an action is committing
    if (this.confirmPhase === 'committing') {
      return
    }

    if (gesture.kind === 'menu_item') {
      await this.handleMenuSelection(gesture.itemID)
      return
    }

    if (gesture.kind === 'long_press') {
      if (this.confirmPhase === 'armed') {
        this.clearUndoTimers()
        this.confirmPhase = 'done'
        this.stagedAction = null
      } else {
        this.clearUndoTimers()
      }
      await this.beginVoiceCapture()
      return
    }

    if (gesture.kind === 'long_press_release') {
      if (this.screen === 'voice' && this.voiceCapture.isActive()) {
        await this.finishVoiceCapture()
      }
      return
    }

    // Feed screen
    if (this.screen === 'feed') {
      if (gesture.kind === 'double_click') {
        await this.bridge?.shutDownPageContainer(1)
        return
      }
      if (gesture.kind === 'scroll_down') {
        const list = this.getVisibleSignals()
        if (list.length > 0) {
          this.signalIndex = (this.signalIndex + 1) % list.length
          await this.syncDisplay(false)
        }
        return
      }
      if (gesture.kind === 'scroll_up') {
        const list = this.getVisibleSignals()
        if (list.length > 0) {
          this.signalIndex = (this.signalIndex - 1 + list.length) % list.length
          await this.syncDisplay(false)
        }
        return
      }
      if (gesture.kind === 'click') {
        const active = this.getActiveSignal()
        if (!active) return
        this.actions = this.buildActionsForSignal(active)
        this.actionIndex = 0
        this.screen = 'actions'
        await this.syncDisplay(false)
        return
      }
    }

    // Action Picker screen
    if (this.screen === 'actions') {
      if (gesture.kind === 'double_click') {
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      }
      if (gesture.kind === 'scroll_down' && this.actions.length > 0) {
        this.actionIndex = (this.actionIndex + 1) % this.actions.length
        await this.syncDisplay(false)
        return
      }
      if (gesture.kind === 'scroll_up' && this.actions.length > 0) {
        this.actionIndex = (this.actionIndex - 1 + this.actions.length) % this.actions.length
        await this.syncDisplay(false)
        return
      }
      if (gesture.kind === 'click') {
        const chosen = this.actions[this.actionIndex]
        if (!chosen) return

        // Immediate non-destructive UI commands (dynamic size cycle / Coin-Locked TG->Trade jump)
        if (chosen.uiCommand === 'cycle_hl_size') {
          this.hlSizeIdx = (this.hlSizeIdx + 1) % HL_ORDER_SIZES.length
          const active = this.getActiveSignal()
          if (active) {
            this.actions = this.buildActionsForSignal(active)
          }
          await this.syncDisplay(false)
          return
        }

        if (chosen.uiCommand === 'cycle_pm_size') {
          this.pmSizeIdx = (this.pmSizeIdx + 1) % PM_STAKE_SIZES.length
          const active = this.getActiveSignal()
          if (active) {
            this.actions = this.buildActionsForSignal(active)
          }
          await this.syncDisplay(false)
          return
        }

        if (chosen.uiCommand === 'jump_coin_trade' && chosen.coin) {
          const hlIdx = this.state.hyperliquid.findIndex(
            (s) => s.coin.toUpperCase() === chosen.coin!.toUpperCase(),
          )
          const targetSignal =
            hlIdx >= 0 ? this.state.hyperliquid[hlIdx] : this.state.hyperliquid[0]
          if (targetSignal) {
            this.channel = 'hyperliquid'
            this.signalIndex = Math.max(0, hlIdx)
            this.actions = this.buildActionsForSignal(targetSignal)
            this.actionIndex = 0
            this.screen = 'actions'
            await this.syncDisplay(false)
          }
          return
        }

        this.openConfirmGate(chosen)
        await this.syncDisplay(false)
        return
      }
    }

    // Confirm Gate + 2.0-Second Post-Tap Undo Safety Window ('committing' already locked above)
    if (this.screen === 'confirm') {
      // During the 2.0s Armed Countdown Window: ANY single tap OR double-tap cancels cleanly!
      if (this.confirmPhase === 'armed') {
        if (gesture.kind === 'click' || gesture.kind === 'double_click') {
          this.cancelArmedUndo()
        }
        return
      }
      if (this.confirmPhase !== 'idle') {
        return
      }

      if (gesture.kind === 'double_click') {
        this.confirmPhase = 'done'
        this.stagedAction = null
        this.screen = 'feed'
        this.showToast('Action cancelled')
        return
      }
      if (gesture.kind === 'scroll_up' || gesture.kind === 'scroll_down') {
        this.confirmSelection = this.confirmSelection === 'confirm' ? 'cancel' : 'confirm'
        await this.syncDisplay(false)
        return
      }
      if (gesture.kind === 'click') {
        if (this.confirmSelection === 'cancel' || !this.stagedAction) {
          this.confirmPhase = 'done'
          this.stagedAction = null
          this.screen = 'feed'
          this.showToast('Action cancelled')
          return
        }
        // Arm the 2.0-second Undo Safety Window strictly from 'idle'
        this.armUndoCountdown()
        return
      }
    }

    // Voice screen
    if (this.screen === 'voice') {
      if (gesture.kind === 'double_click') {
        await this.cancelVoiceCapture()
        return
      }
      if (gesture.kind === 'click') {
        if (this.voiceCapture.isActive()) {
          await this.finishVoiceCapture()
        } else {
          this.screen = 'feed'
          await this.syncDisplay(false)
        }
        return
      }
    }

    // Live Public Hyperliquid Wallet Watcher screen
    if (this.screen === 'wallet') {
      if (
        gesture.kind === 'double_click' ||
        gesture.kind === 'scroll_up' ||
        gesture.kind === 'scroll_down'
      ) {
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      }
      if (gesture.kind === 'click') {
        const topWatched = this.state.watchedWallet.positions[0]
        if (!topWatched) {
          this.screen = 'feed'
          this.showToast('No open positions on watched wallet')
          return
        }
        const hedgeSide = topWatched.side === 'LONG' ? 'SHORT' : 'LONG'
        const sizeUsd = this.getHlOrderSizeUsd()
        this.openConfirmGate({
          id: `stage-watch-${Date.now()}`,
          type: hedgeSide === 'SHORT' ? 'hl_paper_short' : 'hl_paper_long',
          label: `Paper ${hedgeSide} $${sizeUsd} ${topWatched.coin}`,
          headline: `HEDGE WATCHED ${topWatched.coin} (${hedgeSide})`,
          summary: `Counter-hedge ${topWatched.side} ${topWatched.coin} $${sizeUsd} paper @ $${topWatched.markPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
          riskNote: 'PAPER MODE ONLY · Mirrors read-only public HL watcher · 2s undo.',
          coin: topWatched.coin,
          notionalUsd: sizeUsd,
          limitPrice: topWatched.markPx,
          source: 'tap',
        })
        await this.syncDisplay(false)
        return
      }
    }

    // Paper Portfolio screen
    if (this.screen === 'portfolio') {
      if (
        gesture.kind === 'double_click' ||
        gesture.kind === 'scroll_up' ||
        gesture.kind === 'scroll_down'
      ) {
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      }
      if (gesture.kind === 'click') {
        const topPos = this.state.portfolio.positions[0]
        if (!topPos) {
          this.screen = 'feed'
          this.showToast('Portfolio is already flat')
          return
        }
        const coin =
          topPos.venue === 'hyperliquid' ? topPos.symbol.replace('-PERP', '') : undefined
        this.openConfirmGate({
          id: `stage-${Date.now()}`,
          type: 'hl_flatten',
          label: `Flatten ${topPos.symbol}`,
          headline: `PAPER FLATTEN ${topPos.symbol}`,
          summary: `Close ${topPos.side} paper position at live mark (uPnL ${topPos.unrealizedPnlUsd >= 0 ? '+' : ''}$${topPos.unrealizedPnlUsd.toFixed(2)}).`,
          riskNote: 'PAPER MODE ONLY · Tap arms 2.0s undo countdown.',
          coin,
          source: 'tap',
        })
        await this.syncDisplay(false)
        return
      }
    }
  }

  public async handleMenuSelection(itemID: number): Promise<void> {
    if (this.confirmPhase === 'committing') {
      return
    }
    if (this.confirmPhase === 'armed') {
      this.clearUndoTimers()
      this.confirmPhase = 'done'
      this.stagedAction = null
    } else {
      this.clearUndoTimers()
    }
    if (this.voiceCapture.isActive()) {
      await this.cancelVoiceCapture()
    }

    switch (itemID) {
      case MENU_IDS.ALL_SIGNALS:
        this.channel = 'all'
        this.signalIndex = 0
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      case MENU_IDS.HYPERLIQUID:
        this.channel = 'hyperliquid'
        this.signalIndex = 0
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      case MENU_IDS.POLYMARKET:
        this.channel = 'polymarket'
        this.signalIndex = 0
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      case MENU_IDS.TELEGRAM_DESK:
        this.channel = 'telegram'
        this.signalIndex = 0
        this.screen = 'feed'
        await this.syncDisplay(false)
        return
      case MENU_IDS.WALLET_WATCH:
        this.screen = 'wallet'
        await this.syncDisplay(false)
        return
      case MENU_IDS.PORTFOLIO:
        this.screen = 'portfolio'
        await this.syncDisplay(false)
        return
      case MENU_IDS.SEND_DIGEST: {
        const btc = this.state.hyperliquid[0]
        const pm = this.state.polymarket[0]
        const preview = btc
          ? `${btc.coin} $${Math.round(btc.markPx).toLocaleString('en-US')} · ${pm ? `${pm.shortTitle} ${Math.round(pm.yesPrice * 100)}c` : 'Polymarket live'}`
          : 'Send live market & paper PnL snapshot to Telegram Desk.'
        this.openConfirmGate({
          id: `stage-${Date.now()}`,
          type: 'tg_broadcast_digest',
          label: 'Send Digest -> TG',
          headline: 'POST LIVE DIGEST -> TELEGRAM',
          summary: preview,
          riskNote: 'Read-only digest · Tap arms 2.0s undo countdown.',
          source: 'menu',
        })
        await this.syncDisplay(false)
        return
      }
      default:
        return
    }
  }

  public async submitTranscriptFromCompanion(transcript: string): Promise<string> {
    if (this.confirmPhase === 'committing') {
      return 'A write action is currently committing — wait for the receipt.'
    }
    const active = this.getActiveSignal()
    const response = await sendVoiceCommand({
      transcript,
      activeSignalId: active?.id,
    })
    if (response.stagedAction) {
      this.openConfirmGate(response.stagedAction)
      await this.syncDisplay(false)
      return `Staged "${response.stagedAction.headline}" on G2 — tap arms 2.0s undo window.`
    }
    this.showToast(response.notice)
    return response.notice
  }

  private openConfirmGate(action: StagedAction): void {
    if (this.confirmPhase === 'committing') return
    this.clearUndoTimers()
    this.confirmPhase = 'idle'
    this.stagedAction = action
    this.confirmSelection = 'confirm'
    this.screen = 'confirm'
  }

  private clearUndoTimers(): void {
    this.confirmArmedUntil = null
    if (this.confirmTickTimer !== null) {
      clearInterval(this.confirmTickTimer)
      this.confirmTickTimer = null
    }
    if (this.confirmCommitTimer !== null) {
      clearTimeout(this.confirmCommitTimer)
      this.confirmCommitTimer = null
    }
  }

  private armUndoCountdown(): void {
    // Re-arm strictly from 'idle' only
    if (this.confirmPhase !== 'idle' || !this.stagedAction) return
    this.clearUndoTimers()
    this.confirmPhase = 'armed'
    this.confirmArmedUntil = Date.now() + this.undoWindowMs
    void this.syncDisplay(false)

    // 4Hz visual countdown updates for both text progress bar AND 4-bit ring graphic
    this.confirmTickTimer = setInterval(() => {
      if (this.confirmPhase !== 'armed' || this.confirmArmedUntil === null) return
      void this.syncDisplay(false)
    }, 250)

    this.confirmCommitTimer = setTimeout(() => {
      this.clearUndoTimers()
      if (this.confirmPhase !== 'armed') return
      void this.commitStagedAction()
    }, this.undoWindowMs)
  }

  private cancelArmedUndo(): void {
    if (this.confirmPhase !== 'armed') return
    this.clearUndoTimers()
    this.confirmPhase = 'done'
    const label = this.stagedAction?.headline ?? 'Action'
    this.stagedAction = null
    this.screen = 'feed'
    this.showToast(`UNDONE · Cancelled ${label}`)
  }

  private async commitStagedAction(): Promise<void> {
    if (this.confirmPhase !== 'armed') return
    const action = this.stagedAction
    if (!action) {
      this.confirmPhase = 'done'
      return
    }
    // Enter 'committing' synchronously before any await so a tap at 0.0s can never re-arm or double-send
    this.confirmPhase = 'committing'
    const commitId = ++this.confirmCommitId
    void this.syncDisplay(false)

    try {
      const result = await this.executeActionFn(action)
      if (this.confirmCommitId !== commitId || this.confirmPhase !== 'committing') {
        return
      }
      this.confirmPhase = 'done'
      this.state = result.state
      this.stagedAction = null
      this.screen = 'feed'
      this.showToast(result.toast)
    } catch (err) {
      if (this.confirmCommitId !== commitId || this.confirmPhase !== 'committing') {
        return
      }
      const msg = err instanceof Error ? err.message : 'Execution error'
      this.confirmPhase = 'done'
      this.stagedAction = null
      this.screen = 'feed'
      this.showToast(`ERR: ${msg}`)
    }
  }

  private async beginVoiceCapture(): Promise<void> {
    this.voiceCapture.start()
    this.voiceTick = 0
    this.voiceStatusLine = 'Listening on G2 4-mic array...'
    this.screen = 'voice'
    await this.syncDisplay(false)
    void Promise.race([
      this.bridge?.audioControl(true, AudioInputSource.Glasses).catch(() => false),
      new Promise((r) => setTimeout(r, 1200)),
    ])
    if (this.voiceTimer !== null) {
      clearInterval(this.voiceTimer)
    }
    this.voiceTimer = setInterval(() => {
      this.voiceTick += 1
      void this.syncDisplay(false)
    }, 280)
  }

  private async cancelVoiceCapture(): Promise<void> {
    if (this.voiceTimer !== null) {
      clearInterval(this.voiceTimer)
      this.voiceTimer = null
    }
    this.voiceCapture.stopAndEncodeBase64()
    void Promise.race([
      this.bridge?.audioControl(false).catch(() => false),
      new Promise((r) => setTimeout(r, 800)),
    ])
    this.screen = 'feed'
    this.showToast('Voice cancelled')
  }

  private async finishVoiceCapture(): Promise<void> {
    if (this.voiceTimer !== null) {
      clearInterval(this.voiceTimer)
      this.voiceTimer = null
    }
    void Promise.race([
      this.bridge?.audioControl(false).catch(() => false),
      new Promise((r) => setTimeout(r, 800)),
    ])
    const captured = this.voiceCapture.stopAndEncodeBase64()
    this.voiceStatusLine = `Processing ${captured.bytes} bytes PCM (${(captured.durationMs / 1000).toFixed(1)}s)...`
    await this.syncDisplay(false)

    try {
      const active = this.getActiveSignal()
      const res = await sendVoiceCommand({
        pcmBase64: captured.base64,
        activeSignalId: active?.id,
      })
      if (res.stagedAction) {
        this.openConfirmGate(res.stagedAction)
        await this.syncDisplay(false)
        return
      }
      this.voiceStatusLine = res.notice
      await this.syncDisplay(false)
    } catch (err) {
      this.voiceStatusLine =
        err instanceof Error ? err.message : 'Voice processing failed. Double-tap to return.'
      await this.syncDisplay(false)
    }
  }

  private buildActionsForSignal(signal: SignalCard): StagedAction[] {
    const now = Date.now()
    if (signal.kind === 'hyperliquid') {
      const sizeUsd = this.getHlOrderSizeUsd()
      const longPx = signal.bestAsk ?? signal.markPx
      const shortPx = signal.bestBid ?? signal.markPx
      const existingPos = this.state.portfolio.positions.find(
        (p) => p.venue === 'hyperliquid' && p.symbol === `${signal.coin}-PERP`,
      )
      const alertText = `[PulseHUD G2] Hyperliquid ${signal.coin}-PERP $${signal.markPx.toLocaleString('en-US')} (${signal.change24hPct >= 0 ? '+' : ''}${signal.change24hPct}% 24h | Funding ${signal.fundingAprPct >= 0 ? '+' : ''}${signal.fundingAprPct}% APR)`

      const list: StagedAction[] = [
        {
          id: `act-short-${now}`,
          type: 'hl_paper_short',
          label: `Paper Short $${sizeUsd.toLocaleString('en-US')} ${signal.coin} (Hedge)`,
          headline: `HYPERLIQUID PAPER SHORT ${signal.coin}`,
          summary: `$${sizeUsd.toLocaleString('en-US')} notional @ $${shortPx.toLocaleString('en-US', { maximumFractionDigits: 2 })} (live L2 bid)`,
          riskNote: 'PAPER MODE ONLY · Zero custody · 2.0s post-tap undo window.',
          signalId: signal.id,
          coin: signal.coin,
          notionalUsd: sizeUsd,
          limitPrice: shortPx,
          source: 'tap',
        },
        {
          id: `act-long-${now}`,
          type: 'hl_paper_long',
          label: `Paper Long $${sizeUsd.toLocaleString('en-US')} ${signal.coin} (Market)`,
          headline: `HYPERLIQUID PAPER LONG ${signal.coin}`,
          summary: `$${sizeUsd.toLocaleString('en-US')} notional @ $${longPx.toLocaleString('en-US', { maximumFractionDigits: 2 })} (live L2 ask)`,
          riskNote: 'PAPER MODE ONLY · Zero custody · 2.0s post-tap undo window.',
          signalId: signal.id,
          coin: signal.coin,
          notionalUsd: sizeUsd,
          limitPrice: longPx,
          source: 'tap',
        },
        {
          id: `act-size-${now}`,
          type: 'hl_paper_short',
          label: `Order Size: $${sizeUsd.toLocaleString('en-US')}  [Tap to Cycle $250/$500/$1k/$2.5k]`,
          headline: 'CYCLE SIZE',
          summary: '',
          riskNote: '',
          coin: signal.coin,
          uiCommand: 'cycle_hl_size',
          source: 'tap',
        },
      ]

      if (existingPos) {
        list.push(
          {
            id: `act-partial-${now}`,
            type: 'hl_partial_close',
            label: `Take 50% Partial Close ${signal.coin} (${existingPos.side})`,
            headline: `PARTIAL 50% CLOSE ${signal.coin}-PERP`,
            summary: `Trim 50% of ${existingPos.size} ${signal.coin} @ $${signal.markPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
            riskNote: 'PAPER MODE ONLY · Locks realized PnL · 2.0s undo window.',
            signalId: signal.id,
            coin: signal.coin,
            closeFraction: 0.5,
            source: 'tap',
          },
          {
            id: `act-be-${now}`,
            type: 'hl_move_sl_be',
            label: `Move ${signal.coin} Stop -> Break-Even ($${existingPos.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 1 })})`,
            headline: `MOVE STOP TO BE · ${signal.coin}-PERP`,
            summary: `Arm protective break-even stop @ $${existingPos.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
            riskNote: 'PAPER MODE ONLY · Zero custody · 2.0s undo window.',
            signalId: signal.id,
            coin: signal.coin,
            source: 'tap',
          },
        )
      }

      list.push({
        id: `act-tg-${now}`,
        type: 'tg_share_signal',
        label: `Post ${signal.coin} Alert -> Telegram Desk`,
        headline: `POST ${signal.coin} ALERT -> TELEGRAM`,
        summary: alertText,
        riskNote: 'Read-only market alert · Tap arms 2.0s undo countdown.',
        signalId: signal.id,
        telegramText: alertText,
        source: 'tap',
      })

      return list
    }

    if (signal.kind === 'polymarket') {
      const stakeUsd = this.getPmStakeSizeUsd()
      const yesCents = Math.round((signal.bestAsk ?? signal.yesPrice) * 100)
      const noCents = Math.round(signal.noPrice * 100)
      const callText = `[PulseHUD G2] Polymarket "${signal.shortTitle}" — YES ${Math.round(signal.yesPrice * 100)}c (${signal.change24hCents >= 0 ? '+' : ''}${signal.change24hCents}c 24h)`

      return [
        {
          id: `act-yes-${now}`,
          type: 'pm_paper_yes',
          label: `Paper Buy YES $${stakeUsd} @ ${yesCents}c`,
          headline: `POLYMARKET PAPER YES $${stakeUsd}`,
          summary: `${signal.shortTitle} @ ${yesCents}c live CLOB`,
          riskNote: 'PAPER MODE ONLY · Live CLOB odds · 2.0s undo window.',
          signalId: signal.id,
          marketId: signal.marketId,
          notionalUsd: stakeUsd,
          limitPrice: signal.bestAsk ?? signal.yesPrice,
          source: 'tap',
        },
        {
          id: `act-no-${now}`,
          type: 'pm_paper_no',
          label: `Paper Buy NO $${stakeUsd} @ ${noCents}c`,
          headline: `POLYMARKET PAPER NO $${stakeUsd}`,
          summary: `${signal.shortTitle} — NO @ ${noCents}c`,
          riskNote: 'PAPER MODE ONLY · Live CLOB odds · 2.0s undo window.',
          signalId: signal.id,
          marketId: signal.marketId,
          notionalUsd: stakeUsd,
          limitPrice: signal.noPrice,
          source: 'tap',
        },
        {
          id: `act-pmsize-${now}`,
          type: 'pm_paper_yes',
          label: `Stake Size: $${stakeUsd}  [Tap to Cycle $25/$50/$100/$250]`,
          headline: 'CYCLE STAKE',
          summary: '',
          riskNote: '',
          uiCommand: 'cycle_pm_size',
          source: 'tap',
        },
        {
          id: `act-pm-tg-${now}`,
          type: 'tg_share_signal',
          label: 'Share Odds Call -> Telegram Desk',
          headline: 'SHARE ODDS -> TELEGRAM DESK',
          summary: callText,
          riskNote: 'Tap arms 2.0s undo countdown before Telegram post.',
          signalId: signal.id,
          telegramText: callText,
          source: 'tap',
        },
      ]
    }

    // Telegram Desk smart drafts + Coin-Locked TG->Trade jump & direct hedge!
    const tgActions: StagedAction[] = signal.smartDrafts.slice(0, 3).map((draft, idx) => ({
      id: `act-tgdraft-${idx}-${now}`,
      type: 'tg_reply',
      label: draft,
      headline: `TG REPLY -> ${signal.chatName}`,
      summary: `"${draft}"`,
      riskNote: `Replying to ${signal.sender} · Tap arms 2.0s undo countdown.`,
      signalId: signal.id,
      telegramChatId: signal.chatId,
      telegramText: draft,
      source: 'tap',
    }))

    if (signal.linkedCoin) {
      const coin = signal.linkedCoin
      const hlMarket = this.state.hyperliquid.find((s) => s.coin === coin)
      const sizeUsd = this.getHlOrderSizeUsd()
      const px = hlMarket ? (hlMarket.bestBid ?? hlMarket.markPx) : 0

      tgActions.push({
        id: `act-coinlock-jump-${now}`,
        type: 'hl_paper_short',
        label: `[COIN-LOCK] Open ${coin}-PERP Trade Controls ->`,
        headline: `TRADE ${coin}-PERP`,
        summary: '',
        riskNote: '',
        coin,
        uiCommand: 'jump_coin_trade',
        source: 'tap',
      })

      if (hlMarket) {
        tgActions.push({
          id: `act-coinlock-hedge-${now}`,
          type: 'hl_paper_short',
          label: `[COIN-LOCK] Stage Paper Short $${sizeUsd.toLocaleString('en-US')} ${coin}`,
          headline: `TG->TRADE PAPER SHORT ${coin}`,
          summary: `Coin-locked from ${signal.sender}: $${sizeUsd.toLocaleString('en-US')} ${coin} @ $${px.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
          riskNote: 'PAPER MODE ONLY · Coin-locked TG->Trade · 2.0s undo window.',
          signalId: hlMarket.id,
          coin,
          notionalUsd: sizeUsd,
          limitPrice: px,
          source: 'tap',
        })
      }
    }

    return tgActions
  }

  private async pushImages(page: BuiltHudPage, forceAll: boolean): Promise<void> {
    if (!this.bridge || page.imageSlots.length === 0) return
    for (const img of page.imageSlots) {
      if (!forceAll && this.lastRenderedImages.get(img.containerID) === img.fingerprint) {
        continue
      }
      await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: img.containerID,
          containerName: img.containerName,
          imageData: Array.from(img.pngBytes),
        }),
      )
      this.lastRenderedImages.set(img.containerID, img.fingerprint)
    }
  }

  private async syncDisplay(forceStartup: boolean): Promise<void> {
    const model = this.getRenderModel()
    const page = buildHudPage(model)

    for (const listener of this.listeners) {
      listener({ model, page, bridgeConnected: Boolean(this.bridge) })
    }

    if (!this.bridge) return

    this.renderQueue = this.renderQueue.then(async () => {
      if (!this.bridge) return

      if (forceStartup || !this.pageInitialized) {
        const res = await this.bridge.createStartUpPageContainer(toStartUpPageContainer(page))
        if (res === 0) {
          this.pageInitialized = true
          this.currentLayoutKey = page.layoutKey
          this.lastRenderedContents.clear()
          this.lastRenderedImages.clear()
          for (const slot of page.slots) {
            this.lastRenderedContents.set(slot.containerID, `${slot.textColor}:${slot.content}`)
          }
          await this.pushImages(page, true)
        } else {
          console.error('[PulseHUD] createStartUpPageContainer returned error code:', res)
        }
        return
      }

      if (this.currentLayoutKey !== page.layoutKey) {
        const ok = await this.bridge.rebuildPageContainer(toRebuildPageContainer(page))
        if (ok) {
          this.currentLayoutKey = page.layoutKey
          this.lastRenderedContents.clear()
          this.lastRenderedImages.clear()
          for (const slot of page.slots) {
            this.lastRenderedContents.set(slot.containerID, `${slot.textColor}:${slot.content}`)
          }
          await this.pushImages(page, true)
        }
        return
      }

      // Same layout geometry -> flicker-free in-place textContainerUpgrade + updateImageRawData!
      for (const slot of page.slots) {
        const fingerprint = `${slot.textColor}:${slot.content}`
        if (this.lastRenderedContents.get(slot.containerID) === fingerprint) continue
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: slot.containerID,
            containerName: slot.containerName,
            content: slot.content,
            textColor: slot.textColor,
          }),
        )
        this.lastRenderedContents.set(slot.containerID, fingerprint)
      }

      await this.pushImages(page, false)
    })

    await this.renderQueue
  }
}
