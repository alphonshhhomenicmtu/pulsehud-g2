import {
  AudioInputSource,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type {
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
  type HudRenderModel,
  type HudScreenKind,
} from './layout.js'

export interface HudSnapshotListener {
  (view: { model: HudRenderModel; page: BuiltHudPage; bridgeConnected: boolean }): void
}

export class PulseHudController {
  private bridge: EvenAppBridge | null
  private state: PulseStateSnapshot
  private screen: HudScreenKind = 'feed'
  private channel: HudChannel = 'all'
  private signalIndex = 0
  private actions: StagedAction[] = []
  private actionIndex = 0
  private stagedAction: StagedAction | null = null
  private confirmSelection: 'confirm' | 'cancel' = 'confirm'
  private voiceCapture = new GlassesAudioCapture()
  private voiceStatusLine = 'Hold temple or R1 ring to dictate a command.'
  private voiceTick = 0
  private voiceTimer: number | null = null
  private toast: string | null = null
  private toastTimer: number | null = null

  private pageInitialized = false
  private currentLayoutKey: HudScreenKind | null = null
  private lastRenderedContents = new Map<number, string>()
  private renderQueue: Promise<void> = Promise.resolve()
  private listeners = new Set<HudSnapshotListener>()
  private unsubscribeBridge: (() => void) | null = null

  constructor(bridge: EvenAppBridge | null, initialState: PulseStateSnapshot) {
    this.bridge = bridge
    this.state = initialState
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
    if (this.voiceTimer !== null) {
      window.clearInterval(this.voiceTimer)
      this.voiceTimer = null
    }
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer)
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

  public getVisibleSignals(): SignalCard[] {
    if (this.channel === 'hyperliquid') return this.state.hyperliquid
    if (this.channel === 'polymarket') return this.state.polymarket
    if (this.channel === 'telegram') return this.state.telegram

    // Interleave high-signal items across Hyperliquid, Polymarket, and Telegram
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
    return {
      screen: this.screen,
      channel: this.channel,
      state: this.state,
      signals: this.getVisibleSignals(),
      signalIndex: this.signalIndex,
      actions: this.actions,
      actionIndex: this.actionIndex,
      stagedAction: this.stagedAction,
      confirmSelection: this.confirmSelection,
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
      window.clearTimeout(this.toastTimer)
    }
    this.toastTimer = window.setTimeout(() => {
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

  /**
   * Public gesture dispatcher — used by real G2 hardware/simulator events
   * AND by the Companion WebView quick-test controls.
   */
  public async dispatchGesture(gesture: NormalizedHudGesture): Promise<void> {
    if (gesture.kind === 'ignore') return

    if (gesture.kind === 'foreground_change') {
      // Opening or closing the OS contextual menu delivers FOREGROUND_ENTER / FOREGROUND_EXIT.
      // Never tear down app state here.
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

    if (gesture.kind === 'menu_item') {
      await this.handleMenuSelection(gesture.itemID)
      return
    }

    if (gesture.kind === 'long_press') {
      await this.beginVoiceCapture()
      return
    }

    if (gesture.kind === 'long_press_release') {
      if (this.screen === 'voice' && this.voiceCapture.isActive()) {
        await this.finishVoiceCapture()
      }
      return
    }

    // Screen-specific navigation & write handlers
    if (this.screen === 'feed') {
      if (gesture.kind === 'double_click') {
        // Root page QA requirement: invoke native system exit confirmation dialog (mode 1).
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
        this.openConfirmGate(chosen)
        await this.syncDisplay(false)
        return
      }
    }

    if (this.screen === 'confirm') {
      if (gesture.kind === 'double_click') {
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
          this.stagedAction = null
          this.screen = 'feed'
          this.showToast('Action cancelled')
          return
        }
        await this.commitStagedAction()
        return
      }
    }

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

    if (this.screen === 'portfolio') {
      if (gesture.kind === 'double_click' || gesture.kind === 'scroll_up' || gesture.kind === 'scroll_down') {
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
        const coin = topPos.venue === 'hyperliquid' ? topPos.symbol.replace('-PERP', '') : undefined
        this.openConfirmGate({
          id: `stage-${Date.now()}`,
          type: 'hl_flatten',
          label: `Flatten ${topPos.symbol}`,
          headline: `PAPER FLATTEN ${topPos.symbol}`,
          summary: `Close ${topPos.side} paper position at live mark (uPnL ${topPos.unrealizedPnlUsd >= 0 ? '+' : ''}$${topPos.unrealizedPnlUsd.toFixed(2)}).`,
          riskNote: 'PAPER MODE ONLY · Zero real funds · 1 tap confirms.',
          coin,
          source: 'tap',
        })
        await this.syncDisplay(false)
        return
      }
    }
  }

  public async handleMenuSelection(itemID: number): Promise<void> {
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
          riskNote: 'Read-only digest · 1 tap sends to Telegram Desk.',
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
    const active = this.getActiveSignal()
    const response = await sendVoiceCommand({
      transcript,
      activeSignalId: active?.id,
    })
    if (response.stagedAction) {
      this.openConfirmGate(response.stagedAction)
      await this.syncDisplay(false)
      return `Staged "${response.stagedAction.headline}" on G2 HUD — 1 tap to confirm.`
    }
    this.showToast(response.notice)
    return response.notice
  }

  private openConfirmGate(action: StagedAction): void {
    this.stagedAction = action
    this.confirmSelection = 'confirm'
    this.screen = 'confirm'
  }

  private async commitStagedAction(): Promise<void> {
    const action = this.stagedAction
    if (!action) return
    try {
      const result = await executeStagedAction(action)
      this.state = result.state
      this.stagedAction = null
      this.screen = 'feed'
      this.showToast(result.toast)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Execution error'
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
    // Open G2 mic non-blocking with timeout guard so HUD never stalls if host denies mic permission
    void Promise.race([
      this.bridge?.audioControl(true, AudioInputSource.Glasses).catch(() => false),
      new Promise((r) => setTimeout(r, 1200)),
    ])
    if (this.voiceTimer !== null) {
      window.clearInterval(this.voiceTimer)
    }
    this.voiceTimer = window.setInterval(() => {
      this.voiceTick += 1
      void this.syncDisplay(false)
    }, 280)
  }

  private async cancelVoiceCapture(): Promise<void> {
    if (this.voiceTimer !== null) {
      window.clearInterval(this.voiceTimer)
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
      window.clearInterval(this.voiceTimer)
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
      const longPx = signal.bestAsk ?? signal.markPx
      const shortPx = signal.bestBid ?? signal.markPx
      const alertText = `[PulseHUD G2] Hyperliquid ${signal.coin}-PERP $${signal.markPx.toLocaleString('en-US')} (${signal.change24hPct >= 0 ? '+' : ''}${signal.change24hPct}% 24h | Funding ${signal.fundingAprPct >= 0 ? '+' : ''}${signal.fundingAprPct}% APR)`

      return [
        {
          id: `act-short-${now}`,
          type: 'hl_paper_short',
          label: `Paper Short $1,000 ${signal.coin} (Hedge)`,
          headline: `HYPERLIQUID PAPER SHORT ${signal.coin}`,
          summary: `$1,000 notional @ $${shortPx.toLocaleString('en-US', { maximumFractionDigits: 2 })} (live L2 bid)`,
          riskNote: 'PAPER MODE ONLY · Zero custody · 1 tap executes.',
          signalId: signal.id,
          coin: signal.coin,
          notionalUsd: 1000,
          limitPrice: shortPx,
          source: 'tap',
        },
        {
          id: `act-long-${now}`,
          type: 'hl_paper_long',
          label: `Paper Long $1,000 ${signal.coin} (Market)`,
          headline: `HYPERLIQUID PAPER LONG ${signal.coin}`,
          summary: `$1,000 notional @ $${longPx.toLocaleString('en-US', { maximumFractionDigits: 2 })} (live L2 ask)`,
          riskNote: 'PAPER MODE ONLY · Zero custody · 1 tap executes.',
          signalId: signal.id,
          coin: signal.coin,
          notionalUsd: 1000,
          limitPrice: longPx,
          source: 'tap',
        },
        {
          id: `act-tg-${now}`,
          type: 'tg_share_signal',
          label: `Post ${signal.coin} Alert -> Telegram Desk`,
          headline: `POST ${signal.coin} ALERT -> TELEGRAM`,
          summary: alertText,
          riskNote: 'Read-only market alert · 1 tap posts to Telegram Desk.',
          signalId: signal.id,
          telegramText: alertText,
          source: 'tap',
        },
      ]
    }

    if (signal.kind === 'polymarket') {
      const yesCents = Math.round((signal.bestAsk ?? signal.yesPrice) * 100)
      const noCents = Math.round(signal.noPrice * 100)
      const callText = `[PulseHUD G2] Polymarket "${signal.shortTitle}" — YES ${Math.round(signal.yesPrice * 100)}c (${signal.change24hCents >= 0 ? '+' : ''}${signal.change24hCents}c 24h)`

      return [
        {
          id: `act-yes-${now}`,
          type: 'pm_paper_yes',
          label: `Paper Buy YES $50 @ ${yesCents}c`,
          headline: `POLYMARKET PAPER YES $50`,
          summary: `${signal.shortTitle} @ ${yesCents}c live CLOB`,
          riskNote: 'PAPER MODE ONLY · Live Polymarket odds · 1 tap confirms.',
          signalId: signal.id,
          marketId: signal.marketId,
          notionalUsd: 50,
          limitPrice: signal.bestAsk ?? signal.yesPrice,
          source: 'tap',
        },
        {
          id: `act-no-${now}`,
          type: 'pm_paper_no',
          label: `Paper Buy NO $50 @ ${noCents}c`,
          headline: `POLYMARKET PAPER NO $50`,
          summary: `${signal.shortTitle} — NO @ ${noCents}c`,
          riskNote: 'PAPER MODE ONLY · Live Polymarket odds · 1 tap confirms.',
          signalId: signal.id,
          marketId: signal.marketId,
          notionalUsd: 50,
          limitPrice: signal.noPrice,
          source: 'tap',
        },
        {
          id: `act-pm-tg-${now}`,
          type: 'tg_share_signal',
          label: 'Share Odds Call -> Telegram Desk',
          headline: 'SHARE ODDS -> TELEGRAM DESK',
          summary: callText,
          riskNote: '1 tap delivers formatted odds call to Telegram Desk.',
          signalId: signal.id,
          telegramText: callText,
          source: 'tap',
        },
      ]
    }

    // Telegram Desk smart drafts
    return signal.smartDrafts.slice(0, 3).map((draft, idx) => ({
      id: `act-tgdraft-${idx}-${now}`,
      type: 'tg_reply',
      label: draft,
      headline: `TG REPLY -> ${signal.chatName}`,
      summary: `"${draft}"`,
      riskNote: `Replying to ${signal.sender} · 1 tap sends to Telegram.`,
      signalId: signal.id,
      telegramChatId: signal.chatId,
      telegramText: draft,
      source: 'tap',
    }))
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
          for (const slot of page.slots) {
            this.lastRenderedContents.set(slot.containerID, `${slot.textColor}:${slot.content}`)
          }
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
          for (const slot of page.slots) {
            this.lastRenderedContents.set(slot.containerID, `${slot.textColor}:${slot.content}`)
          }
        }
        return
      }

      // Same layout geometry -> flicker-free in-place textContainerUpgrade calls!
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
    })

    await this.renderQueue
  }
}
