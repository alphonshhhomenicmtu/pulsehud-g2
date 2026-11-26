import type { PulseStateSnapshot, ThresholdAlert } from '../../shared/types.js'

export const LIQ_ALERT_THRESHOLD_PCT = 5.0
export const FUNDING_ALERT_THRESHOLD_APR = 25.0
export const ODDS_SWING_ALERT_THRESHOLD_CENTS = 5.0

/**
 * Evaluates live market & watched-wallet telemetry for proactive risk or opportunity
 * threshold breaches. Returned alerts are sorted by severity/priority:
 *   1. Critical liquidation proximity (< 5.0% liq distance on watched Hyperliquid wallet)
 *   2. Extreme Hyperliquid funding rate (|fundingAprPct| >= 25.0% APR)
 *   3. Large Polymarket 24h probability swing (|change24hCents| >= 5.0c)
 *
 * Every alert carries a pre-built StagedAction that still passes through the mandatory
 * Confirm Gate + 2.0-second Arm/Undo safety ring (zero unconfirmed writes).
 */
export function evaluateThresholdAlerts(
  state: PulseStateSnapshot,
  hlOrderSizeUsd = 1000,
  pmStakeSizeUsd = 50,
): ThresholdAlert[] {
  const alerts: ThresholdAlert[] = []
  const now = state.serverTime || Date.now()

  // 1. Liquidation proximity breaches (< 5% distance on watched public HL wallet)
  const liqBreaches = state.watchedWallet.positions
    .filter((p) => p.liqDistancePct !== null && p.liqDistancePct < LIQ_ALERT_THRESHOLD_PCT)
    .sort((a, b) => (a.liqDistancePct ?? 999) - (b.liqDistancePct ?? 999))

  for (const pos of liqBreaches) {
    const dist = pos.liqDistancePct!
    const hedgeSide = pos.side === 'LONG' ? 'SHORT' : 'LONG'
    const hlSig = state.hyperliquid.find((s) => s.coin === pos.coin)
    const px = hlSig
      ? hedgeSide === 'SHORT'
        ? (hlSig.bestBid ?? hlSig.markPx)
        : (hlSig.bestAsk ?? hlSig.markPx)
      : pos.markPx
    alerts.push({
      id: `alert-liq-${pos.coin}`,
      kind: 'liq_risk',
      severity: 'critical',
      headline: `LIQ RISK ${pos.coin} ${dist.toFixed(1)}% (<5%)`,
      bannerText: `▲ [ALERT] LIQ ${pos.coin} ${dist.toFixed(1)}% (<5%) · Tap: Hedge`,
      coin: pos.coin,
      action: {
        id: `stage-alert-liq-${pos.coin}-${now}`,
        type: hedgeSide === 'SHORT' ? 'hl_paper_short' : 'hl_paper_long',
        label: `[ALERT] Hedge ${pos.coin} ${hedgeSide} $${hlOrderSizeUsd.toLocaleString('en-US')} (Liq ${dist.toFixed(1)}%)`,
        headline: `ALERT HEDGE ${pos.coin} (${hedgeSide})`,
        summary: `Watched ${pos.side} ${pos.coin} is ${dist.toFixed(1)}% from liq — stage $${hlOrderSizeUsd.toLocaleString('en-US')} paper ${hedgeSide} @ $${px.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
        riskNote: 'PROACTIVE LIQ ALERT · PAPER MODE ONLY · 2.0s undo safety window.',
        signalId: hlSig?.id,
        coin: pos.coin,
        notionalUsd: hlOrderSizeUsd,
        limitPrice: px,
        source: 'tap',
      },
    })
  }

  // 2. Extreme Hyperliquid funding rate breaches (|fundingAprPct| >= 25% APR)
  const fundingBreaches = state.hyperliquid
    .filter((s) => Math.abs(s.fundingAprPct) >= FUNDING_ALERT_THRESHOLD_APR)
    .sort((a, b) => Math.abs(b.fundingAprPct) - Math.abs(a.fundingAprPct))

  for (const sig of fundingBreaches) {
    const isPositive = sig.fundingAprPct >= 0
    const sign = isPositive ? '+' : ''
    const hedgeSide = isPositive ? 'SHORT' : 'LONG'
    const px = hedgeSide === 'SHORT' ? (sig.bestBid ?? sig.markPx) : (sig.bestAsk ?? sig.markPx)
    alerts.push({
      id: `alert-fund-${sig.coin}`,
      kind: 'funding_extreme',
      severity: 'warn',
      headline: `${sig.coin} FUND ${sign}${sig.fundingAprPct.toFixed(1)}% APR`,
      bannerText: `▲ [ALERT] ${sig.coin} FUND ${sign}${sig.fundingAprPct.toFixed(1)}% APR · Tap: Hedge`,
      coin: sig.coin,
      action: {
        id: `stage-alert-fund-${sig.coin}-${now}`,
        type: hedgeSide === 'SHORT' ? 'hl_paper_short' : 'hl_paper_long',
        label: `[ALERT] ${sig.coin} ${hedgeSide} $${hlOrderSizeUsd.toLocaleString('en-US')} (${sign}${sig.fundingAprPct.toFixed(1)}% APR)`,
        headline: `FUNDING HEDGE ${sig.coin} (${hedgeSide})`,
        summary: `${sig.coin} funding at ${sign}${sig.fundingAprPct.toFixed(1)}% APR — stage $${hlOrderSizeUsd.toLocaleString('en-US')} paper ${hedgeSide} @ $${px.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
        riskNote: 'PROACTIVE FUNDING ALERT · PAPER MODE ONLY · 2.0s undo window.',
        signalId: sig.id,
        coin: sig.coin,
        notionalUsd: hlOrderSizeUsd,
        limitPrice: px,
        source: 'tap',
      },
    })
  }

  // 3. Large Polymarket 24h odds swings (|change24hCents| >= 5.0c)
  const oddsBreaches = state.polymarket
    .filter((s) => Math.abs(s.change24hCents) >= ODDS_SWING_ALERT_THRESHOLD_CENTS)
    .sort((a, b) => Math.abs(b.change24hCents) - Math.abs(a.change24hCents))

  for (const pm of oddsBreaches) {
    const sign = pm.change24hCents >= 0 ? '+' : ''
    const side: 'YES' | 'NO' = pm.yesPrice >= 0.65 && pm.change24hCents > 0 ? 'NO' : 'YES'
    const limitPrice = side === 'YES' ? (pm.bestAsk ?? pm.yesPrice) : pm.noPrice
    const cents = Math.round(limitPrice * 100)
    const compactTitle =
      pm.shortTitle.length > 22 ? `${pm.shortTitle.slice(0, 20)}..` : pm.shortTitle

    alerts.push({
      id: `alert-odds-${pm.marketId}`,
      kind: 'odds_swing',
      severity: 'warn',
      headline: `POLY ${sign}${pm.change24hCents.toFixed(1)}c (${compactTitle})`,
      bannerText: `▲ [ALERT] POLY ${compactTitle} ${sign}${pm.change24hCents.toFixed(1)}c · Tap: Act`,
      marketId: pm.marketId,
      action: {
        id: `stage-alert-odds-${pm.marketId}-${now}`,
        type: side === 'YES' ? 'pm_paper_yes' : 'pm_paper_no',
        label: `[ALERT] Poly ${side} $${pmStakeSizeUsd} @ ${cents}c (${sign}${pm.change24hCents.toFixed(1)}c)`,
        headline: `ODDS ALERT POLY ${side} $${pmStakeSizeUsd}`,
        summary: `${pm.shortTitle} moved ${sign}${pm.change24hCents.toFixed(1)}c (24h) — stage $${pmStakeSizeUsd} paper ${side} @ ${cents}c`,
        riskNote: 'PROACTIVE ODDS ALERT · PAPER MODE ONLY · 2.0s undo window.',
        signalId: pm.id,
        marketId: pm.marketId,
        notionalUsd: pmStakeSizeUsd,
        limitPrice,
        source: 'tap',
      },
    })
  }

  return alerts
}

export function getTopThresholdAlert(
  state: PulseStateSnapshot,
  dismissedAlertIds: ReadonlySet<string>,
  hlOrderSizeUsd = 1000,
  pmStakeSizeUsd = 50,
): ThresholdAlert | null {
  const alerts = evaluateThresholdAlerts(state, hlOrderSizeUsd, pmStakeSizeUsd)
  return alerts.find((a) => !dismissedAlertIds.has(a.id)) ?? null
}
