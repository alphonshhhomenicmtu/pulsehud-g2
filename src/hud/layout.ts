import {
  CreateStartUpPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import { measureTextWrap, pxTruncate } from '@evenrealities/pretext'
import type {
  HudChannel,
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PortfolioSnapshot,
  PulseStateSnapshot,
  SignalCard,
  StagedAction,
  TelegramMessageSignal,
} from '../../shared/types.js'
import { renderVoiceMeter } from './audio.js'

export const G2_CANVAS_W = 576
export const G2_CANVAS_H = 288
export const MAX_TEXT_CONTAINER_BYTES = 999

export const MENU_IDS = {
  ALL_SIGNALS: 1,
  HYPERLIQUID: 2,
  POLYMARKET: 3,
  TELEGRAM_DESK: 4,
  PORTFOLIO: 5,
  SEND_DIGEST: 6,
} as const

export type HudScreenKind = 'feed' | 'actions' | 'confirm' | 'voice' | 'portfolio'

export interface HudRenderModel {
  screen: HudScreenKind
  channel: HudChannel
  state: PulseStateSnapshot
  signals: SignalCard[]
  signalIndex: number
  actions: StagedAction[]
  actionIndex: number
  stagedAction: StagedAction | null
  confirmSelection: 'confirm' | 'cancel'
  voiceActive: boolean
  voiceStatusLine: string
  voiceDurationMs: number
  voiceLevel: number
  voiceTick: number
  toast: string | null
}

export interface RenderedSlot {
  containerID: number
  containerName: string
  content: string
  textColor: number
  xPosition: number
  yPosition: number
  width: number
  height: number
  borderWidth: number
  borderColor: number
  borderRadius: number
  paddingLength: number
  isEventCapture: number
}

export interface BuiltHudPage {
  layoutKey: HudScreenKind
  slots: RenderedSlot[]
  menuObject: MenuContainerProperty
}

export function buildContextMenu(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU_IDS.ALL_SIGNALS, itemName: 'All Signals' }),
      new MenuItemProperty({ itemID: MENU_IDS.HYPERLIQUID, itemName: 'Hyperliquid Perps' }),
      new MenuItemProperty({ itemID: MENU_IDS.POLYMARKET, itemName: 'Polymarket Odds' }),
      new MenuItemProperty({ itemID: MENU_IDS.TELEGRAM_DESK, itemName: 'Telegram Desk' }),
      new MenuItemProperty({ itemID: MENU_IDS.PORTFOLIO, itemName: 'Paper Portfolio' }),
      new MenuItemProperty({ itemID: MENU_IDS.SEND_DIGEST, itemName: 'Send Digest -> TG' }),
    ],
  })
}

export function fitSingleLine(text: string, maxPx: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return pxTruncate(flat, maxPx)
}

export function wrapToLines(text: string, maxPx: number, maxLines: number): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return []
  if (measureTextWrap(cleaned, maxPx).lineCount <= 1) {
    return [cleaned]
  }

  const words = cleaned.split(' ')
  const lines: string[] = []
  let current = ''

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]
    const candidate = current ? `${current} ${word}` : word
    if (measureTextWrap(candidate, maxPx).lineCount <= 1) {
      current = candidate
    } else {
      if (current) {
        lines.push(current)
        if (lines.length === maxLines - 1) {
          const rest = words.slice(i).join(' ')
          lines.push(pxTruncate(rest, maxPx))
          return lines
        }
      }
      current = pxTruncate(word, maxPx)
    }
  }
  if (current) lines.push(current)
  return lines.slice(0, maxLines)
}

function clampBytes(text: string, maxBytes = MAX_TEXT_CONTAINER_BYTES): string {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return text
  let end = text.length
  while (end > 0 && encoder.encode(text.slice(0, end)).byteLength > maxBytes - 3) {
    end -= 8
  }
  return `${text.slice(0, Math.max(0, end))}...`
}

function formatCompactUsd(amount: number): string {
  const abs = Math.abs(amount)
  if (abs >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}B`
  if (abs >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`
  return `$${amount.toFixed(0)}`
}

function formatPrice(px: number): string {
  if (px >= 1000) return `$${px.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
  if (px >= 10) return `$${px.toFixed(2)}`
  return `$${px.toFixed(4)}`
}

function renderProgressBar(ratio: number, segments = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * segments)
  return `${'━'.repeat(filled)}${'─'.repeat(segments - filled)}`
}

function formatAgo(ts: number, now: number): string {
  const diffSec = Math.max(0, Math.round((now - ts) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const mins = Math.round(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.round(mins / 60)}h ago`
}

