import type {
  ExecutionReceipt,
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PortfolioSnapshot,
  TelegramMessageSignal,
} from '../../shared/types.js'

const TELEGRAM_API_BASE = 'https://api.telegram.org'

export interface TelegramConfig {
  botToken: string
  chatId: string
}

interface RawTelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    date: number
    text?: string
    chat: { id: number; title?: string; username?: string; first_name?: string }
    from?: { first_name?: string; username?: string }
  }
}

export function generateSmartDrafts(
  messageText: string,
  hl: HyperliquidPerpSignal[],
  pm: PolymarketOddsSignal[],
): string[] {
  const lower = messageText.toLowerCase()
  const btc = hl.find((s) => s.coin === 'BTC') ?? hl[0]
  const eth = hl.find((s) => s.coin === 'ETH')
  const topPm = pm[0]

  const btcPrice = btc ? `$${Math.round(btc.markPx).toLocaleString('en-US')}` : 'mark'
  const btcFund = btc ? `${btc.fundingAprPct >= 0 ? '+' : ''}${btc.fundingAprPct.toFixed(1)}% APR` : 'live'
  const pmOdds = topPm ? `${Math.round(topPm.yesPrice * 100)}c` : 'live odds'

  if (lower.includes('funding') || lower.includes('hedge') || lower.includes('perp') || lower.includes('btc')) {
    return [
      `Copy — hedging 25% BTC @ ${btcPrice} (${btcFund}).`,
      `Staying flat now; ping me if BTC moves +/-2%.`,
      `Adding a small Hyperliquid paper hedge & watching OI.`,
    ]
  }

  if (lower.includes('poly') || lower.includes('odds') || lower.includes('yes') || lower.includes('market') || lower.includes('bet')) {
    return [
      `Seeing ${pmOdds} on Polymarket — staging $50 YES.`,
      `Moved too fast; waiting for CLOB spread to tighten.`,
      `Good catch — posting updated midpoint in 5m.`,
    ]
  }

  if (lower.includes('eth') && eth) {
    const ethPrice = `$${Math.round(eth.markPx).toLocaleString('en-US')}`
    return [
      `Watching ETH @ ${ethPrice} — holding current size.`,
      `Trimming half on strength; stop to breakeven.`,
      `Got it on G2 HUD, syncing with desk shortly.`,
    ]
  }

  return [
    `Saw this on G2 — acting in 1 minute.`,
    `Copy that. Keeping risk tight at current levels.`,
    `Will check full book once back at my desk.`,
  ]
}

export class TelegramBridge {
  private botToken: string
  private chatId: string
  private botUsername: string | null = null
  private lastUpdateId = 0
  private lastSyncAt: number | null = null
  private lastError: string | undefined
  private messages: TelegramMessageSignal[] = []
  private seeded = false

  constructor(config: TelegramConfig) {
    this.botToken = config.botToken.trim()
    this.chatId = config.chatId.trim()
  }

  public isLiveBot(): boolean {
    return this.botToken.length > 10
  }

  public configure(config: Partial<TelegramConfig>): void {
    if (typeof config.botToken === 'string') {
      this.botToken = config.botToken.trim()
      this.botUsername = null
    }
    if (typeof config.chatId === 'string') {
      this.chatId = config.chatId.trim()
    }
    this.lastError = undefined
  }

  public seedDeskMessages(hl: HyperliquidPerpSignal[], pm: PolymarketOddsSignal[]): void {
    if (this.seeded) return
    this.seeded = true
    const now = Date.now()
    const btc = hl.find((s) => s.coin === 'BTC')
    const topPm = pm[0]

    const btcLine = btc
      ? `BTC perp at $${Math.round(btc.markPx).toLocaleString('en-US')} (${btc.fundingAprPct >= 0 ? '+' : ''}${btc.fundingAprPct.toFixed(1)}% APR funding). Should we hedge 25%?`
      : 'BTC perp funding creeping up on Hyperliquid. Should we hedge 25%?'

    const pmLine = topPm
      ? `Polymarket "${topPm.shortTitle}" jumped to ${Math.round(topPm.yesPrice * 100)}c (${topPm.change24hCents >= 0 ? '+' : ''}${topPm.change24hCents}c 24h). Taking YES or fading?`
      : 'Polymarket BTC odds moved sharply in the last hour. Taking YES or fading?'

    const seedEntries = [
      {
        id: 'tg-desk-1',
        chatId: this.chatId || 'desk-alpha',
        chatName: 'Alpha Trading Desk',
        sender: 'Maya (PM)',
        text: btcLine,
        receivedAt: now - 1000 * 60 * 3,
      },
      {
        id: 'tg-desk-2',
        chatId: this.chatId || 'desk-poly',
        chatName: 'Polymarket War Room',
        sender: 'Liam',
        text: pmLine,
        receivedAt: now - 1000 * 60 * 7,
      },
      {
        id: 'tg-desk-3',
        chatId: this.chatId || 'desk-risk',
        chatName: 'Risk & Ops',
        sender: 'Desk Bot',
        text: 'London open in 15m. Confirm if you want a quick PnL digest posted before the call.',
        receivedAt: now - 1000 * 60 * 14,
      },
    ]

    this.messages = seedEntries.map((entry) => ({
      ...entry,
      kind: 'telegram',
      unread: true,
      origin: 'desk_bridge',
      smartDrafts: generateSmartDrafts(entry.text, hl, pm),
    }))
    this.lastSyncAt = now
  }

