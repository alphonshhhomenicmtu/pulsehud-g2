import type {
  HyperliquidPerpSignal,
  PolymarketOddsSignal,
  PortfolioSnapshot,
  StagedAction,
  SttProvider,
  TelegramMessageSignal,
} from '../../shared/types.js'
import { formatDigestText } from '../telegram/bridge.js'

export interface PcmSpeechAnalysis {
  bytes: number
  durationMs: number
  rms: number
  peak: number
  voicedRatio: number
  hasSpeech: boolean
}

/**
 * Lightweight zero-dependency Voice Activity Detection (VAD) over Even G2
 * 16 kHz signed 16-bit little-endian mono PCM streams.
 * Prevents silent / accidental temple long-presses from triggering phantom intents.
 */
export function analyzePcmSpeech(pcm: Uint8Array, sampleRate = 16000): PcmSpeechAnalysis {
  const bytes = pcm.byteLength
  const sampleCount = Math.floor(bytes / 2)
  const durationMs = sampleCount > 0 ? Math.round((sampleCount / sampleRate) * 1000) : 0
  if (sampleCount === 0) {
    return { bytes, durationMs: 0, rms: 0, peak: 0, voicedRatio: 0, hasSpeech: false }
  }

  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  let sumSq = 0
  let peak = 0

  const frameSize = Math.max(1, Math.round(sampleRate * 0.02)) // 20ms VAD frames
  let totalFrames = 0
  let voicedFrames = 0

  for (let start = 0; start < sampleCount; start += frameSize) {
    const end = Math.min(sampleCount, start + frameSize)
    let frameSumSq = 0
    for (let i = start; i < end; i += 1) {
      const sample = view.getInt16(i * 2, true) / 32768
      const abs = Math.abs(sample)
      if (abs > peak) peak = abs
      const sq = sample * sample
      sumSq += sq
      frameSumSq += sq
    }
    const frameRms = Math.sqrt(frameSumSq / Math.max(1, end - start))
    totalFrames += 1
    if (frameRms >= 0.012) {
      voicedFrames += 1
    }
  }

  const rms = Math.sqrt(sumSq / sampleCount)
  const voicedRatio = totalFrames > 0 ? voicedFrames / totalFrames : 0
  const hasSpeech = durationMs >= 160 && rms >= 0.008 && voicedRatio >= 0.08

  return {
    bytes,
    durationMs,
    rms: Number(rms.toFixed(4)),
    peak: Number(peak.toFixed(4)),
    voicedRatio: Number(voicedRatio.toFixed(3)),
    hasSpeech,
  }
}