function buildFeedCardContent(
  signal: SignalCard | undefined,
  portfolio: PortfolioSnapshot,
  innerPx: number,
  now: number,
): string {
  if (!signal) {
    return 'Syncing live Hyperliquid & Polymarket feeds...\nPress Menu to switch channels.'
  }

  if (signal.kind === 'hyperliquid') {
    return formatHyperliquidCard(signal, portfolio, innerPx)
  }
  if (signal.kind === 'polymarket') {
    return formatPolymarketCard(signal, innerPx)
  }
  return formatTelegramCard(signal, innerPx, now)
}

function formatHyperliquidCard(
  signal: HyperliquidPerpSignal,
  portfolio: PortfolioSnapshot,
  innerPx: number,
): string {
  const arrow = signal.change24hPct >= 0 ? '▲' : '▼'
  const sign = signal.change24hPct >= 0 ? '+' : ''
  const fundSign = signal.fundingAprPct >= 0 ? '+' : ''
  const pos = portfolio.positions.find(
    (p) => p.venue === 'hyperliquid' && p.symbol === `${signal.coin}-PERP`,
  )
  const posText = pos
    ? `POS ${pos.side} ${pos.unrealizedPnlUsd >= 0 ? '+' : ''}$${pos.unrealizedPnlUsd.toFixed(2)}`
    : 'NO PAPER POS'
  const spreadText = signal.spreadBps !== null ? `Sprd ${signal.spreadBps.toFixed(1)}bps` : 'Live Mark'

  const lines = [
    fitSingleLine(`${signal.coin}-PERP   ${formatPrice(signal.markPx)}   ${arrow} ${sign}${signal.change24hPct.toFixed(2)}%`, innerPx),
    fitSingleLine(`Funding ${fundSign}${signal.fundingAprPct.toFixed(1)}% APR   ·   OI ${formatCompactUsd(signal.openInterestUsd)}`, innerPx),
    fitSingleLine(`24h Vol ${formatCompactUsd(signal.volume24hUsd)}   ·   ${spreadText}`, innerPx),
    fitSingleLine(`[${signal.alertTag}]   ·   ${posText}`, innerPx),
  ]
  return lines.join('\n')
}

function formatPolymarketCard(signal: PolymarketOddsSignal, innerPx: number): string {
  const yesCents = Math.round(signal.yesPrice * 100)
  const noCents = 100 - yesCents
  const arrow = signal.change24hCents >= 0 ? '▲' : '▼'
  const sign = signal.change24hCents >= 0 ? '+' : ''
  const bar = renderProgressBar(signal.yesPrice, 10)
  const bookTag =
    signal.spreadCents !== null ? `CLOB ${signal.spreadCents.toFixed(1)}c` : 'Gamma Live'

  const titleLines = wrapToLines(signal.shortTitle, innerPx, 2)
  const lines = [
    ...titleLines,
    fitSingleLine(`YES ${yesCents}c (${arrow} ${sign}${signal.change24hCents.toFixed(1)}c)   ·   NO ${noCents}c`, innerPx),
    fitSingleLine(`${bar} ${yesCents}%   ·   ${bookTag}   ·   ${formatCompactUsd(signal.volume24hUsd)}`, innerPx),
  ]
  return lines.slice(0, 4).join('\n')
}

function formatTelegramCard(signal: TelegramMessageSignal, innerPx: number, now: number): string {
  const statusDot = signal.unread ? '●' : '○'
  const header = fitSingleLine(
    `${statusDot} ${signal.sender} · ${signal.chatName} (${formatAgo(signal.receivedAt, now)})`,
    innerPx,
  )
  const bodyLines = wrapToLines(`"${signal.text}"`, innerPx, 2)
  const statusLine = signal.repliedText
    ? fitSingleLine(`★ Replied: "${signal.repliedText}"`, innerPx)
    : fitSingleLine('▶ Tap for 3 smart replies  ·  Hold for voice', innerPx)

  return [header, ...bodyLines, statusLine].slice(0, 4).join('\n')
}

