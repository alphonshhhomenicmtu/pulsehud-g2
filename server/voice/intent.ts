import type {
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PortfolioSnapshot,
  StagedAction,
  TelegramMessageSignal,
} from '../../shared/types.js'
import { formatDigestText } from '../telegram/bridge.js'

/**
 * Wraps raw Even G2 16 kHz signed 16-bit little-endian mono PCM into a standard WAV container
 * compatible with OpenAI Whisper, Deepgram, and local audio tools.
 */
export function encodePcm16ToWav(pcm: Uint8Array, sampleRate = 16000): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcm.byteLength

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, Buffer.from(pcm)])
}

export function detectSttProvider(): 'openai_whisper' | 'deepgram' | 'local_command' {
  if (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY?.trim()) return 'openai_whisper'
  if (typeof process !== 'undefined' && process.env?.DEEPGRAM_API_KEY?.trim()) return 'deepgram'
  return 'local_command'
}

export async function transcribeGlassesAudio(pcm: Uint8Array): Promise<{
  transcript: string
  provider: 'openai_whisper' | 'deepgram' | 'local_command'
  notice: string
}> {
  const wav = encodePcm16ToWav(pcm, 16000)

  const openAiKey = process.env.OPENAI_API_KEY?.trim()
  if (openAiKey) {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'g2-voice.wav')
    form.append('model', 'whisper-1')
    form.append('language', 'en')

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiKey}` },
      body: form,
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      throw new Error(`OpenAI Whisper HTTP ${res.status}`)
    }
    const json = (await res.json()) as { text?: string }
    return {
      transcript: (json.text ?? '').trim(),
      provider: 'openai_whisper',
      notice: 'Transcribed via OpenAI Whisper from G2 4-mic PCM stream',
    }
  }

  const deepgramKey = process.env.DEEPGRAM_API_KEY?.trim()
  if (deepgramKey) {
    const res = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&language=en&smart_format=true',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${deepgramKey}`,
          'Content-Type': 'audio/wav',
        },
        body: new Uint8Array(wav),
        signal: AbortSignal.timeout(12_000),
      },
    )
    if (!res.ok) {
      throw new Error(`Deepgram HTTP ${res.status}`)
    }
    const json = (await res.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
    }
    const transcript = json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? ''
    return {
      transcript,
      provider: 'deepgram',
      notice: 'Transcribed via Deepgram Nova-2 from G2 4-mic PCM stream',
    }
  }

  return {
    transcript: '',
    provider: 'local_command',
    notice:
      'Captured real 16 kHz PCM from G2 mic. Set OPENAI_API_KEY/DEEPGRAM_API_KEY for cloud STT, or use Browser Web Speech / Voice Bar.',
  }
}

function extractCoin(lower: string): string | undefined {
  const coinMatch = lower.match(/\b(btc|bitcoin|eth|ethereum|sol|solana|hype)\b/i)
  if (!coinMatch) return undefined
  const token = coinMatch[1].toLowerCase()
  if (token.startsWith('bit')) return 'BTC'
  if (token.startsWith('eth')) return 'ETH'
  if (token.startsWith('sol')) return 'SOL'
  return token.toUpperCase()
}

/**
 * Deterministic voice-to-StagedAction parser.
 * Every parsed intent ALWAYS returns a staged action requiring explicit 1-tap arming + 2.0s undo window on G2.
 */