/**
 * Wraps raw Even G2 16 kHz signed 16-bit little-endian mono PCM into a standard WAV container
 * compatible with OpenAI Whisper, Deepgram, whisper.cpp, and local audio tools.
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

export function detectSttProvider(): SttProvider {
  if (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY?.trim()) return 'openai_whisper'
  if (typeof process !== 'undefined' && process.env?.DEEPGRAM_API_KEY?.trim()) return 'deepgram'
  if (typeof process !== 'undefined' && process.env?.LOCAL_STT_URL?.trim()) return 'local_http'
  if (typeof process !== 'undefined' && process.env?.LOCAL_WHISPER_BIN?.trim()) return 'local_whisper'
  return 'local_command'
}

export async function transcribeGlassesAudio(pcm: Uint8Array): Promise<{
  transcript: string
  provider: SttProvider
  notice: string
  vad: PcmSpeechAnalysis
}> {
  const vad = analyzePcmSpeech(pcm, 16000)
  if (!vad.hasSpeech) {
    return {
      transcript: '',
      provider: detectSttProvider(),
      notice:
        'No speech detected in G2 PCM capture (silence/noise gated — 0 writes). Hold & speak clearly, or use Companion Voice Bar.',
      vad,
    }
  }

  const wav = encodePcm16ToWav(pcm, 16000)

  const openAiKey = typeof process !== 'undefined' ? process.env?.OPENAI_API_KEY?.trim() : undefined
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
      vad,
    }
  }

  const deepgramKey = typeof process !== 'undefined' ? process.env?.DEEPGRAM_API_KEY?.trim() : undefined
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
      vad,
    }
  }

  return {
    transcript: '',
    provider: 'local_command',
    notice: `Captured ${(vad.durationMs / 1000).toFixed(1)}s voiced 16 kHz PCM from G2 mic. Zero-key local STT ready via whisper-cli, LOCAL_STT_URL, or Companion Web Speech / Voice Bar.`,
    vad,
  }
}

function extractCoin(lower: string, hl: HyperliquidPerpSignal[] = []): string | undefined {
  const coinMatch = lower.match(/\b(btc|bitcoin|eth|ethereum|sol|solana|hype)\b/i)
  if (coinMatch) {
    const token = coinMatch[1].toLowerCase()
    if (token.startsWith('bit')) return 'BTC'
    if (token.startsWith('eth')) return 'ETH'
    if (token.startsWith('sol')) return 'SOL'
    return token.toUpperCase()
  }
  for (const sig of hl) {
    const c = sig.coin.toLowerCase()
    if (c.length >= 2 && new RegExp(`\\b${c}\\b`, 'i').test(lower)) {
      return sig.coin
    }
  }
  return undefined
}

function parseNotionalUsd(lower: string, fallback: number, minVal = 10, maxVal = 50000): number {
  // Handle k shorthand like "1k", "2.5k", "$1.5k"
  const kMatch = lower.match(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/i)
  if (kMatch) {
    const val = Math.round(Number(kMatch[1]) * 1000)
    if (Number.isFinite(val) && val >= minVal && val <= maxVal) return val
  }

  // Handle comma-formatted or plain numbers like "$1,000", "$2,500", "500", "75"
  const numMatch = lower.match(/\$?\s*(\d{1,3}(?:,\d{3})+|\d{2,5})\b/)
  if (numMatch) {
    const val = Number(numMatch[1].replace(/,/g, ''))
    if (Number.isFinite(val) && val >= minVal && val <= maxVal) return val
  }

  // Handle common spoken trading amounts
  if (/\btwo\s+(?:thousand\s+)?five\s+hundred\b|\btwo\s+point\s+five\s+k\b/.test(lower)) return 2500
  if (/\bone\s+thousand\b|\ba\s+grand\b/.test(lower)) return 1000
  if (/\bfive\s+hundred\b/.test(lower)) return 500
  if (/\btwo\s+(?:hundred\s+)?fifty\b/.test(lower)) return 250
  if (/\bone\s+hundred\b/.test(lower)) return 100
  if (/\bfifty\b/.test(lower)) return 50
  if (/\btwenty\s*five\b/.test(lower)) return 25

  return fallback
}

function isNegatedOrCancelledSpeech(lower: string): boolean {
  return /\b(don'?t|do not|never\s*mind|cancel(?:\s+that|\s+order|\s+it)?|abort|hold off|stop that|not now|ignore that|forget it)\b/i.test(
    lower,
  )
}

/**
 * Deterministic voice-to-StagedAction parser.
 * Every parsed intent returns a staged action on the Confirm Gate; tapping arms the 2.0s undo ring.
 * Ambient conversation, filler speech, and negated commands return null (0 false executions).
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

  // 1. Explicit Reply to Telegram desk message (allowed before negation guard so "Reply: don't hedge yet" works)
  const replyMatch = transcript.match(
    /^(?:reply|tell desk|message desk|text desk|send reply)\s*[:,-]?\s*(.+)$/i,
  )
  if (replyMatch) {
    const body = replyMatch[1].trim()
    if (!body) return null
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

  // Negation / abort safety guard — never stage trades when user says "don't short" or "cancel that"
  if (isNegatedOrCancelledSpeech(lower)) {
    return null
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
    const coin =
      extractCoin(lower, context.hl) ??
      context.portfolio.positions
        .find((p) => p.venue === 'hyperliquid')
        ?.symbol.replace('-PERP', '') ??
      'BTC'
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
    lower.includes('close 50') ||
    lower.includes('trim 50') ||
    lower.includes('trim half') ||
    lower.includes('close half') ||
    lower.includes('take half')
  ) {
    const coin =
      extractCoin(lower, context.hl) ??
      context.portfolio.positions
        .find((p) => p.venue === 'hyperliquid')
        ?.symbol.replace('-PERP', '') ??
      'BTC'
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
    lower.includes('exit position') ||
    /\bclose (?:my |top )?(?:btc|bitcoin|eth|ethereum|sol|solana|hype)\b/.test(lower)
  ) {
    const coin = extractCoin(lower, context.hl)
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

  // 6. Polymarket paper YES / NO bet (requires explicit market/bet verb or amount+side — never ambient "yes"/"no"!)
  const hasYesNoWord = /\b(yes|no)\b/.test(lower)
  const hasPolyContext =
    /\b(polymarket|poly|bet|stake|odds)\b/.test(lower) ||
    (hasYesNoWord &&
      (/\b(buy|take|stage|paper|put|pick|go)\b/.test(lower) || /\$?\d+/.test(lower)))

  if (hasPolyContext) {
    const isNo = /\bno\b/.test(lower) && !/\byes\b/.test(lower)
    const side = isNo ? 'NO' : 'YES'
    const notionalUsd = parseNotionalUsd(lower, 50, 5, 5000)

    const activePm = context.pm.find((m) => m.id === context.activeSignalId)
    const keywordPm =
      context.pm.find(
        (m) =>
          (lower.includes('eth') || lower.includes('ethereum')) &&
          m.shortTitle.toLowerCase().includes('eth'),
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

  // 7. Hyperliquid paper LONG / SHORT / HEDGE (requires trading verb + coin/amount/perp context so casual "long day" / "buy coffee" never triggers!)
  const hasPerpAction = /\b(long|short|hedge|buy|sell)\b/.test(lower)
  const normalizedCoin = extractCoin(lower, context.hl)
  const hasPerpQualifier =
    Boolean(normalizedCoin) ||
    /\b(paper|perp|position|whale|watched|market|\$\d+|\d+k)\b/.test(lower) ||
    /\b(long|short|hedge)\s+\$?\d+/.test(lower)

  if (hasPerpAction && hasPerpQualifier) {
    const isShort = /\b(short|hedge|sell)\b/.test(lower)
    const side = isShort ? 'SHORT' : 'LONG'

    const activeHl = context.hl.find((s) => s.id === context.activeSignalId)
    const target =
      (normalizedCoin ? context.hl.find((s) => s.coin === normalizedCoin) : undefined) ??
      activeHl ??
      context.hl[0]

    if (target) {
      const notionalUsd = parseNotionalUsd(lower, 1000, 10, 50000)
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

  // 8. Share alert to Telegram (explicit desk/telegram/ticker share intent only — never casual "blog post" or "stay alert")
  const hasShareVerb = /\b(share|post|send|broadcast|ping)\b/.test(lower)
  const hasShareTarget =
    /\b(telegram|desk|tg|alert|signal|funding|price)\b/.test(lower) || Boolean(normalizedCoin)

  if (hasShareVerb && hasShareTarget) {
    const targetHl = normalizedCoin
      ? context.hl.find((s) => s.coin === normalizedCoin)
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
