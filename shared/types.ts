export type FeedSourceStatus = 'live' | 'replay' | 'error'

export type HudChannel = 'all' | 'hyperliquid' | 'polymarket' | 'telegram'

export interface HyperliquidPerpSignal {
  id: string
  kind: 'hyperliquid'
  coin: string
  markPx: number
  prevDayPx: number
  change24hPct: number
  fundingHourly: number
  fundingAprPct: number
  openInterestUsd: number
  volume24hUsd: number
  bestBid: number | null
  bestAsk: number | null
  spreadBps: number | null
  alertTag: string
  updatedAt: number
}

export interface PolymarketOddsSignal {
  id: string
  kind: 'polymarket'
  marketId: string
  tokenId: string
  eventTitle: string
  question: string
  shortTitle: string
  yesPrice: number
  noPrice: number
  clobMidpoint: number | null
  bestBid: number | null
  bestAsk: number | null
  spreadCents: number | null
  change24hCents: number
  volume24hUsd: number
  alertTag: string
  updatedAt: number
}

export interface TelegramMessageSignal {
  id: string
  kind: 'telegram'
  chatId: string
  chatName: string
  sender: string
  text: string
  receivedAt: number
  unread: boolean
  origin: 'telegram_bot' | 'desk_bridge'
  repliedText?: string
  repliedAt?: number
  smartDrafts: string[]
}

export type SignalCard =
  | HyperliquidPerpSignal
  | PolymarketOddsSignal
  | TelegramMessageSignal

export type ActionType =
  | 'hl_paper_long'
  | 'hl_paper_short'
  | 'hl_flatten'
  | 'pm_paper_yes'
  | 'pm_paper_no'
  | 'tg_reply'
  | 'tg_share_signal'
  | 'tg_broadcast_digest'

export interface StagedAction {
  id: string
  type: ActionType
  label: string
  headline: string
  summary: string
  riskNote: string
  signalId?: string
  coin?: string
  marketId?: string
  notionalUsd?: number
  limitPrice?: number
  telegramChatId?: string
  telegramText?: string
  source: 'tap' | 'voice' | 'menu'
}

export interface PaperPosition {
  id: string
  venue: 'hyperliquid' | 'polymarket'
  symbol: string
  side: 'LONG' | 'SHORT' | 'YES' | 'NO'
  size: number
  entryPrice: number
  markPrice: number
  notionalUsd: number
  unrealizedPnlUsd: number
  unrealizedPnlPct: number
  openedAt: number
}

export interface ExecutionReceipt {
  id: string
  timestamp: number
  type: ActionType
  title: string
  detail: string
  venue: 'hyperliquid-paper' | 'polymarket-paper' | 'telegram'
  deliveredExternal: boolean
}

export interface PortfolioSnapshot {
  startingEquityUsd: number
  cashUsd: number
  equityUsd: number
  unrealizedPnlUsd: number
  realizedPnlUsd: number
  positions: PaperPosition[]
  receipts: ExecutionReceipt[]
}

export interface FeedHealth {
  hyperliquid: {
    status: FeedSourceStatus
    latencyMs: number | null
    lastSyncAt: number | null
    error?: string
  }
  polymarket: {
    status: FeedSourceStatus
    latencyMs: number | null
    lastSyncAt: number | null
    clobVerified: boolean
    error?: string
  }
  telegram: {
    mode: 'live_bot' | 'desk_bridge'
    botUsername: string | null
    chatIdConfigured: boolean
    unreadCount: number
    lastSyncAt: number | null
    error?: string
  }
  stt: {
    provider: 'openai_whisper' | 'deepgram' | 'local_command'
  }
}

export interface PulseStateSnapshot {
  serverTime: number
  offlineReplay: boolean
  health: FeedHealth
  hyperliquid: HyperliquidPerpSignal[]
  polymarket: PolymarketOddsSignal[]
  telegram: TelegramMessageSignal[]
  portfolio: PortfolioSnapshot
}

export interface VoiceCommandResponse {
  ok: boolean
  transcript: string
  provider: 'openai_whisper' | 'deepgram' | 'local_command'
  audioBytes?: number
  durationMs?: number
  stagedAction: StagedAction | null
  notice: string
}

export interface ExecuteActionRequest {
  action: StagedAction
}

export interface ExecuteActionResponse {
  ok: boolean
  receipt: ExecutionReceipt
  toast: string
  state: PulseStateSnapshot
}