export function parseVoiceIntent(
  rawTranscript: string,
  context: {
    hl: HyperliquidPerpSignal[]
    pm: PolymarketOddsSignal[]
    tg: TelegramMessageSignal[]
    portfolio: PortfolioSnapshot
    activeSignalId?: string
  },
): StagedAction | null {
  const transcript = rawTranscript.trim()
  if (!transcript) return null
  const lower = transcript.toLowerCase()
  const now = Date.now()

  // 1. Reply to Telegram desk message
  const replyMatch = transcript.match(
    /^(?:reply|tell desk|message desk|text desk|send reply)\s*[:,-]?\s*(.+)$/i,
  )
  if (replyMatch) {
    const body = replyMatch[1].trim()
    const targetMsg =
      context.tg.find((m) => m.id === context.activeSignalId) ??
      context.tg.find((m) => m.unread) ??
      context.tg[0]
    return {
      id: `stage-${now}`,
      type: 'tg_reply',
      label: 'Send Voice Reply -> TG',
      headline: `TG REPLY -> ${targetMsg?.chatName ?? 'Alpha Desk'}`,
      summary: `"${body}"`,
      riskNote: 'Tap arms 2.0s undo countdown before Telegram send.',
      signalId: targetMsg?.id,
      telegramChatId: targetMsg?.chatId,
      telegramText: body,
      source: 'voice',
    }
  }

  // 2. Broadcast live digest to Telegram
  if (
    lower.includes('digest') ||
    (lower.includes('send') && lower.includes('telegram') && lower.includes('update'))
  ) {
    const digest = formatDigestText(context.hl, context.pm, context.portfolio)
    return {
      id: `stage-${now}`,
      type: 'tg_broadcast_digest',
      label: 'Broadcast Digest -> TG',
      headline: 'POST LIVE DIGEST -> TELEGRAM',
      summary: digest.slice(0, 120),
      riskNote: 'Read-only market summary · 2.0s undo safety window.',
      telegramText: digest,
      source: 'voice',
    }
  }

  // 3. Move Stop-Loss to Break-Even (BE)
  if (
    lower.includes('breakeven') ||
    lower.includes('break even') ||
    lower.includes('break-even') ||
    /\bsl to be\b/.test(lower) ||
    /\bstop to be\b/.test(lower)
  ) {
    const coin = extractCoin(lower) ?? context.portfolio.positions.find((p) => p.venue === 'hyperliquid')?.symbol.replace('-PERP', '') ?? 'BTC'
    return {
      id: `stage-${now}`,
      type: 'hl_move_sl_be',
      label: `Move ${coin} Stop -> Break-Even`,
      headline: `PAPER BE STOP ${coin}-PERP`,
      summary: `Arm protective paper break-even stop at entry price on ${coin}-PERP.`,
      riskNote: 'PAPER MODE ONLY · Tap arms 2.0s undo countdown.',
      coin,
      source: 'voice',
    }
  }

  // 4. Take 50% / Partial Close
  if (
    lower.includes('partial') ||
    lower.includes('take 50') ||
    lower.includes('trim half') ||
    lower.includes('close half') ||
    lower.includes('take half')
  ) {
    const coin = extractCoin(lower) ?? context.portfolio.positions.find((p) => p.venue === 'hyperliquid')?.symbol.replace('-PERP', '') ?? 'BTC'
    return {
      id: `stage-${now}`,
      type: 'hl_partial_close',
      label: `Take 50% Partial Close ${coin}`,
      headline: `PARTIAL 50% CLOSE ${coin}-PERP`,
      summary: `Reduce ${coin}-PERP paper position by 50% at live mark price.`,
      riskNote: 'PAPER MODE ONLY · Tap arms 2.0s undo countdown.',
      coin,
      closeFraction: 0.5,
      source: 'voice',
    }
  }

  // 5. Flatten / close position
  if (
    lower.includes('flatten') ||
    lower.includes('close position') ||
    lower.includes('exit position')
  ) {
    const coin = extractCoin(lower)
    return {
      id: `stage-${now}`,
      type: 'hl_flatten',
      label: coin ? `Flatten ${coin} Paper Pos` : 'Flatten Top Paper Pos',
      headline: coin ? `PAPER FLATTEN ${coin}-PERP` : 'PAPER FLATTEN TOP POSITION',
      summary: 'Close active paper position at current live mark.',
      riskNote: 'PAPER MODE ONLY · 2.0s post-tap undo window active.',
      coin,
      source: 'voice',
    }
  }

  // 6. Polymarket paper YES / NO bet
  if (
    lower.includes('yes') ||
    lower.includes('no') ||
    lower.includes('polymarket') ||
    lower.includes('bet')
  ) {
    const isNo = /\bno\b/.test(lower) && !/\byes\b/.test(lower)
    const side = isNo ? 'NO' : 'YES'
    const amountMatch = lower.match(/\$?\s*(\d{2,4})\b/)
    const notionalUsd = amountMatch ? Number(amountMatch[1]) : 50

    const activePm = context.pm.find((m) => m.id === context.activeSignalId)
    const keywordPm =
      context.pm.find(
        (m) => lower.includes('eth') && m.shortTitle.toLowerCase().includes('eth'),
      ) ??
      context.pm.find(
        (m) =>
          (lower.includes('btc') || lower.includes('bitcoin')) &&
          m.shortTitle.toLowerCase().includes('btc'),
      ) ??
      context.pm.find((m) => lower.includes('fed') && m.shortTitle.toLowerCase().includes('fed'))

    const target = activePm ?? keywordPm ?? context.pm[0]
    if (target) {
      const price = side === 'YES' ? (target.bestAsk ?? target.yesPrice) : target.noPrice
      const cents = Math.round(price * 100)
      return {
        id: `stage-${now}`,
        type: side === 'YES' ? 'pm_paper_yes' : 'pm_paper_no',
        label: `Paper ${side} $${notionalUsd} @ ${cents}c`,
        headline: `POLYMARKET PAPER ${side} $${notionalUsd}`,
        summary: `${target.shortTitle} @ ${cents}c`,
        riskNote: 'PAPER MODE ONLY · Live CLOB · 2.0s undo safety window.',
        signalId: target.id,
        marketId: target.marketId,
        notionalUsd,
        limitPrice: price,
        source: 'voice',
      }
    }
  }

  // 7. Hyperliquid paper LONG / SHORT / HEDGE
  if (
    lower.includes('long') ||
    lower.includes('short') ||
    lower.includes('hedge') ||
    lower.includes('buy') ||
    lower.includes('sell')
  ) {
    const isShort = lower.includes('short') || lower.includes('hedge') || lower.includes('sell')
    const side = isShort ? 'SHORT' : 'LONG'
    const normalizedCoin = extractCoin(lower)

    const activeHl = context.hl.find((s) => s.id === context.activeSignalId)
    const target =
      (normalizedCoin ? context.hl.find((s) => s.coin === normalizedCoin) : undefined) ??
      activeHl ??
      context.hl[0]

    if (target) {
      const amountMatch = lower.match(/\$?\s*(\d{2,5})\b/)
      const notionalUsd = amountMatch ? Number(amountMatch[1]) : 1000
      const px =
        side === 'LONG' ? (target.bestAsk ?? target.markPx) : (target.bestBid ?? target.markPx)
      return {
        id: `stage-${now}`,
        type: side === 'LONG' ? 'hl_paper_long' : 'hl_paper_short',
        label: `Paper ${side} ${target.coin} $${notionalUsd}`,
        headline: `HYPERLIQUID PAPER ${side} ${target.coin}`,
        summary: `$${notionalUsd.toLocaleString('en-US')} notional @ $${px.toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
        riskNote: 'PAPER MODE ONLY · Zero custody · 2.0s undo safety window.',
        signalId: target.id,
        coin: target.coin,
        notionalUsd,
        limitPrice: px,
        source: 'voice',
      }
    }
  }

  // 8. Share alert to Telegram
  if (
    lower.includes('share') ||
    lower.includes('alert') ||
    lower.includes('telegram') ||
    lower.includes('post')
  ) {
    const coin = extractCoin(lower)
    const targetHl = coin
      ? context.hl.find((s) => s.coin === coin)
      : (context.hl.find((s) => s.id === context.activeSignalId) ?? context.hl[0])
    if (targetHl) {
      const text = `[PulseHUD Alert] Hyperliquid ${targetHl.coin}-PERP $${targetHl.markPx.toLocaleString('en-US')} (${targetHl.change24hPct >= 0 ? '+' : ''}${targetHl.change24hPct}% 24h | Funding ${targetHl.fundingAprPct >= 0 ? '+' : ''}${targetHl.fundingAprPct}% APR)`
      return {
        id: `stage-${now}`,
        type: 'tg_share_signal',
        label: `Share ${targetHl.coin} Alert -> TG`,
        headline: `POST ${targetHl.coin} ALERT -> TELEGRAM`,
        summary: text.slice(0, 115),
        riskNote: 'Tap arms 2.0s undo countdown before Telegram post.',
        signalId: targetHl.id,
        telegramText: text,
        source: 'voice',
      }
    }
  }

  return null
}