export function buildHudPage(model: HudRenderModel): BuiltHudPage {
  const menuObject = buildContextMenu()
  const now = model.state.serverTime || Date.now()
  const liveTag = model.state.offlineReplay
    ? 'REPLAY'
    : model.state.health.hyperliquid.status === 'live' ||
        model.state.health.polymarket.status === 'live'
      ? 'LIVE'
      : 'SYNC'

  if (model.screen === 'feed') {
    const active = model.signals[model.signalIndex]
    const channelLabel =
      active?.kind === 'hyperliquid'
        ? 'HYPERLIQUID'
        : active?.kind === 'polymarket'
          ? 'POLYMARKET'
          : active?.kind === 'telegram'
            ? 'TELEGRAM DESK'
            : model.channel.toUpperCase()

    const hdrContent = fitSingleLine(
      `● PULSEHUD  ·  ${channelLabel}  ·  ${model.signals.length ? model.signalIndex + 1 : 0}/${model.signals.length}  ·  ${liveTag}`,
      556,
    )
    const cardContent = buildFeedCardContent(active, model.state.portfolio, 538, now)

    const pnl = model.state.portfolio.unrealizedPnlUsd
    const pnlSign = pnl >= 0 ? '+' : ''
    const metaContent = model.toast
      ? fitSingleLine(`★ ${model.toast}`, 548)
      : fitSingleLine(
          `Paper Eq $${model.state.portfolio.equityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${pnlSign}$${pnl.toFixed(2)})  ·  TG Unread: ${model.state.health.telegram.unreadCount}`,
          548,
        )

    const footContent = fitSingleLine(
      '↕ Swipe: Next   ● Tap: Act   ■ Hold: Voice   ≡ Menu',
      552,
    )

    return {
      layoutKey: 'feed',
      menuObject,
      slots: [
        {
          containerID: 1,
          containerName: 'hdr',
          xPosition: 8,
          yPosition: 4,
          width: 560,
          height: 34,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 2,
          content: clampBytes(hdrContent),
          textColor: 2,
          isEventCapture: 0,
        },
        {
          containerID: 2,
          containerName: 'card',
          xPosition: 8,
          yPosition: 42,
          width: 560,
          height: 152,
          borderWidth: 1,
          borderColor: 8,
          borderRadius: 8,
          paddingLength: 10,
          content: clampBytes(cardContent),
          textColor: 4,
          isEventCapture: 1,
        },
        {
          containerID: 3,
          containerName: 'meta',
          xPosition: 8,
          yPosition: 198,
          width: 560,
          height: 42,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 6,
          content: clampBytes(metaContent),
          textColor: model.toast ? 4 : 3,
          isEventCapture: 0,
        },
        {
          containerID: 4,
          containerName: 'foot',
          xPosition: 8,
          yPosition: 246,
          width: 560,
          height: 36,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 4,
          content: clampBytes(footContent),
          textColor: 1,
          isEventCapture: 0,
        },
      ],
    }
  }

  if (model.screen === 'actions') {
    const active = model.signals[model.signalIndex]
    const contextLabel =
      active?.kind === 'hyperliquid'
        ? `${active.coin}-PERP (${formatPrice(active.markPx)})`
        : active?.kind === 'polymarket'
          ? `POLY ${Math.round(active.yesPrice * 100)}c YES`
          : active?.kind === 'telegram'
            ? `REPLY -> ${active.sender}`
            : 'QUICK ACTIONS'

    const hdrContent = fitSingleLine(`▶ WRITE ACTIONS  ·  ${contextLabel}`, 556)
    const optionLines = model.actions.slice(0, 5).map((act, idx) => {
      const marker = idx === model.actionIndex ? '▶ ' : '○ '
      return fitSingleLine(`${marker}${act.label}`, 538)
    })
    const optsContent =
      optionLines.length > 0 ? optionLines.join('\n') : 'No actions available for this card.'
    const footContent = fitSingleLine(
      '↕ Swipe: Pick   ● Tap: Review   ◀ 2xTap: Back',
      552,
    )

    return {
      layoutKey: 'actions',
      menuObject,
      slots: [
        {
          containerID: 1,
          containerName: 'hdr',
          xPosition: 8,
          yPosition: 4,
          width: 560,
          height: 34,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 2,
          content: clampBytes(hdrContent),
          textColor: 3,
          isEventCapture: 0,
        },
        {
          containerID: 2,
          containerName: 'opts',
          xPosition: 8,
          yPosition: 42,
          width: 560,
          height: 194,
          borderWidth: 1,
          borderColor: 10,
          borderRadius: 8,
          paddingLength: 10,
          content: clampBytes(optsContent),
          textColor: 4,
          isEventCapture: 1,
        },
        {
          containerID: 3,
          containerName: 'foot',
          xPosition: 8,
          yPosition: 244,
          width: 560,
          height: 38,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 4,
          content: clampBytes(footContent),
          textColor: 1,
          isEventCapture: 0,
        },
      ],
    }
  }

  if (model.screen === 'confirm') {
    const staged = model.stagedAction
    const hdrContent = fitSingleLine(
      `▲ CONFIRM WRITE  ·  ${staged?.source === 'voice' ? 'VOICE STAGED' : '1-TAP GATE'}`,
      556,
    )

    const summaryLines = staged ? wrapToLines(staged.summary, 534, 2) : ['No action staged.']
    const ctaLine =
      model.confirmSelection === 'confirm'
        ? '▶ CONFIRM & EXECUTE [TAP]     ○ Cancel'
        : '○ Confirm     ▶ CANCEL & BACK [TAP]'

    const gateLines = [
      fitSingleLine(staged?.headline ?? 'CONFIRM ACTION', 534),
      ...summaryLines,
      fitSingleLine(ctaLine, 534),
    ]

    const riskContent = fitSingleLine(
      staged?.riskNote ?? 'PAPER MODE ONLY · Explicit human confirmation required.',
      548,
    )
    const footContent = fitSingleLine(
      '● Tap: Submit   ↕ Swipe: Toggle   ◀ 2xTap: Cancel',
      552,
    )

    return {
      layoutKey: 'confirm',
      menuObject,
      slots: [
        {
          containerID: 1,
          containerName: 'hdr',
          xPosition: 8,
          yPosition: 4,
          width: 560,
          height: 34,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 2,
          content: clampBytes(hdrContent),
          textColor: 3,
          isEventCapture: 0,
        },
        {
          containerID: 2,
          containerName: 'gate',
          xPosition: 8,
          yPosition: 42,
          width: 560,
          height: 148,
          borderWidth: 2,
          borderColor: 15,
          borderRadius: 8,
          paddingLength: 10,
          content: clampBytes(gateLines.slice(0, 4).join('\n')),
          textColor: 4,
          isEventCapture: 1,
        },
        {
          containerID: 3,
          containerName: 'risk',
          xPosition: 8,
          yPosition: 196,
          width: 560,
          height: 42,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 6,
          content: clampBytes(riskContent),
          textColor: 2,
          isEventCapture: 0,
        },
        {
          containerID: 4,
          containerName: 'foot',
          xPosition: 8,
          yPosition: 244,
          width: 560,
          height: 38,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 4,
          content: clampBytes(footContent),
          textColor: 1,
          isEventCapture: 0,
        },
      ],
    }
  }

  if (model.screen === 'voice') {
    const hdrContent = fitSingleLine('■ VOICE COMMAND  ·  G2 4-MIC 16kHz PCM', 556)
    const meter = model.voiceActive
      ? renderVoiceMeter(model.voiceLevel, model.voiceTick)
      : '────────'
    const secs = (model.voiceDurationMs / 1000).toFixed(1)

    const bodyLines = model.voiceActive
      ? [
          fitSingleLine(`LISTENING...   ${meter}   (${secs}s)`, 532),
          fitSingleLine('Speak a short command, then release:', 532),
          fitSingleLine('· "Paper short 1000 BTC"  /  "Buy 50 yes BTC"', 532),
          fitSingleLine('· "Reply: hedging 25% now"  /  "Send digest"', 532),
        ]
      : [
          fitSingleLine('VOICE PIPELINE READY', 532),
          ...wrapToLines(model.voiceStatusLine, 532, 3),
        ]

    const footContent = fitSingleLine(
      'Release / Tap: Process   ◀ 2xTap: Return to Feed',
      552,
    )

    return {
      layoutKey: 'voice',
      menuObject,
      slots: [
        {
          containerID: 1,
          containerName: 'hdr',
          xPosition: 8,
          yPosition: 4,
          width: 560,
          height: 34,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 2,
          content: clampBytes(hdrContent),
          textColor: 3,
          isEventCapture: 0,
        },
        {
          containerID: 2,
          containerName: 'mic',
          xPosition: 8,
          yPosition: 42,
          width: 560,
          height: 194,
          borderWidth: 2,
          borderColor: 12,
          borderRadius: 8,
          paddingLength: 12,
          content: clampBytes(bodyLines.slice(0, 5).join('\n')),
          textColor: 4,
          isEventCapture: 1,
        },
        {
          containerID: 3,
          containerName: 'foot',
          xPosition: 8,
          yPosition: 244,
          width: 560,
          height: 38,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 4,
          content: clampBytes(footContent),
          textColor: 1,
          isEventCapture: 0,
        },
      ],
    }
  }

  // Portfolio & Execution Ledger screen
  const portfolio = model.state.portfolio
  const uSign = portfolio.unrealizedPnlUsd >= 0 ? '+' : ''
  const rSign = portfolio.realizedPnlUsd >= 0 ? '+' : ''
  const hdrContent = fitSingleLine('● PAPER PORTFOLIO  ·  LIVE MARK-TO-MARKET', 556)

  const posLines: string[] = [
    fitSingleLine(
      `Equity $${portfolio.equityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}  ·  uPnL ${uSign}$${portfolio.unrealizedPnlUsd.toFixed(2)}  ·  rPnL ${rSign}$${portfolio.realizedPnlUsd.toFixed(2)}`,
      538,
    ),
  ]

  if (portfolio.positions.length === 0) {
    posLines.push('No open paper positions. Swipe to trade.')
  } else {
    for (const pos of portfolio.positions.slice(0, 3)) {
      const ps = pos.unrealizedPnlUsd >= 0 ? '+' : ''
      const shortSym = pos.symbol.length > 22 ? `${pos.symbol.slice(0, 21)}...` : pos.symbol
      posLines.push(
        fitSingleLine(
          `▶ ${shortSym} ${pos.side}  ·  ${ps}$${pos.unrealizedPnlUsd.toFixed(2)} (${ps}${pos.unrealizedPnlPct.toFixed(1)}%)`,
          538,
        ),
      )
    }
  }

  const latestReceipt = portfolio.receipts[0]
  const lastContent = latestReceipt
    ? fitSingleLine(`Last: ${latestReceipt.title} · ${latestReceipt.detail}`, 548)
    : fitSingleLine('No confirmed executions yet · Tap to flatten top position', 548)

  const footContent = fitSingleLine(
    '● Tap: Flatten Top   ↕ Swipe: Back to Feed   ≡ Menu',
    552,
  )

  return {
    layoutKey: 'portfolio',
    menuObject,
    slots: [
      {
        containerID: 1,
        containerName: 'hdr',
        xPosition: 8,
        yPosition: 4,
        width: 560,
        height: 34,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 2,
        content: clampBytes(hdrContent),
        textColor: 2,
        isEventCapture: 0,
      },
      {
        containerID: 2,
        containerName: 'book',
        xPosition: 8,
        yPosition: 42,
        width: 560,
        height: 152,
        borderWidth: 1,
        borderColor: 8,
        borderRadius: 8,
        paddingLength: 10,
        content: clampBytes(posLines.slice(0, 4).join('\n')),
        textColor: 4,
        isEventCapture: 1,
      },
      {
        containerID: 3,
        containerName: 'last',
        xPosition: 8,
        yPosition: 198,
        width: 560,
        height: 42,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 6,
        content: clampBytes(lastContent),
        textColor: 3,
        isEventCapture: 0,
      },
      {
        containerID: 4,
        containerName: 'foot',
        xPosition: 8,
        yPosition: 246,
        width: 560,
        height: 36,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: 4,
        content: clampBytes(footContent),
        textColor: 1,
        isEventCapture: 0,
      },
    ],
  }
}

export function toStartUpPageContainer(page: BuiltHudPage): CreateStartUpPageContainer {
  return new CreateStartUpPageContainer({
    containerTotalNum: page.slots.length,
    textObject: page.slots.map((slot) => new TextContainerProperty(slot)),
    menuObject: page.menuObject,
  })
}

export function toRebuildPageContainer(page: BuiltHudPage): RebuildPageContainer {
  return new RebuildPageContainer({
    containerTotalNum: page.slots.length,
    textObject: page.slots.map((slot) => new TextContainerProperty(slot)),
    menuObject: page.menuObject,
  })
}
