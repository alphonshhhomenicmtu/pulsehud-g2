import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
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
  ThresholdAlert,
  WatchedWalletPosition,
} from '../../shared/types.js'
import { shortenAddress } from '../../server/feeds/hyperliquid.js'
import { renderVoiceMeter } from './audio.js'
import {
  renderHyperliquidCandlesTiles,
  renderPolymarketSparklineTiles,
  renderUndoCountdownRing,
  renderWalletRiskBarTiles,
  type RenderedImageSlot,
} from './chartRaster.js'

export const G2_CANVAS_W = 576
export const G2_CANVAS_H = 288
export const MAX_TEXT_CONTAINER_BYTES = 999

export const MENU_IDS = {
  ALL_SIGNALS: 1,
  HYPERLIQUID: 2,
  POLYMARKET: 3,
  TELEGRAM_DESK: 4,
  WALLET_WATCH: 5,
  PORTFOLIO: 6,
  SEND_DIGEST: 7,
  ALERT_ACTION: 8,
} as const

export type HudScreenKind = 'feed' | 'actions' | 'confirm' | 'voice' | 'wallet' | 'portfolio'

export type ConfirmPhase = 'idle' | 'armed' | 'committing' | 'done'

export type HudLayoutKey =
  | 'feed-chart'
  | 'feed-text'
  | 'actions'
  | 'confirm'
  | 'voice'
  | 'wallet'
  | 'portfolio'

export interface HudRenderModel {
  screen: HudScreenKind
  channel: HudChannel
  borderlessOptics: boolean
  hlOrderSizeUsd: number
  pmStakeSizeUsd: number
  state: PulseStateSnapshot
  signals: SignalCard[]
  signalIndex: number
  actions: StagedAction[]
  actionIndex: number
  stagedAction: StagedAction | null
  confirmSelection: 'confirm' | 'cancel'
  confirmPhase: ConfirmPhase
  confirmArmed: boolean
  confirmRemainingMs: number
  confirmTotalMs: number
  voiceActive: boolean
  voiceStatusLine: string
  voiceDurationMs: number
  voiceLevel: number
  voiceTick: number
  activeAlert?: ThresholdAlert | null
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
  layoutKey: HudLayoutKey
  slots: RenderedSlot[]
  imageSlots: RenderedImageSlot[]
  menuObject: MenuContainerProperty
}

