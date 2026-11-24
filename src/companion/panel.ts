import {
  injectInboundTelegram,
  toggleOfflineReplay,
  triggerRefresh,
  updateTelegramConfig,
} from '../api/client.js'
import type { PulseHudController } from '../hud/controller.js'
import { MENU_IDS, type BuiltHudPage, type HudRenderModel } from '../hud/layout.js'

const QUICK_VOICE_PRESETS = [
  'Paper short 1000 BTC',
  'Buy 50 yes BTC',
  'Reply: hedging 25% near mark now',
  'Send live digest to Telegram',
]

export function mountCompanionPanel(
  root: HTMLElement,
  controller: PulseHudController,
): () => void {
  root.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="pulse-dot" id="sse-dot"></span>
          <div>
            <h1>PulseHUD</h1>
            <p class="subtitle">Even Realities G2 · Read &amp; Write DeFi + Telegram Copilot</p>
          </div>
        </div>
        <div class="top-badges">
          <span class="badge" id="badge-bridge">Checking Bridge...</span>
          <span class="badge" id="badge-hl">HL: --</span>
          <span class="badge" id="badge-pm">PM: --</span>
          <span class="badge" id="badge-tg">TG: --</span>
        </div>
      </header>

      <section class="grid-main">
        <article class="panel mirror-panel">
          <div class="panel-head">
            <h2>Live G2 Lens Mirror (576 × 288 · 4-bit Green)</h2>
            <div class="btn-row">
              <button class="btn btn-ghost" id="btn-refresh">Sync Live</button>
              <button class="btn btn-ghost" id="btn-replay">Replay: OFF</button>
            </div>
          </div>

          <div class="g2-lens-frame">
            <div class="g2-canvas" id="g2-mirror"></div>
          </div>

          <div class="gesture-bar">
            <span class="gesture-label">R1 Ring / Temple Controls:</span>
            <button class="btn" data-gesture="scroll_up">▲ Up</button>
            <button class="btn" data-gesture="scroll_down">▼ Down</button>
            <button class="btn btn-primary" data-gesture="click">● Tap (Act)</button>
            <button class="btn" data-gesture="double_click">✕ Double-Tap</button>
            <button class="btn" data-menu="${MENU_IDS.HYPERLIQUID}">HL</button>
            <button class="btn" data-menu="${MENU_IDS.POLYMARKET}">PM</button>
            <button class="btn" data-menu="${MENU_IDS.TELEGRAM_DESK}">TG</button>
            <button class="btn" data-menu="${MENU_IDS.PORTFOLIO}">Ledger</button>
          </div>
        </article>

        <article class="panel voice-panel">
          <div class="panel-head">
            <h2>Voice Intent Staging (1-Tap G2 Confirm)</h2>
            <span class="chip" id="stt-chip">STT: local</span>
          </div>
          <p class="hint">
            Hold the G2 temple/ring for 16 kHz PCM capture, or test a spoken trading / Telegram phrase below — it stages straight onto the G2 Confirm Gate.
          </p>
          <form class="inline-form" id="voice-form">
            <input
              type="text"
              id="voice-input"
              placeholder='e.g. "Paper short 1000 BTC" or "Reply: hedging 25% now"'
              autocomplete="off"
            />
            <button type="submit" class="btn btn-primary">Stage on G2</button>
          </form>
          <div class="preset-row" id="voice-presets"></div>
          <div class="status-line" id="voice-feedback"></div>
        </article>
      </section>

      <section class="grid-secondary">
        <article class="panel">
          <div class="panel-head">
            <h2>Telegram Desk Bridge</h2>
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
                placeholder="Push an incoming Telegram alert straight to G2 glasses..."
                autocomplete="off"
              />
              <button type="submit" class="btn btn-primary">Push to G2</button>
            </div>
          </form>
          <div class="feed-list" id="tg-list"></div>

          <details class="bot-config">
            <summary>Connect Real Telegram Bot (@BotFather)</summary>
            <p class="hint">Stored in server memory only for this session — never committed to disk.</p>
            <form class="stack-form" id="tg-config-form">
              <input type="password" id="tg-token" placeholder="TELEGRAM_BOT_TOKEN" autocomplete="off" />
              <div class="inline-form">
                <input type="text" id="tg-chat-id" placeholder="TELEGRAM_CHAT_ID (optional; auto-detected on first message)" autocomplete="off" />
                <button type="submit" class="btn">Connect Bot</button>
              </div>
            </form>
          </details>
        </article>

        <article class="panel">
          <div class="panel-head">
            <h2>Paper Portfolio &amp; Execution Audit Log</h2>
            <span class="chip chip-safe">PAPER ONLY · ZERO CUSTODY</span>
          </div>
          <div class="metrics-strip" id="portfolio-metrics"></div>
          <h3 class="section-label">Open Paper Positions (Live Mark-to-Market)</h3>
          <div class="feed-list" id="positions-list"></div>
          <h3 class="section-label">Confirmed Write Receipts</h3>
          <div class="feed-list" id="receipts-list"></div>
        </article>
      </section>
    </div>
  `

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

  root.querySelectorAll<HTMLButtonElement>('[data-gesture]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const g = btn.dataset.gesture as 'scroll_up' | 'scroll_down' | 'click' | 'double_click'
      void controller.dispatchGesture({ kind: g })
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.menu)
      void controller.handleMenuSelection(id)
    })
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

  root.querySelector<HTMLFormElement>('#tg-config-form')!.addEventListener('submit', async (e) => {
    e.preventDefault()
    const botToken = root.querySelector<HTMLInputElement>('#tg-token')!.value
    const chatId = root.querySelector<HTMLInputElement>('#tg-chat-id')!.value
    const res = await updateTelegramConfig({ botToken, chatId })
    controller.setState(res.state)
  })

  const mirrorEl = root.querySelector<HTMLDivElement>('#g2-mirror')!
  const badgeBridge = root.querySelector<HTMLSpanElement>('#badge-bridge')!
  const badgeHl = root.querySelector<HTMLSpanElement>('#badge-hl')!
  const badgePm = root.querySelector<HTMLSpanElement>('#badge-pm')!
  const badgeTg = root.querySelector<HTMLSpanElement>('#badge-tg')!
  const sttChip = root.querySelector<HTMLSpanElement>('#stt-chip')!
  const tgModeChip = root.querySelector<HTMLSpanElement>('#tg-mode-chip')!
  const tgList = root.querySelector<HTMLDivElement>('#tg-list')!
  const metricsEl = root.querySelector<HTMLDivElement>('#portfolio-metrics')!
  const positionsList = root.querySelector<HTMLDivElement>('#positions-list')!
  const receiptsList = root.querySelector<HTMLDivElement>('#receipts-list')!

  const renderMirror = (page: BuiltHudPage) => {
    mirrorEl.innerHTML = ''
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
    const { health, portfolio, telegram, offlineReplay } = model.state

    replayEnabled = offlineReplay
    replayBtn.textContent = offlineReplay ? 'Replay: ON' : 'Replay: OFF'

    badgeBridge.textContent = bridgeConnected ? 'G2 Bridge: Connected' : 'Standalone Preview'
    badgeBridge.className = `badge ${bridgeConnected ? 'ok' : 'warn'}`

    badgeHl.textContent = `HL: ${health.hyperliquid.status.toUpperCase()}${health.hyperliquid.latencyMs ? ` ${health.hyperliquid.latencyMs}ms` : ''}`
    badgeHl.className = `badge ${health.hyperliquid.status === 'live' ? 'ok' : 'warn'}`

    badgePm.textContent = `PM: ${health.polymarket.status.toUpperCase()}${health.polymarket.clobVerified ? ' +CLOB' : ''}`
    badgePm.className = `badge ${health.polymarket.status === 'live' ? 'ok' : 'warn'}`

    badgeTg.textContent = `TG: ${health.telegram.mode === 'live_bot' ? 'LIVE BOT' : 'DESK'} (${health.telegram.unreadCount})`
    badgeTg.className = `badge ${health.telegram.mode === 'live_bot' ? 'ok' : ''}`

    sttChip.textContent = `STT: ${health.stt.provider}`
    tgModeChip.textContent =
      health.telegram.mode === 'live_bot'
        ? `@${health.telegram.botUsername ?? 'Bot'} Live`
        : 'Interactive Desk Bridge'

    // Telegram inbox list
    tgList.innerHTML = telegram
      .slice(0, 4)
      .map(
        (m) => `
      <div class="list-row ${m.unread ? 'unread' : ''}">
        <div class="row-top">
          <strong>${escapeHtml(m.sender)}</strong>
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
      <div class="metric-card"><span>Paper Equity</span><strong>$${portfolio.equityUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>
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
              return `
          <div class="list-row">
            <div class="row-top">
              <strong>${escapeHtml(p.symbol)} · ${p.side}</strong>
              <span class="${p.unrealizedPnlUsd >= 0 ? 'pos' : 'neg'}">${s}$${p.unrealizedPnlUsd.toFixed(2)} (${s}${p.unrealizedPnlPct.toFixed(1)}%)</span>
            </div>
            <div class="muted">Size ${p.size} · Mark ${markText} · Notional $${p.notionalUsd.toFixed(2)}</div>
          </div>`
            })
            .join('')

    receiptsList.innerHTML =
      portfolio.receipts.length === 0
        ? '<div class="muted">Tap any signal on the G2 glasses and confirm to see verified receipts here.</div>'
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

  return controller.subscribe(({ model, page, bridgeConnected }) => {
    renderState(model, page, bridgeConnected)
  })
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
