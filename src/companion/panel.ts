import {
  injectInboundTelegram,
  isStaticBrowserMode,
  toggleOfflineReplay,
  triggerRefresh,
  updateTelegramConfig,
  watchPublicWallet,
} from '../api/client.js'
import { shortenAddress, WATCHED_WALLET_PRESETS } from '../../server/feeds/hyperliquid.js'
import type { PulseHudController } from '../hud/controller.js'
import { MENU_IDS, type BuiltHudPage, type HudRenderModel } from '../hud/layout.js'

const QUICK_VOICE_PRESETS = [
  'Paper short 1000 BTC',
  'Take 50% BTC',
  'Move BTC stop to breakeven',
  'Buy 50 yes BTC',
  'Reply: hedging 25% near mark now',
]

const CONTEXT_MENU_ITEMS: ReadonlyArray<{ id: number; label: string }> = [
  { id: MENU_IDS.ALL_SIGNALS, label: 'All Signals' },
  { id: MENU_IDS.HYPERLIQUID, label: 'Hyperliquid 15m' },
  { id: MENU_IDS.POLYMARKET, label: 'Polymarket Odds' },
  { id: MENU_IDS.TELEGRAM_DESK, label: 'Telegram Desk' },
  { id: MENU_IDS.WALLET_WATCH, label: 'HL Wallet Watch' },
  { id: MENU_IDS.PORTFOLIO, label: 'Paper Portfolio' },
  { id: MENU_IDS.SEND_DIGEST, label: 'Send Digest -> TG' },
  { id: MENU_IDS.ALERT_ACTION, label: 'Alert Hedge / Ack' },
]