export function buildContextMenu(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemID: MENU_IDS.ALL_SIGNALS, itemName: 'All Signals' }),
      new MenuItemProperty({ itemID: MENU_IDS.HYPERLIQUID, itemName: 'Hyperliquid 15m' }),
      new MenuItemProperty({ itemID: MENU_IDS.POLYMARKET, itemName: 'Polymarket Odds' }),
      new MenuItemProperty({ itemID: MENU_IDS.TELEGRAM_DESK, itemName: 'Telegram Desk' }),
      new MenuItemProperty({ itemID: MENU_IDS.WALLET_WATCH, itemName: 'HL Wallet Watch' }),
      new MenuItemProperty({ itemID: MENU_IDS.PORTFOLIO, itemName: 'Paper Portfolio' }),
      new MenuItemProperty({ itemID: MENU_IDS.SEND_DIGEST, itemName: 'Send Digest -> TG' }),
      new MenuItemProperty({ itemID: MENU_IDS.ALERT_ACTION, itemName: 'Alert Hedge / Ack' }),
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
  if (px >= 1000) {
    return `$${px.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
  }
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

function formatHyperliquidChartHeader(
  signal: HyperliquidPerpSignal,
  portfolio: PortfolioSnapshot,
  watchedPos: WatchedWalletPosition | undefined,
  innerPx: number,
): string {
  const arrow = signal.change24hPct >= 0 ? '▲' : '▼'
  const sign = signal.change24hPct >= 0 ? '+' : ''
  const fundSign = signal.fundingAprPct >= 0 ? '+' : ''
  const spreadText = signal.spreadBps !== null ? `${signal.spreadBps.toFixed(1)}bps` : 'L2 --'

  const pos = portfolio.positions.find(
    (p) => p.venue === 'hyperliquid' && p.symbol === `${signal.coin}-PERP`,
  )
  const beTag = pos?.stopLossMode === 'breakeven' ? ' [BE]' : ''
  const paperText = pos
    ? `POS ${pos.side} ${pos.unrealizedPnlUsd >= 0 ? '+' : ''}$${pos.unrealizedPnlUsd.toFixed(1)}${beTag}`
    : `[${signal.alertTag}]`

  const watchText = watchedPos
    ? `W:${watchedPos.side[0]} ${watchedPos.leverage}x Liq ${watchedPos.liqDistancePct !== null ? (watchedPos.liqDistancePct > 99 ? '>99%' : `${watchedPos.liqDistancePct.toFixed(1)}%`) : 'SAFE'}`
    : `Vol ${formatCompactUsd(signal.volume24hUsd)}`

  const lines = [
    fitSingleLine(
      `${signal.coin}-PERP  ${formatPrice(signal.markPx)}  ${arrow} ${sign}${signal.change24hPct.toFixed(2)}%`,
      innerPx,
    ),
    fitSingleLine(
      `Fund ${fundSign}${signal.fundingAprPct.toFixed(1)}% APR · OI ${formatCompactUsd(signal.openInterestUsd)} · ${spreadText}`,
      innerPx,
    ),
    fitSingleLine(`${paperText}  ·  ${watchText}`, innerPx),
  ]
  return lines.join('\n')
}

function formatPolymarketChartHeader(signal: PolymarketOddsSignal, innerPx: number): string {
  const yesCents = Math.round(signal.yesPrice * 100)
  const noCents = 100 - yesCents
  const arrow = signal.change24hCents >= 0 ? '▲' : '▼'
  const sign = signal.change24hCents >= 0 ? '+' : ''
  const bookTag =
    signal.spreadCents !== null ? `CLOB ${signal.spreadCents.toFixed(1)}c` : 'Gamma Live'

  const lines = [
    fitSingleLine(signal.shortTitle, innerPx),
    fitSingleLine(
      `YES ${yesCents}c (${arrow} ${sign}${signal.change24hCents.toFixed(1)}c)  ·  NO ${noCents}c`,
      innerPx,
    ),
    fitSingleLine(
      `${bookTag}  ·  Vol ${formatCompactUsd(signal.volume24hUsd)}  ·  [${signal.alertTag}]`,
      innerPx,
    ),
  ]
  return lines.join('\n')
}

function formatTelegramCard(signal: TelegramMessageSignal, innerPx: number, now: number): string {
  const statusDot = signal.unread ? '●' : '○'
  const coinTag = signal.linkedCoin ? ` [${signal.linkedCoin}]` : ''
  const header = fitSingleLine(
    `${statusDot} ${signal.sender} · ${signal.chatName}${coinTag} (${formatAgo(signal.receivedAt, now)})`,
    innerPx,
  )
  const bodyLines = wrapToLines(`"${signal.text}"`, innerPx, 2)
  const statusLine = signal.repliedText
    ? fitSingleLine(`★ Replied: "${signal.repliedText}"`, innerPx)
    : signal.linkedCoin
      ? fitSingleLine(`▶ Tap: 3 Replies + Coin-Lock Trade ${signal.linkedCoin}`, innerPx)
      : fitSingleLine('▶ Tap for 3 smart replies  ·  Hold for voice', innerPx)

  return [header, ...bodyLines, statusLine].slice(0, 4).join('\n')
}

export function buildHudPage(model: HudRenderModel): BuiltHudPage {
  const menuObject = buildContextMenu()
  const now = model.state.serverTime || Date.now()
  const cardBorderW = model.borderlessOptics ? 0 : 1
  const cardBorderC = model.borderlessOptics ? 0 : 8

  if (model.screen === 'feed') {
    const active = model.signals[model.signalIndex]
    let liveTag: string
    if (active?.kind === 'hyperliquid') {
      if (active.candlesSource === 'synthetic') {
        liveTag = 'FALLBACK'
      } else if (active.candlesSource === 'unavailable' || active.candles15m.length < 6) {
        liveTag = 'SYNC'
      } else if (model.state.offlineReplay) {
        liveTag = 'REPLAY'
      } else if (model.state.health.hyperliquid.status === 'live') {
        liveTag = 'LIVE'
      } else {
        liveTag = 'FALLBACK'
      }
    } else if (active?.kind === 'polymarket') {
      liveTag = model.state.offlineReplay
        ? 'REPLAY'
        : model.state.health.polymarket.status === 'live'
          ? 'LIVE'
          : 'FALLBACK'
    } else {
      liveTag = model.state.offlineReplay
        ? 'REPLAY'
        : model.state.health.hyperliquid.status === 'live' ||
            model.state.health.polymarket.status === 'live'
          ? 'LIVE'
          : 'SYNC'
    }

    const channelLabel =
      active?.kind === 'hyperliquid'
        ? active.candlesSource === 'synthetic'
          ? 'HL 15M FALLBACK'
          : 'HYPERLIQUID 15M'
        : active?.kind === 'polymarket'
          ? 'POLYMARKET CLOB'
          : active?.kind === 'telegram'
            ? 'TELEGRAM DESK'
            : model.channel.toUpperCase()

    const hdrContent = fitSingleLine(
      `● PULSEHUD · ${channelLabel} · ${model.signals.length ? model.signalIndex + 1 : 0}/${model.signals.length} · ${liveTag}`,
      556,
    )

    const pnl = model.state.portfolio.unrealizedPnlUsd
    const pnlSign = pnl >= 0 ? '+' : ''
    const w = model.state.watchedWallet
    const nearestWatched = w.positions[0]
    const nearestLiqStr = nearestWatched
      ? nearestWatched.liqDistancePct !== null
        ? nearestWatched.liqDistancePct > 99
          ? '>99%'
          : `${nearestWatched.liqDistancePct.toFixed(1)}%`
        : 'SAFE'
      : null
    const watchSummary =
      nearestWatched && nearestLiqStr
        ? `Liq ${nearestWatched.coin} ${nearestLiqStr}`
        : `TG Unread: ${model.state.health.telegram.unreadCount}`

    const hasAlertBanner = !model.toast && Boolean(model.activeAlert)
    const metaContent = model.toast
      ? fitSingleLine(`★ ${model.toast}`, 552)
      : model.activeAlert
        ? fitSingleLine(model.activeAlert.bannerText, 552)
        : fitSingleLine(
            `DEMO Paper $${model.state.portfolio.equityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${pnlSign}$${pnl.toFixed(1)}) · ${watchSummary} · TG:${model.state.health.telegram.unreadCount}`,
            552,
          )

    const footContent = fitSingleLine(
      '↕ Swipe: Next   ● Tap: Act   ■ Hold: Voice   ≡ Menu',
      552,
    )

    // Hyperliquid & Polymarket use Borderless Graphics Layout with live updateImageRawData tiles
    if (active && (active.kind === 'hyperliquid' || active.kind === 'polymarket')) {
      let cardContent = ''
      let imageSlots: RenderedImageSlot[] = []

      if (active.kind === 'hyperliquid') {
        const watchedPos = model.state.watchedWallet.positions.find((p) => p.coin === active.coin)
        const paperPos = model.state.portfolio.positions.find(
          (p) => p.venue === 'hyperliquid' && p.symbol === `${active.coin}-PERP`,
        )
        cardContent = formatHyperliquidChartHeader(active, model.state.portfolio, watchedPos, 548)
        imageSlots = renderHyperliquidCandlesTiles(active, watchedPos, paperPos)
      } else {
        cardContent = formatPolymarketChartHeader(active, 548)
        imageSlots = renderPolymarketSparklineTiles(active)
      }

      return {
        layoutKey: 'feed-chart',
        menuObject,
        imageSlots,
        slots: [
          {
            containerID: 1,
            containerName: 'hdr',
            xPosition: 8,
            yPosition: 0,
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
            yPosition: 34,
            width: 560,
            height: 92,
            borderWidth: cardBorderW,
            borderColor: cardBorderC,
            borderRadius: model.borderlessOptics ? 0 : 6,
            paddingLength: model.borderlessOptics ? 2 : 6,
            content: clampBytes(cardContent),
            textColor: 4,
            isEventCapture: 1,
          },
          {
            containerID: 3,
            containerName: 'meta',
            xPosition: 8,
            yPosition: 200,
            width: 560,
            height: 38,
            borderWidth: 0,
            borderColor: 0,
            borderRadius: 0,
            paddingLength: 4,
            content: clampBytes(metaContent),
            textColor: model.toast || hasAlertBanner ? 4 : 3,
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

    // Telegram Desk / Empty card uses clean borderless 4-text layout
    const cardContent = active
      ? formatTelegramCard(active, 544, now)
      : 'Syncing live Hyperliquid & Polymarket feeds...\nPress Menu to switch channels.'

    return {
      layoutKey: 'feed-text',
      menuObject,
      imageSlots: [],
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
          borderWidth: cardBorderW,
          borderColor: cardBorderC,
          borderRadius: model.borderlessOptics ? 0 : 8,
          paddingLength: model.borderlessOptics ? 6 : 10,
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
          textColor: model.toast || hasAlertBanner ? 4 : 3,
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
        ? `${active.coin}-PERP (${formatPrice(active.markPx)}) · $${model.hlOrderSizeUsd}`
        : active?.kind === 'polymarket'
          ? `POLY ${Math.round(active.yesPrice * 100)}c YES · $${model.pmStakeSizeUsd}`
          : active?.kind === 'telegram'
            ? `TG ${active.sender}${active.linkedCoin ? ` [${active.linkedCoin}]` : ''}`
            : 'QUICK ACTIONS'

    const hdrContent = fitSingleLine(`▶ WRITE ACTIONS · ${contextLabel}`, 556)

    // Scrollable window of 5 lines centered around actionIndex so all 6 options stay visible
    const visibleCount = 5
    const startIdx = Math.max(
      0,
      Math.min(model.actionIndex - 2, Math.max(0, model.actions.length - visibleCount)),
    )
    const slice = model.actions.slice(startIdx, startIdx + visibleCount)
    const optionLines = slice.map((act, offset) => {
      const realIdx = startIdx + offset
      const marker = realIdx === model.actionIndex ? '▶ ' : '○ '
      return fitSingleLine(`${marker}${act.label}`, 538)
    })

    const optsContent =
      optionLines.length > 0 ? optionLines.join('\n') : 'No actions available for this card.'
    const footContent = fitSingleLine(
      '↕ Swipe: Pick   ● Tap: Stage/Cycle   ◀ 2xTap: Back',
      552,
    )

    return {
      layoutKey: 'actions',
      menuObject,
      imageSlots: [],
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
          borderWidth: model.borderlessOptics ? 0 : 1,
          borderColor: model.borderlessOptics ? 0 : 10,
          borderRadius: model.borderlessOptics ? 0 : 8,
          paddingLength: 8,
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
    const isCommitting = model.confirmPhase === 'committing'
    const isArmed = !isCommitting && (model.confirmPhase === 'armed' || model.confirmArmed)
    const ringSlot = renderUndoCountdownRing(
      isCommitting ? 0 : model.confirmRemainingMs,
      model.confirmTotalMs,
      isArmed,
      isCommitting,
    )

    const remSecs = (Math.max(0, model.confirmRemainingMs) / 1000).toFixed(1)
    const hdrContent = isCommitting
      ? fitSingleLine('▲ SENDING · COMMITTING ACTION (INPUT LOCKED)', 556)
      : isArmed
        ? fitSingleLine(`▲ ARMED · EXECUTING IN ${remSecs}s · TAP TO UNDO!`, 556)
        : fitSingleLine(
            `▲ CONFIRM WRITE · ${staged?.source === 'voice' ? 'VOICE STAGED' : '2.0s UNDO GATE'}`,
            556,
          )

    const summaryLines = staged ? wrapToLines(staged.summary, 444, 2) : ['No action staged.']
    let ctaLine = ''
    if (isCommitting) {
      ctaLine = '● COMMITTING WRITE · DUPLICATE TAPS LOCKED'
    } else if (isArmed) {
      const ratio = model.confirmRemainingMs / Math.max(1, model.confirmTotalMs)
      ctaLine = `◀ TAP NOW TO UNDO [${renderProgressBar(ratio, 8)} ${remSecs}s]`
    } else if (model.confirmSelection === 'confirm') {
      ctaLine = '▶ ARM 2.0s UNDO [TAP]   ○ Cancel'
    } else {
      ctaLine = '○ Arm 2.0s   ▶ CANCEL & BACK [TAP]'
    }

    const gateLines = [
      fitSingleLine(staged?.headline ?? 'CONFIRM ACTION', 444),
      ...summaryLines,
      fitSingleLine(ctaLine, 444),
    ]

    const riskContent = isCommitting
      ? fitSingleLine('IN-FLIGHT WRITE · Waiting for receipt (taps locked)', 548)
      : isArmed
        ? fitSingleLine('SAFETY WINDOW · Single tap or 2xTap cancels (0 writes)', 548)
        : fitSingleLine(
            staged?.riskNote ?? 'PAPER MODE ONLY · Tap arms 2.0s undo countdown.',
            548,
          )

    const footContent = isCommitting
      ? fitSingleLine('Sending...   (Inputs locked until receipt returns)', 552)
      : isArmed
        ? fitSingleLine('● Tap: UNDO NOW   ◀ 2xTap: UNDO   (Wait 2s to Send)', 552)
        : fitSingleLine('● Tap: Arm 2s Undo   ↕ Swipe: Toggle   ◀ 2xTap: Cancel', 552)

    return {
      layoutKey: 'confirm',
      menuObject,
      imageSlots: [ringSlot],
      slots: [
        {
          containerID: 1,
          containerName: 'hdr',
          xPosition: 8,
          yPosition: 2,
          width: 560,
          height: 34,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 2,
          content: clampBytes(hdrContent),
          textColor: isArmed || isCommitting ? 4 : 3,
          isEventCapture: 0,
        },
        {
          containerID: 2,
          containerName: 'gate',
          xPosition: 8,
          yPosition: 40,
          width: 472,
          height: 150,
          borderWidth: 2,
          borderColor: isArmed || isCommitting ? 15 : 12,
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
          height: 40,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 4,
          content: clampBytes(riskContent),
          textColor: isArmed || isCommitting ? 4 : 2,
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
    const hdrContent = fitSingleLine('■ VOICE COMMAND · G2 4-MIC 16kHz PCM', 556)
    const meter = model.voiceActive
      ? renderVoiceMeter(model.voiceLevel, model.voiceTick)
      : '────────'
    const secs = (model.voiceDurationMs / 1000).toFixed(1)

    const bodyLines = model.voiceActive
      ? [
          fitSingleLine(`LISTENING...   ${meter}   (${secs}s)`, 532),
          fitSingleLine('Zero-key local STT · Speak & release:', 532),
          fitSingleLine('· "Paper short 1000 BTC"  /  "Take 50% BTC"', 532),
          fitSingleLine('· "Move BTC stop to breakeven"  /  "Reply: hedging"', 532),
        ]
      : [
          fitSingleLine('VOICE PIPELINE READY · ZERO-KEY LOCAL STT', 532),
          ...wrapToLines(model.voiceStatusLine, 532, 3),
        ]

    const footContent = fitSingleLine(
      'Release / Tap: Process   ◀ 2xTap: Return to Feed',
      552,
    )

    return {
      layoutKey: 'voice',
      menuObject,
      imageSlots: [],
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

  if (model.screen === 'wallet') {
    const w = model.state.watchedWallet
    const uSign = w.totalUnrealizedPnlUsd >= 0 ? '+' : ''
    const hdrContent = fitSingleLine(
      `● HL WATCH · ${shortenAddress(w.address)} · ${w.status.toUpperCase()} · READ-ONLY`,
      556,
    )

    const summaryLines: string[] = []
    if (w.positions.length === 0) {
      summaryLines.push(
        fitSingleLine(
          `Acct ${formatCompactUsd(w.accountValueUsd)} · Margin ${w.marginRatioPct.toFixed(1)}% · uPnL ${uSign}${formatCompactUsd(w.totalUnrealizedPnlUsd)}`,
          548,
        ),
        fitSingleLine(
          w.error ? `Notice: ${w.error}` : 'No open perp positions on this public address.',
          548,
        ),
      )
    } else {
      // Row 1 leads directly with nearest liquidation distance (smallest liqDistancePct first)
      const topTwo = w.positions.slice(0, 2)
      topTwo.forEach((p, idx) => {
        const ps = p.unrealizedPnlUsd >= 0 ? '+' : ''
        const liqStr =
          p.liqDistancePct !== null
            ? p.liqDistancePct > 99
              ? '>99%'
              : `${p.liqDistancePct.toFixed(1)}%`
            : 'SAFE'
        const prefix = idx === 0 ? '▶ NEAREST LIQ' : '○ NEXT RISK'
        summaryLines.push(
          fitSingleLine(
            `${prefix}: ${p.coin} ${p.side} ${p.leverage}x · Liq ${liqStr} · ${ps}${formatCompactUsd(p.unrealizedPnlUsd)}`,
            548,
          ),
        )
      })
      summaryLines.push(
        fitSingleLine(
          `Acct ${formatCompactUsd(w.accountValueUsd)} · Margin ${w.marginRatioPct.toFixed(1)}% · uPnL ${uSign}${formatCompactUsd(w.totalUnrealizedPnlUsd)}`,
          548,
        ),
      )
    }

    const riskTiles = renderWalletRiskBarTiles(w)
    const hasLiqAlert = !model.toast && model.activeAlert?.kind === 'liq_risk'
    const metaContent = model.toast
      ? fitSingleLine(`★ ${model.toast}`, 552)
      : hasLiqAlert && model.activeAlert
        ? fitSingleLine(model.activeAlert.bannerText, 552)
        : fitSingleLine(`${w.label} · ${w.positions.length} active perps · Sorted by Nearest Liq`, 552)

    const footContent = fitSingleLine(
      '● Tap: Hedge Nearest Liq   ↕ Swipe: Feed   ≡ Menu',
      552,
    )

    return {
      layoutKey: 'wallet',
      menuObject,
      imageSlots: riskTiles,
      slots: [
        {
          containerID: 1,
          containerName: 'hdr',
          xPosition: 8,
          yPosition: 0,
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
          containerName: 'wbook',
          xPosition: 8,
          yPosition: 36,
          width: 560,
          height: 94,
          borderWidth: cardBorderW,
          borderColor: cardBorderC,
          borderRadius: model.borderlessOptics ? 0 : 6,
          paddingLength: model.borderlessOptics ? 2 : 6,
          content: clampBytes(summaryLines.slice(0, 3).join('\n')),
          textColor: 4,
          isEventCapture: 1,
        },
        {
          containerID: 3,
          containerName: 'meta',
          xPosition: 8,
          yPosition: 200,
          width: 560,
          height: 38,
          borderWidth: 0,
          borderColor: 0,
          borderRadius: 0,
          paddingLength: 4,
          content: clampBytes(metaContent),
          textColor: model.toast || hasLiqAlert ? 4 : 3,
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

  // Portfolio & Execution Ledger screen
  const portfolio = model.state.portfolio
  const uSign = portfolio.unrealizedPnlUsd >= 0 ? '+' : ''
  const rSign = portfolio.realizedPnlUsd >= 0 ? '+' : ''
  const hdrContent = fitSingleLine('● DEMO PAPER BOOK · LIVE MARK-TO-MARKET', 556)

  const posLines: string[] = [
    fitSingleLine(
      `Equity $${portfolio.equityUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })} · uPnL ${uSign}$${portfolio.unrealizedPnlUsd.toFixed(2)} · rPnL ${rSign}$${portfolio.realizedPnlUsd.toFixed(2)}`,
      544,
    ),
  ]

  if (portfolio.positions.length === 0) {
    posLines.push('No open paper positions. Swipe to trade.')
  } else {
    for (const pos of portfolio.positions.slice(0, 3)) {
      const ps = pos.unrealizedPnlUsd >= 0 ? '+' : ''
      const shortSym = pos.symbol.length > 20 ? `${pos.symbol.slice(0, 19)}...` : pos.symbol
      const slTag = pos.stopLossMode === 'breakeven' ? ' [BE]' : ''
      posLines.push(
        fitSingleLine(
          `▶ ${shortSym} ${pos.side}${slTag} · ${ps}$${pos.unrealizedPnlUsd.toFixed(2)} (${ps}${pos.unrealizedPnlPct.toFixed(1)}%)`,
          544,
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
    imageSlots: [],
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
        borderWidth: cardBorderW,
        borderColor: cardBorderC,
        borderRadius: model.borderlessOptics ? 0 : 8,
        paddingLength: model.borderlessOptics ? 6 : 10,
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
  const imageObject =
    page.imageSlots.length > 0
      ? page.imageSlots.map(
          (img) =>
            new ImageContainerProperty({
              containerID: img.containerID,
              containerName: img.containerName,
              xPosition: img.xPosition,
              yPosition: img.yPosition,
              width: img.width,
              height: img.height,
            }),
        )
      : undefined

  return new CreateStartUpPageContainer({
    containerTotalNum: page.slots.length + (imageObject?.length ?? 0),
    textObject: page.slots.map((slot) => new TextContainerProperty(slot)),
    imageObject,
    menuObject: page.menuObject,
  })
}

export function toRebuildPageContainer(page: BuiltHudPage): RebuildPageContainer {
  const imageObject =
    page.imageSlots.length > 0
      ? page.imageSlots.map(
          (img) =>
            new ImageContainerProperty({
              containerID: img.containerID,
              containerName: img.containerName,
              xPosition: img.xPosition,
              yPosition: img.yPosition,
              width: img.width,
              height: img.height,
            }),
        )
      : undefined

  return new RebuildPageContainer({
    containerTotalNum: page.slots.length + (imageObject?.length ?? 0),
    textObject: page.slots.map((slot) => new TextContainerProperty(slot)),
    imageObject,
    menuObject: page.menuObject,
  })
}