  public refreshDrafts(hl: HyperliquidPerpSignal[], pm: PolymarketOddsSignal[]): void {
    for (const msg of this.messages) {
      msg.smartDrafts = generateSmartDrafts(msg.text, hl, pm)
    }
  }

  public injectInboundMessage(
    sender: string,
    chatName: string,
    text: string,
    hl: HyperliquidPerpSignal[],
    pm: PolymarketOddsSignal[],
    chatId?: string,
    origin: 'telegram_bot' | 'desk_bridge' = 'desk_bridge',
  ): TelegramMessageSignal {
    const cleanText = text.trim()
    const msg: TelegramMessageSignal = {
      id: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'telegram',
      chatId: chatId ?? (this.chatId || 'desk-alpha'),
      chatName: chatName.trim() || 'Alpha Trading Desk',
      sender: sender.trim() || 'Trader',
      text: cleanText,
      receivedAt: Date.now(),
      unread: true,
      origin,
      smartDrafts: generateSmartDrafts(cleanText, hl, pm),
    }
    this.messages.unshift(msg)
    this.messages = this.messages.slice(0, 15)
    this.lastSyncAt = Date.now()
    return msg
  }

  public async pollLiveTelegram(
    hl: HyperliquidPerpSignal[],
    pm: PolymarketOddsSignal[],
    portfolio: PortfolioSnapshot,
  ): Promise<void> {
    if (!this.isLiveBot()) return

    try {
      if (!this.botUsername) {
        const meRes = await fetch(`${TELEGRAM_API_BASE}/bot${this.botToken}/getMe`, {
          signal: AbortSignal.timeout(5000),
        })
        const meJson = (await meRes.json()) as { ok: boolean; result?: { username?: string }; description?: string }
        if (!meJson.ok) {
          throw new Error(meJson.description ?? 'Telegram getMe failed')
        }
        this.botUsername = meJson.result?.username ?? 'PulseHUDBot'
      }

      const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/getUpdates?timeout=0&limit=10${this.lastUpdateId ? `&offset=${this.lastUpdateId + 1}` : ''}`
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
      const data = (await res.json()) as { ok: boolean; result?: RawTelegramUpdate[]; description?: string }
      if (!data.ok) {
        throw new Error(data.description ?? 'Telegram getUpdates failed')
      }

      for (const update of data.result ?? []) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id)
        const m = update.message
        if (!m?.text) continue

        const chatIdStr = String(m.chat.id)
        if (!this.chatId) {
          this.chatId = chatIdStr
        }

        const sender = m.from?.first_name || m.from?.username || 'Telegram User'
        const chatName = m.chat.title || m.chat.username || 'Telegram Direct'

        // Handle interactive Telegram slash commands directly from chat
        if (m.text.startsWith('/')) {
          await this.handleSlashCommand(chatIdStr, m.text, hl, pm, portfolio)
          continue
        }

        this.injectInboundMessage(sender, chatName, m.text, hl, pm, chatIdStr, 'telegram_bot')
      }

      this.lastSyncAt = Date.now()
      this.lastError = undefined
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Telegram poll error'
    }
  }

  private async handleSlashCommand(
    chatId: string,
    command: string,
    hl: HyperliquidPerpSignal[],
    pm: PolymarketOddsSignal[],
    portfolio: PortfolioSnapshot,
  ): Promise<void> {
    const cmd = command.trim().split(/\s+/)[0].toLowerCase()
    if (cmd === '/start' || cmd === '/help') {
      await this.sendRawTelegramMessage(
        chatId,
        'PulseHUD G2 Connected.\nSend any message here to push it onto your Even G2 HUD, or run:\n/status — Live Hyperliquid & Polymarket snapshot\n/positions — Paper portfolio PnL',
      )
      return
    }
    if (cmd === '/status' || cmd === '/odds') {
      const digest = formatDigestText(hl, pm, portfolio)
      await this.sendRawTelegramMessage(chatId, digest)
      return
    }
    if (cmd === '/positions') {
      const lines = portfolio.positions.map(
        (p) =>
          `• ${p.symbol} (${p.side}) | PnL: ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)}`,
      )
      await this.sendRawTelegramMessage(
        chatId,
        `PulseHUD Paper Equity: $${portfolio.equityUsd.toLocaleString('en-US')}\n${lines.join('\n') || 'No open paper positions.'}`,
      )
    }
  }

  private async sendRawTelegramMessage(chatId: string, text: string): Promise<boolean> {
    if (!this.isLiveBot() || !chatId) return false
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(7000),
    })
    const json = (await res.json()) as { ok: boolean; description?: string }
    if (!json.ok) {
      throw new Error(json.description ?? 'Telegram sendMessage failed')
    }
    return true
  }

  public async sendReplyOrBroadcast(params: {
    signalId?: string
    chatId?: string
    text: string
    kind: 'tg_reply' | 'tg_share_signal' | 'tg_broadcast_digest'
  }): Promise<{ receipt: ExecutionReceipt; toast: string }> {
    const targetChatId = params.chatId || this.chatId || 'desk-alpha'
    const cleanText = params.text.trim()
    let deliveredExternal = false

    if (this.isLiveBot() && this.chatId) {
      try {
        deliveredExternal = await this.sendRawTelegramMessage(targetChatId, cleanText)
        this.lastError = undefined
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : 'Telegram send error'
      }
    }

    if (params.signalId) {
      const existing = this.messages.find((m) => m.id === params.signalId)
      if (existing) {
        existing.unread = false
        existing.repliedText = cleanText
        existing.repliedAt = Date.now()
      }
    }

    const now = Date.now()
    const title =
      params.kind === 'tg_reply'
        ? 'TG REPLY SENT'
        : params.kind === 'tg_broadcast_digest'
          ? 'TG DIGEST SENT'
          : 'TG ALERT POSTED'

    const deliveryLabel = deliveredExternal ? 'Live Telegram Bot' : 'Telegram Desk Bridge'
    const receipt: ExecutionReceipt = {
      id: `rcpt-${now}`,
      timestamp: now,
      type: params.kind,
      title,
      detail: `${deliveryLabel}: "${cleanText.slice(0, 96)}"`,
      venue: 'telegram',
      deliveredExternal,
    }

    return {
      receipt,
      toast: deliveredExternal ? `${title} (LIVE BOT)` : `${title} (TG DESK)`,
    }
  }

  public getMessages(): TelegramMessageSignal[] {
    return this.messages.map((m) => ({ ...m, smartDrafts: [...m.smartDrafts] }))
  }

  public getHealth() {
    return {
      mode: (this.isLiveBot() ? 'live_bot' : 'desk_bridge') as 'live_bot' | 'desk_bridge',
      botUsername: this.botUsername,
      chatIdConfigured: Boolean(this.chatId),
      unreadCount: this.messages.filter((m) => m.unread).length,
      lastSyncAt: this.lastSyncAt,
      error: this.lastError,
    }
  }
}

export function formatDigestText(
  hl: HyperliquidPerpSignal[],
  pm: PolymarketOddsSignal[],
  portfolio: PortfolioSnapshot,
): string {
  const topHl = hl
    .slice(0, 2)
    .map(
      (s) =>
        `${s.coin} $${Math.round(s.markPx).toLocaleString('en-US')} (${s.change24hPct >= 0 ? '+' : ''}${s.change24hPct}% | fund ${s.fundingAprPct >= 0 ? '+' : ''}${s.fundingAprPct}% APR)`,
    )
    .join(' · ')
  const topPm = pm[0]
    ? `Poly: ${pm[0].shortTitle} ${Math.round(pm[0].yesPrice * 100)}c`
    : 'Poly: syncing'
  const pnlSign = portfolio.unrealizedPnlUsd >= 0 ? '+' : ''
  return `[PulseHUD G2 Digest] ${topHl} | ${topPm} | Paper Equity $${portfolio.equityUsd.toLocaleString('en-US')} (${pnlSign}$${portfolio.unrealizedPnlUsd.toFixed(2)})`
}