interface BrowserSpeechRecognition {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((ev: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition

function getBrowserSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function mountCompanionPanel(
  root: HTMLElement,
  controller: PulseHudController,
): () => void {
  const staticMode = isStaticBrowserMode()
  const hasSpeechApi = getBrowserSpeechRecognition() !== null

  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="pulse-dot" id="sse-dot"></span>
          <div>
            <h1>PulseHUD <span class="ver-pill">v2.2</span></h1>
            <p class="subtitle">Even Realities G2 (576×288) · 15m Candles · Threshold Alerts · Zero-Key Local STT · 2.0s Undo Ring</p>
          </div>
        </div>
        <div class="top-badges">
          <span class="badge" id="badge-bridge">Checking Bridge...</span>
          <span class="badge" id="badge-hl">HL: --</span>
          <span class="badge" id="badge-pm">PM: --</span>
          <span class="badge" id="badge-watch">WATCH: --</span>
          <span class="badge" id="badge-tg">TG: --</span>
        </div>
      </header>

      <section class="grid-main">
        <article class="panel mirror-panel">
          <div class="panel-head">
            <h2>Interactive 576×288 Even G2 Waveguide Simulator</h2>
            <div class="btn-row">
              <button class="btn btn-ghost" id="btn-optics">Optics: Borderless</button>
              <button class="btn btn-ghost" id="btn-refresh">Sync Live</button>
              <button class="btn btn-ghost" id="btn-replay">Replay: OFF</button>
            </div>
          </div>

          <div class="g2-lens-frame">
            <div class="g2-canvas" id="g2-mirror"></div>
            <div class="g2-menu-overlay hidden" id="g2-menu-overlay">
              <div class="g2-menu-box">
                <div class="g2-menu-title">≡ EVEN G2 OS CONTEXT MENU</div>
                <div class="g2-menu-items" id="g2-menu-items"></div>
              </div>
            </div>
          </div>

          <div class="alert-banner hidden" id="proactive-alert-banner">
            <div class="alert-copy">
              <span class="alert-badge" id="alert-badge">ALERT</span>
              <span class="alert-text" id="alert-text"></span>
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-primary btn-pill" id="btn-alert-hedge">1-Tap Hedge -> G2 Gate</button>
              <button type="button" class="btn btn-ghost btn-pill" id="btn-alert-ack">Ack</button>
            </div>
          </div>

          <div class="gesture-bar">
            <span class="gesture-label">R1 Ring / Temple:</span>
            <button class="btn" data-gesture="scroll_up" title="Keyboard: ArrowUp">▲ Scroll Up</button>
            <button class="btn" data-gesture="scroll_down" title="Keyboard: ArrowDown">▼ Scroll Down</button>
            <button class="btn btn-primary" data-gesture="click" title="Keyboard: Enter / Space">● Tap (Act / Undo)</button>
            <button class="btn" data-gesture="double_click" title="Keyboard: Escape">✕ 2xTap (Back/Undo)</button>
            <button class="btn" id="btn-os-menu" title="Keyboard: M">≡ OS Menu</button>
          </div>

          <div class="gesture-bar quick-jumps">
            <span class="gesture-label">Direct Views:</span>
            <button class="btn btn-pill" data-menu="${MENU_IDS.HYPERLIQUID}">HL 15m Candles</button>
            <button class="btn btn-pill" data-menu="${MENU_IDS.POLYMARKET}">Polymarket CLOB</button>
            <button class="btn btn-pill" data-menu="${MENU_IDS.TELEGRAM_DESK}">Coin-Locked TG</button>
            <button class="btn btn-pill" data-menu="${MENU_IDS.WALLET_WATCH}">HL Wallet Watch</button>
            <button class="btn btn-pill" data-menu="${MENU_IDS.PORTFOLIO}">Paper Ledger</button>
            <span class="kbd-hint">Keys: ↑↓ Scroll · Enter Tap · Esc Undo/Back · M Menu</span>
          </div>
        </article>

        <article class="panel voice-panel">
          <div class="panel-head">
            <h2>Voice Command &amp; 2.0s Undo Safety Staging</h2>
            <span class="chip" id="stt-chip">STT: local</span>
          </div>
          <p class="hint">
            Tap arms a <strong>2.0-second Undo Countdown Ring</strong> on the G2 lens; a second tap cancels with zero writes, otherwise it commits and locks inputs until receipt.
          </p>
          <form class="inline-form" id="voice-form">
            <input
              type="text"
              id="voice-input"
              placeholder='e.g. "Take 50% BTC", "Move BTC stop to breakeven", or "Reply: hedging"'
              autocomplete="off"
            />
            <button type="submit" class="btn btn-primary">Stage on G2</button>
            ${hasSpeechApi ? '<button type="button" class="btn" id="btn-web-mic">Mic</button>' : ''}
          </form>
          <div class="preset-row" id="voice-presets"></div>
          <div class="status-line" id="voice-feedback"></div>

          <div class="divider"></div>

          <div class="panel-head">
            <h2>Live Public Hyperliquid Watcher (clearinghouseState)</h2>
            <span class="chip chip-safe">READ-ONLY · ZERO CUSTODY</span>
          </div>
          <form class="inline-form" id="wallet-watch-form">
            <input
              type="text"
              id="wallet-address-input"
              placeholder="Paste any public 0x Hyperliquid address..."
              autocomplete="off"
            />
            <button type="submit" class="btn btn-primary">Watch 0x</button>
          </form>
          <div class="preset-row" id="wallet-presets"></div>
          <div class="status-line" id="wallet-feedback"></div>
          <div class="metrics-strip" id="wallet-metrics"></div>
          <div class="feed-list compact" id="wallet-positions"></div>
        </article>
      </section>

      <section class="grid-secondary">
        <article class="panel">
          <div class="panel-head">
            <h2>Coin-Locked Telegram Desk Bridge</h2>
            <span class="chip" id="tg-mode-chip">Desk Bridge</span>
          </div>
          <form class="stack-form" id="tg-inbound-form">
            <div class="row-2">
              <input type="text" id="tg-sender" value="Alex (Macro)" placeholder="Sender" />
              <input type="text" id="tg-chat" value="Alpha Trading Desk" placeholder="Channel / Group" />
            </div>
            <div class="inline-form">
              <input
                type="text"
                id="tg-text"
                placeholder='Push alert with ticker (e.g. "SOL funding +25% — hedge?")...'
                autocomplete="off"
              />
              <button type="submit" class="btn btn-primary">Push to G2</button>
            </div>
          </form>
          <div class="feed-list" id="tg-list"></div>

          ${
            staticMode
              ? `<p class="hint">Hosted Browser Simulator Mode: Live Hyperliquid + Polymarket APIs queried directly in-browser. Run <code>npm run dev</code> locally to pair a live <code>@BotFather</code> Telegram bot.</p>`
              : `<details class="bot-config">
            <summary>Connect Real Telegram Bot (@BotFather)</summary>
            <p class="hint">Stored in server memory only for this session — never committed to disk.</p>
            <form class="stack-form" id="tg-config-form">
              <input type="password" id="tg-token" placeholder="TELEGRAM_BOT_TOKEN" autocomplete="off" />
              <div class="inline-form">
                <input type="text" id="tg-chat-id" placeholder="TELEGRAM_CHAT_ID (optional; auto-detected on first message)" autocomplete="off" />
                <button type="submit" class="btn">Connect Bot</button>
              </div>
            </form>
          </details>`
          }
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Demo Paper Book &amp; Confirmed Write Audit Log</h2>
            <span class="chip chip-safe">DEMO PAPER ONLY · 2.0s UNDO SAFE</span>
          </div>
          <div class="metrics-strip" id="portfolio-metrics"></div>
          <h3 class="section-label">Demo Paper Positions (Live Mark-to-Market + Break-Even Stops)</h3>
          <div class="feed-list" id="positions-list"></div>
          <h3 class="section-label">Confirmed Execution Receipts</h3>
          <div class="feed-list" id="receipts-list"></div>
        </article>
      </section>
    </div>
  `

  // Populate interactive OS menu overlay items
  const menuOverlay = root.querySelector<HTMLDivElement>('#g2-menu-overlay')!
  const menuItemsEl = root.querySelector<HTMLDivElement>('#g2-menu-items')!
  for (const item of CONTEXT_MENU_ITEMS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'g2-menu-item'
    btn.textContent = `▶ ${item.label}`
    btn.addEventListener('click', () => {
      menuOverlay.classList.add('hidden')
      void controller.handleMenuSelection(item.id)
    })
    menuItemsEl.appendChild(btn)
  }

  root.querySelector<HTMLButtonElement>('#btn-os-menu')!.addEventListener('click', () => {
    menuOverlay.classList.toggle('hidden')
  })
  menuOverlay.addEventListener('click', (e) => {
    if (e.target === menuOverlay) {
      menuOverlay.classList.add('hidden')
    }
  })

  // Quick voice command presets
  const presetsEl = root.querySelector<HTMLDivElement>('#voice-presets')!
  for (const phrase of QUICK_VOICE_PRESETS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-pill'
    btn.textContent = `"${phrase}"`
    btn.addEventListener('click', () => {
      void submitVoicePhrase(phrase)
    })
    presetsEl.appendChild(btn)
  }

  const voiceInput = root.querySelector<HTMLInputElement>('#voice-input')!
  const voiceFeedback = root.querySelector<HTMLDivElement>('#voice-feedback')!

  async function submitVoicePhrase(phrase: string) {
    if (!phrase.trim()) return
    voiceFeedback.textContent = 'Staging command on G2 HUD...'
    try {
      const msg = await controller.submitTranscriptFromCompanion(phrase.trim())
      voiceFeedback.textContent = msg
    } catch (err) {
      voiceFeedback.textContent = err instanceof Error ? err.message : 'Voice staging failed'
    }
  }

  root.querySelector<HTMLFormElement>('#voice-form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void submitVoicePhrase(voiceInput.value)
    voiceInput.value = ''
  })

  // Optional Browser Web Speech API zero-key mic capture
  const webMicBtn = root.querySelector<HTMLButtonElement>('#btn-web-mic')
  if (webMicBtn) {
    let activeRec: BrowserSpeechRecognition | null = null
    webMicBtn.addEventListener('click', () => {
      if (activeRec) {
        activeRec.stop()
        activeRec = null
        webMicBtn.textContent = 'Mic'
        return
      }
      const Ctor = getBrowserSpeechRecognition()
      if (!Ctor) return
      const rec = new Ctor()
      rec.lang = 'en-US'
      rec.interimResults = false
      rec.maxAlternatives = 1
      activeRec = rec
      webMicBtn.textContent = 'Stop'
      voiceFeedback.textContent = 'Listening via Browser Web Speech API...'
      rec.onresult = (ev) => {
        const text = ev.results?.[0]?.[0]?.transcript?.trim() ?? ''
        if (text) {
          voiceInput.value = text
          void submitVoicePhrase(text)
        }
      }
      rec.onerror = (ev) => {
        voiceFeedback.textContent = `Mic error: ${ev.error}`
      }
      rec.onend = () => {
        activeRec = null
        webMicBtn.textContent = 'Mic'
      }
      rec.start()
    })
  }

  // Public Hyperliquid Wallet Watcher form & active presets
  const walletInput = root.querySelector<HTMLInputElement>('#wallet-address-input')!
  const walletFeedback = root.querySelector<HTMLDivElement>('#wallet-feedback')!
  const walletPresetsEl = root.querySelector<HTMLDivElement>('#wallet-presets')!

  async function submitWatchedWallet(address: string, label?: string) {
    const clean = address.trim()
    if (!clean) return
    walletFeedback.textContent = `Fetching live Hyperliquid clearinghouseState for ${shortenAddress(clean)}...`
    try {
      const res = await watchPublicWallet({ address: clean, label })
      controller.setState(res.state)
      await controller.handleMenuSelection(MENU_IDS.WALLET_WATCH)
      const posCount = res.state.watchedWallet.positions.length
      walletFeedback.textContent = `Live: ${res.state.watchedWallet.label} (${posCount} open perps, ${res.state.watchedWallet.marginRatioPct.toFixed(1)}% margin)`
    } catch (err) {
      walletFeedback.textContent = err instanceof Error ? err.message : 'Wallet watch failed'
    }
  }

  for (const preset of WATCHED_WALLET_PRESETS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-pill'
    btn.textContent = `${preset.label} (${shortenAddress(preset.address)})`
    btn.addEventListener('click', () => {
      walletInput.value = preset.address
      void submitWatchedWallet(preset.address, preset.label)
    })
    walletPresetsEl.appendChild(btn)
  }

  root.querySelector<HTMLFormElement>('#wallet-watch-form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void submitWatchedWallet(walletInput.value)
  })

  // Gesture buttons & direct views
  root.querySelectorAll<HTMLButtonElement>('[data-gesture]').forEach((btn) => {
    btn.addEventListener('click', () => {
      menuOverlay.classList.add('hidden')
      const g = btn.dataset.gesture as 'scroll_up' | 'scroll_down' | 'click' | 'double_click'
      void controller.dispatchGesture({ kind: g })
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((btn) => {
    btn.addEventListener('click', () => {
      menuOverlay.classList.add('hidden')
      const id = Number(btn.dataset.menu)
      void controller.handleMenuSelection(id)
    })
  })

  const opticsBtn = root.querySelector<HTMLButtonElement>('#btn-optics')!
  opticsBtn.addEventListener('click', () => {
    controller.toggleBorderlessOptics()
  })

  root.querySelector<HTMLButtonElement>('#btn-alert-hedge')!.addEventListener('click', () => {
    menuOverlay.classList.add('hidden')
    void controller.stageActiveAlertHedge()
  })

  root.querySelector<HTMLButtonElement>('#btn-alert-ack')!.addEventListener('click', () => {
    void controller.dismissActiveAlert()
  })

  root.querySelector<HTMLButtonElement>('#btn-refresh')!.addEventListener('click', async () => {
    const next = await triggerRefresh()
    controller.setState(next)
  })

  let replayEnabled = false
  const replayBtn = root.querySelector<HTMLButtonElement>('#btn-replay')!
  replayBtn.addEventListener('click', async () => {
    const next = await toggleOfflineReplay(!replayEnabled)
    controller.setState(next)
  })

  root.querySelector<HTMLFormElement>('#tg-inbound-form')!.addEventListener('submit', async (e) => {
    e.preventDefault()
    const sender = root.querySelector<HTMLInputElement>('#tg-sender')!.value
    const chatName = root.querySelector<HTMLInputElement>('#tg-chat')!.value
    const textInput = root.querySelector<HTMLInputElement>('#tg-text')!
    const text = textInput.value.trim()
    if (!text) return
    const res = await injectInboundTelegram({ sender, chatName, text })
    controller.setState(res.state)
    await controller.handleMenuSelection(MENU_IDS.TELEGRAM_DESK)
    textInput.value = ''
  })

  const tgConfigForm = root.querySelector<HTMLFormElement>('#tg-config-form')
  if (tgConfigForm) {
    tgConfigForm.addEventListener('submit', async (e) => {
      e.preventDefault()
      const botToken = root.querySelector<HTMLInputElement>('#tg-token')!.value
      const chatId = root.querySelector<HTMLInputElement>('#tg-chat-id')!.value
      const res = await updateTelegramConfig({ botToken, chatId })
      controller.setState(res.state)
    })
  }

  // Keyboard shortcuts for fast judge testing inside the browser simulator
  const onKeyDown = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement | null)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      void controller.dispatchGesture({ kind: 'scroll_up' })
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      void controller.dispatchGesture({ kind: 'scroll_down' })
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      void controller.dispatchGesture({ kind: 'click' })
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault()
      menuOverlay.classList.add('hidden')
      void controller.dispatchGesture({ kind: 'double_click' })
    } else if (e.key.toLowerCase() === 'm') {
      e.preventDefault()
      menuOverlay.classList.toggle('hidden')
    }
  }
  window.addEventListener('keydown', onKeyDown)

  const mirrorEl = root.querySelector<HTMLDivElement>('#g2-mirror')!
  const alertBannerEl = root.querySelector<HTMLDivElement>('#proactive-alert-banner')!
  const alertBadgeEl = root.querySelector<HTMLSpanElement>('#alert-badge')!
  const alertTextEl = root.querySelector<HTMLSpanElement>('#alert-text')!
  const badgeBridge = root.querySelector<HTMLSpanElement>('#badge-bridge')!
  const badgeHl = root.querySelector<HTMLSpanElement>('#badge-hl')!
  const badgePm = root.querySelector<HTMLSpanElement>('#badge-pm')!
  const badgeWatch = root.querySelector<HTMLSpanElement>('#badge-watch')!
  const badgeTg = root.querySelector<HTMLSpanElement>('#badge-tg')!
  const sttChip = root.querySelector<HTMLSpanElement>('#stt-chip')!
  const tgModeChip = root.querySelector<HTMLSpanElement>('#tg-mode-chip')!
  const tgList = root.querySelector<HTMLDivElement>('#tg-list')!
  const walletMetricsEl = root.querySelector<HTMLDivElement>('#wallet-metrics')!
  const walletPositionsEl = root.querySelector<HTMLDivElement>('#wallet-positions')!
  const metricsEl = root.querySelector<HTMLDivElement>('#portfolio-metrics')!
  const positionsList = root.querySelector<HTMLDivElement>('#positions-list')!
  const receiptsList = root.querySelector<HTMLDivElement>('#receipts-list')!

  const renderMirror = (page: BuiltHudPage) => {
    mirrorEl.innerHTML = ''

    // Render 4-bit monochrome waveguide ImageContainerProperty buffers via crisp pixel canvas
    for (const img of page.imageSlots) {
      const cvs = document.createElement('canvas')
      cvs.className = 'g2-img-slot'
      cvs.width = img.width
      cvs.height = img.height
      cvs.style.left = `${(img.xPosition / 576) * 100}%`
      cvs.style.top = `${(img.yPosition / 288) * 100}%`
      cvs.style.width = `${(img.width / 576) * 100}%`
      cvs.style.height = `${(img.height / 288) * 100}%`
      const ctx = cvs.getContext('2d')
      if (ctx) {
        const imgData = ctx.createImageData(img.width, img.height)
        const rgba = imgData.data
        for (let i = 0; i < img.pixels.length; i += 1) {
          const lum = img.pixels[i]
          const o = i * 4
          if (lum === 0) {
            rgba[o] = 0
            rgba[o + 1] = 0
            rgba[o + 2] = 0
            rgba[o + 3] = 0
          } else {
            const norm = lum / 255
            rgba[o] = Math.round(69 * norm)
            rgba[o + 1] = Math.round(255 * Math.min(1, 0.28 + norm * 0.72))
            rgba[o + 2] = Math.round(152 * norm)
            rgba[o + 3] = Math.round(255 * Math.min(1, 0.25 + norm * 0.75))
          }
        }
        ctx.putImageData(imgData, 0, 0)
      }
      mirrorEl.appendChild(cvs)
    }

    // Render TextContainerProperty slots
    for (const slot of page.slots) {
      const box = document.createElement('div')
      box.className = `g2-slot brightness-${slot.textColor}`
      box.style.left = `${(slot.xPosition / 576) * 100}%`
      box.style.top = `${(slot.yPosition / 288) * 100}%`
      box.style.width = `${(slot.width / 576) * 100}%`
      box.style.height = `${(slot.height / 288) * 100}%`
      box.style.padding = `${slot.paddingLength * 0.72}px`
      if (slot.borderWidth > 0) {
        const alpha = Math.max(0.25, slot.borderColor / 15)
        box.style.border = `${slot.borderWidth}px solid rgba(94, 255, 160, ${alpha})`
        box.style.borderRadius = `${slot.borderRadius}px`
      }
      box.textContent = slot.content
      mirrorEl.appendChild(box)
    }
  }

  const renderState = (model: HudRenderModel, page: BuiltHudPage, bridgeConnected: boolean) => {
    renderMirror(page)
    const { health, portfolio, telegram, watchedWallet, offlineReplay } = model.state

    opticsBtn.textContent = model.borderlessOptics ? 'Optics: Borderless' : 'Optics: Framed'
    replayEnabled = offlineReplay
    replayBtn.textContent = offlineReplay ? 'Replay: ON' : 'Replay: OFF'

    badgeBridge.textContent = bridgeConnected
      ? 'G2 Bridge: Connected'
      : staticMode
        ? 'Web G2 Simulator (Direct Live)'
        : 'Standalone Preview'
    badgeBridge.className = `badge ${bridgeConnected || staticMode ? 'ok' : 'warn'}`

    const anySyntheticHl = model.state.hyperliquid.some((s) => s.candlesSource === 'synthetic')
    const hlStatusLabel =
      health.hyperliquid.status !== 'live' || anySyntheticHl
        ? 'FALLBACK'
        : health.hyperliquid.candlesLoaded
          ? 'LIVE +15m'
          : 'LIVE (SYNC 15m)'
    badgeHl.textContent = `HL: ${hlStatusLabel}${health.hyperliquid.latencyMs ? ` ${health.hyperliquid.latencyMs}ms` : ''}`
    badgeHl.className = `badge ${health.hyperliquid.status === 'live' && !anySyntheticHl ? 'ok' : 'warn'}`

    badgePm.textContent = `PM: ${health.polymarket.status.toUpperCase()}${health.polymarket.clobVerified ? ' +CLOB' : ''}`
    badgePm.className = `badge ${health.polymarket.status === 'live' ? 'ok' : 'warn'}`

    badgeWatch.textContent = `WATCH: ${watchedWallet.status.toUpperCase()} (${watchedWallet.positions.length})`
    badgeWatch.className = `badge ${watchedWallet.status === 'live' ? 'ok' : 'warn'}`

    badgeTg.textContent = `TG: ${health.telegram.mode === 'live_bot' ? 'LIVE BOT' : 'DESK'} (${health.telegram.unreadCount})`
    badgeTg.className = `badge ${health.telegram.mode === 'live_bot' ? 'ok' : ''}`

    sttChip.textContent = `STT: ${hasSpeechApi ? `web-speech + ${health.stt.provider}` : health.stt.provider}`

    if (model.activeAlert) {
      alertBannerEl.classList.remove('hidden')
      alertBannerEl.classList.toggle('critical', model.activeAlert.severity === 'critical')
      alertBadgeEl.textContent =
        model.activeAlert.kind === 'liq_risk'
          ? 'LIQ < 5%'
          : model.activeAlert.kind === 'funding_extreme'
            ? 'FUND >= 25%'
            : 'ODDS >= 5c'
      alertTextEl.textContent = model.activeAlert.action.label
    } else {
      alertBannerEl.classList.add('hidden')
    }
    tgModeChip.textContent =
      health.telegram.mode === 'live_bot'
        ? `@${health.telegram.botUsername ?? 'Bot'} Live`
        : 'Coin-Locked Desk Bridge'

    // Watched Public Hyperliquid Wallet metrics & positions — lead with Nearest Liquidation Distance!
    if (!walletInput.value) {
      walletInput.value = watchedWallet.address
    }
    const nearestPos = watchedWallet.positions[0]
    const nearestLiqText = nearestPos
      ? nearestPos.liqDistancePct !== null
        ? `${nearestPos.coin} ${nearestPos.liqDistancePct > 99 ? '>99%' : `${nearestPos.liqDistancePct.toFixed(1)}%`}`
        : `${nearestPos.coin} SAFE`
      : 'None'
    const nearestDanger =
      nearestPos?.liqDistancePct !== null &&
      nearestPos?.liqDistancePct !== undefined &&
      nearestPos.liqDistancePct < 15
    walletMetricsEl.innerHTML = `
      <div class="metric-card"><span>Nearest Liq</span><strong class="${nearestDanger ? 'neg' : 'pos'}">${escapeHtml(nearestLiqText)}</strong></div>
      <div class="metric-card"><span>Margin Ratio</span><strong class="${watchedWallet.marginRatioPct >= 65 ? 'neg' : 'pos'}">${watchedWallet.marginRatioPct.toFixed(1)}%</strong></div>
      <div class="metric-card"><span>Acct Value</span><strong>$${Math.round(watchedWallet.accountValueUsd).toLocaleString('en-US')}</strong></div>
    `
    walletPositionsEl.innerHTML =
      watchedWallet.positions.length === 0
        ? `<div class="muted">${escapeHtml(watchedWallet.error ?? 'No open perp positions on this public address.')}</div>`
        : watchedWallet.positions
            .slice(0, 12)
            .map((p) => {
              const s = p.unrealizedPnlUsd >= 0 ? '+' : ''
              const liqText =
                p.liqDistancePct !== null
                  ? p.liqDistancePct > 99
                    ? '>99%'
                    : `${p.liqDistancePct.toFixed(1)}%`
                  : 'SAFE'
              const liqDanger = p.liqDistancePct !== null && p.liqDistancePct < 15
              return `
          <div class="list-row">
            <div class="row-top">
              <strong>${escapeHtml(p.coin)} · ${p.side} ${p.leverage}x</strong>
              <span class="${liqDanger ? 'neg' : 'pos'}">Liq ${liqText}</span>
            </div>
            <div class="muted">uPnL <span class="${p.unrealizedPnlUsd >= 0 ? 'pos' : 'neg'}">${s}$${Math.round(p.unrealizedPnlUsd).toLocaleString('en-US')}</span> · Entry $${p.entryPx.toLocaleString('en-US', { maximumFractionDigits: 2 })} · Mark $${p.markPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}</div>
          </div>`
            })
            .join('')

    // Telegram inbox list with Coin-Lock tags
    tgList.innerHTML = telegram
      .slice(0, 4)
      .map(
        (m) => `
      <div class="list-row ${m.unread ? 'unread' : ''}">
        <div class="row-top">
          <strong>${escapeHtml(m.sender)}${m.linkedCoin ? ` <span class="coin-tag">${escapeHtml(m.linkedCoin)}</span>` : ''}</strong>
          <span class="muted">${escapeHtml(m.chatName)}</span>
        </div>
        <div class="row-body">${escapeHtml(m.text)}</div>
        ${m.repliedText ? `<div class="row-reply">✓ Replied: ${escapeHtml(m.repliedText)}</div>` : ''}
      </div>`,
      )
      .join('')

    // Portfolio summary strip
    const uSign = portfolio.unrealizedPnlUsd >= 0 ? '+' : ''
    const rSign = portfolio.realizedPnlUsd >= 0 ? '+' : ''
    metricsEl.innerHTML = `
      <div class="metric-card"><span>Demo Paper Equity</span><strong>$${portfolio.equityUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>
      <div class="metric-card"><span>Unrealized PnL</span><strong class="${portfolio.unrealizedPnlUsd >= 0 ? 'pos' : 'neg'}">${uSign}$${portfolio.unrealizedPnlUsd.toFixed(2)}</strong></div>
      <div class="metric-card"><span>Realized PnL</span><strong class="${portfolio.realizedPnlUsd >= 0 ? 'pos' : 'neg'}">${rSign}$${portfolio.realizedPnlUsd.toFixed(2)}</strong></div>
    `

    positionsList.innerHTML =
      portfolio.positions.length === 0
        ? '<div class="muted">No open paper positions.</div>'
        : portfolio.positions
            .map((p) => {
              const s = p.unrealizedPnlUsd >= 0 ? '+' : ''
              const markText =
                p.venue === 'polymarket'
                  ? `${Math.round(p.markPrice * 100)}c`
                  : `$${p.markPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
              const beBadge =
                p.stopLossMode === 'breakeven' && p.stopLossPx
                  ? ` <span class="coin-tag">BE @ $${p.stopLossPx.toLocaleString('en-US', { maximumFractionDigits: 1 })}</span>`
                  : ''
              return `
          <div class="list-row">
            <div class="row-top">
              <strong>${escapeHtml(p.symbol)} · ${p.side}${beBadge}</strong>
              <span class="${p.unrealizedPnlUsd >= 0 ? 'pos' : 'neg'}">${s}$${p.unrealizedPnlUsd.toFixed(2)} (${s}${p.unrealizedPnlPct.toFixed(1)}%)</span>
            </div>
            <div class="muted">Size ${p.size} · Mark ${markText} · Notional $${p.notionalUsd.toFixed(2)}</div>
          </div>`
            })
            .join('')

    receiptsList.innerHTML =
      portfolio.receipts.length === 0
        ? '<div class="muted">Stage an action on the G2 lens, tap to arm the 2.0s undo ring, and let the timer finish to log a receipt here.</div>'
        : portfolio.receipts
            .slice(0, 6)
            .map(
              (r) => `
          <div class="list-row">
            <div class="row-top">
              <strong>${escapeHtml(r.title)}</strong>
              <span class="muted">${new Date(r.timestamp).toLocaleTimeString()}</span>
            </div>
            <div class="muted">${escapeHtml(r.detail)}</div>
          </div>`,
            )
            .join('')
  }

  const unsub = controller.subscribe(({ model, page, bridgeConnected }) => {
    renderState(model, page, bridgeConnected)
  })

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    unsub()
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
