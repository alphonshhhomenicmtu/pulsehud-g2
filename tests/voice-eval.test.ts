import { describe, expect, it } from 'vitest'
import { PaperLedger } from '../server/engine/paperLedger.js'
import {
  createFallbackHyperliquidSignals,
  createFallbackPolymarketSignals,
} from '../server/feeds/fallbackSnapshot.js'
import { TelegramBridge } from '../server/telegram/bridge.js'
import { analyzePcmSpeech, encodePcm16ToWav, parseVoiceIntent } from '../server/voice/intent.js'
import {
  detectRuntimeSttProvider,
  transcribeGlassesAudioWithFallback,
} from '../server/voice/localStt.js'
import type { ActionType } from '../shared/types.js'

function createEvalContext() {
  const hl = createFallbackHyperliquidSignals(1_764_000_000_000)
  const pm = createFallbackPolymarketSignals(1_764_000_000_000)
  const ledger = new PaperLedger()
  ledger.seedIfEmpty(hl, pm)
  const tg = new TelegramBridge({ botToken: '', chatId: '' })
  tg.seedDeskMessages(hl, pm)
  return {
    hl,
    pm,
    tg: tg.getMessages(),
    portfolio: ledger.snapshot(),
  }
}

function makeSinePcm16(durationMs: number, amplitude = 0.25, freqHz = 320, sampleRate = 16000): Uint8Array {
  const sampleCount = Math.round((durationMs / 1000) * sampleRate)
  const buf = new Uint8Array(sampleCount * 2)
  const view = new DataView(buf.buffer)
  for (let i = 0; i < sampleCount; i += 1) {
    const val = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(val * 32767))), true)
  }
  return buf
}

interface VoiceEvalCase {
  id: string
  phrase: string
  expectedType: ActionType | null
  expectedCoin?: string
  expectedNotionalUsd?: number
}

const VOICE_EVAL_30_CASES: readonly VoiceEvalCase[] = [
  // Hyperliquid paper short / hedge / long with numeric, comma, k-suffix, and spoken amounts (8 cases)
  { id: '01-hl-short-btc', phrase: 'Paper short 1000 BTC', expectedType: 'hl_paper_short', expectedCoin: 'BTC', expectedNotionalUsd: 1000 },
  { id: '02-hl-short-comma', phrase: 'Paper short $1,500 BTC', expectedType: 'hl_paper_short', expectedCoin: 'BTC', expectedNotionalUsd: 1500 },
  { id: '03-hl-hedge-ksuffix', phrase: 'Hedge 2.5k SOL', expectedType: 'hl_paper_short', expectedCoin: 'SOL', expectedNotionalUsd: 2500 },
  { id: '04-hl-sell-hype', phrase: 'Sell 750 HYPE', expectedType: 'hl_paper_short', expectedCoin: 'HYPE', expectedNotionalUsd: 750 },
  { id: '05-hl-long-btc', phrase: 'Paper long $1,000 BTC', expectedType: 'hl_paper_long', expectedCoin: 'BTC', expectedNotionalUsd: 1000 },
  { id: '06-hl-long-spoken-eth', phrase: 'Long five hundred Ethereum', expectedType: 'hl_paper_long', expectedCoin: 'ETH', expectedNotionalUsd: 500 },
  { id: '07-hl-buy-sol', phrase: 'Buy 1k Solana', expectedType: 'hl_paper_long', expectedCoin: 'SOL', expectedNotionalUsd: 1000 },
  { id: '08-hl-hedge-default', phrase: 'Hedge ETH perp', expectedType: 'hl_paper_short', expectedCoin: 'ETH', expectedNotionalUsd: 1000 },

  // Position risk controls: 50% partial close, break-even stop, flatten (6 cases)
  { id: '09-partial-btc', phrase: 'Take 50% BTC', expectedType: 'hl_partial_close', expectedCoin: 'BTC' },
  { id: '10-partial-eth', phrase: 'Trim half ETH position', expectedType: 'hl_partial_close', expectedCoin: 'ETH' },
  { id: '11-be-btc', phrase: 'Move BTC stop to breakeven', expectedType: 'hl_move_sl_be', expectedCoin: 'BTC' },
  { id: '12-be-sl-shorthand', phrase: 'SL to BE on SOL', expectedType: 'hl_move_sl_be', expectedCoin: 'SOL' },
  { id: '13-flatten-btc', phrase: 'Flatten BTC position', expectedType: 'hl_flatten', expectedCoin: 'BTC' },
  { id: '14-exit-top', phrase: 'Close position', expectedType: 'hl_flatten' },

  // Polymarket CLOB paper YES / NO bets (3 cases)
  { id: '15-pm-yes-btc', phrase: 'Buy 50 yes BTC', expectedType: 'pm_paper_yes', expectedNotionalUsd: 50 },
  { id: '16-pm-yes-poly', phrase: 'Bet $100 yes Polymarket', expectedType: 'pm_paper_yes', expectedNotionalUsd: 100 },
  { id: '17-pm-no-eth', phrase: 'Stake 25 no Ethereum', expectedType: 'pm_paper_no', expectedNotionalUsd: 25 },

  // Two-way Telegram Desk replies, digests, and alerts (4 cases)
  { id: '18-tg-reply', phrase: 'Reply: hedging 25% right now', expectedType: 'tg_reply' },
  { id: '19-tg-tell-desk', phrase: 'Tell desk: taking profit at mark', expectedType: 'tg_reply' },
  { id: '20-tg-digest', phrase: 'Send live digest to Telegram', expectedType: 'tg_broadcast_digest' },
  { id: '21-tg-share-eth', phrase: 'Post ETH alert to Telegram', expectedType: 'tg_share_signal' },

  // Zero-false-execution safety cases: ambient speech, false yes/no/long/post, and negations (9 cases)
  { id: '22-ambient-yes', phrase: 'Yes sounds good to me', expectedType: null },
  { id: '23-ambient-no', phrase: 'No problem see you after the meeting', expectedType: null },
  { id: '24-ambient-know', phrase: 'I know what you mean about dinner', expectedType: null },
  { id: '25-negated-short', phrase: "Don't short BTC yet", expectedType: null },
  { id: '26-negated-buy', phrase: 'Do not buy ETH right now', expectedType: null },
  { id: '27-cancel-command', phrase: 'Cancel that order never mind', expectedType: null },
  { id: '28-ambient-long-day', phrase: 'It has been a long day at the office', expectedType: null },
  { id: '29-ambient-blog-post', phrase: 'I read an interesting blog post today', expectedType: null },
  { id: '30-ambient-coffee', phrase: 'Let us grab coffee after this call', expectedType: null },
]

describe('30-Case Voice-Eval Suite (Zero False Executions + Accurate StagedAction Mapping)', () => {
  const ctx = createEvalContext()

  it('maintains an exact 30-case voice evaluation benchmark', () => {
    expect(VOICE_EVAL_30_CASES).toHaveLength(30)
  })

  for (const tc of VOICE_EVAL_30_CASES) {
    it(`[${tc.id}] "${tc.phrase}" -> ${tc.expectedType ?? 'null (0 writes)'}`, () => {
      const staged = parseVoiceIntent(tc.phrase, ctx)
      if (tc.expectedType === null) {
        expect(staged).toBeNull()
        return
      }
      expect(staged).not.toBeNull()
      expect(staged?.type).toBe(tc.expectedType)
      expect(staged?.source).toBe('voice')
      if (tc.expectedCoin) {
        expect(staged?.coin).toBe(tc.expectedCoin)
      }
      if (tc.expectedNotionalUsd !== undefined) {
        expect(staged?.notionalUsd).toBe(tc.expectedNotionalUsd)
      }
    })
  }
})

describe('Zero-Key Local STT Fallback & 16 kHz PCM VAD Gate', () => {
  const ctx = createEvalContext()

  it('rejects pure silence via PCM VAD so accidental temple holds never stage phantom commands', async () => {
    const silencePcm = new Uint8Array(16000 * 2) // 1.0s of silence
    const vad = analyzePcmSpeech(silencePcm, 16000)
    expect(vad.durationMs).toBe(1000)
    expect(vad.hasSpeech).toBe(false)

    let runnerCalled = false
    const res = await transcribeGlassesAudioWithFallback(silencePcm, {
      localRunner: async () => {
        runnerCalled = true
        return 'Paper short 1000 BTC'
      },
    })
    expect(runnerCalled).toBe(false)
    expect(res.transcript).toBe('')
    expect(res.vad.hasSpeech).toBe(false)
    expect(res.notice).toContain('No speech detected')
  })

  it('runs end-to-end zero-key local STT pipeline: 16 kHz voiced PCM -> RIFF WAV -> local Whisper -> Confirm Gate StagedAction', async () => {
    const voicedPcm = makeSinePcm16(600, 0.28, 340)
    const vad = analyzePcmSpeech(voicedPcm, 16000)
    expect(vad.hasSpeech).toBe(true)
    expect(vad.durationMs).toBe(600)

    let receivedWavHeader = ''
    const res = await transcribeGlassesAudioWithFallback(voicedPcm, {
      localRunner: async (wav) => {
        receivedWavHeader = wav.subarray(0, 4).toString('ascii') + ':' + wav.subarray(8, 12).toString('ascii')
        expect(wav.byteLength).toBe(44 + voicedPcm.byteLength)
        return 'Paper short $1,500 BTC'
      },
    })

    expect(receivedWavHeader).toBe('RIFF:WAVE')
    expect(res.provider).toBe('local_whisper')
    expect(res.transcript).toBe('Paper short $1,500 BTC')

    const staged = parseVoiceIntent(res.transcript, ctx)
    expect(staged?.type).toBe('hl_paper_short')
    expect(staged?.coin).toBe('BTC')
    expect(staged?.notionalUsd).toBe(1500)
    expect(staged?.source).toBe('voice')
  })

  it('degrades gracefully with zero API keys and no local whisper binary installed', async () => {
    const voicedPcm = makeSinePcm16(500, 0.25, 280)
    const savedOpenAi = process.env.OPENAI_API_KEY
    const savedDeepgram = process.env.DEEPGRAM_API_KEY
    const savedLocalUrl = process.env.LOCAL_STT_URL
    delete process.env.OPENAI_API_KEY
    delete process.env.DEEPGRAM_API_KEY
    delete process.env.LOCAL_STT_URL

    try {
      const res = await transcribeGlassesAudioWithFallback(voicedPcm, {
        whisperBin: null,
        localHttpUrl: '',
      })
      expect(res.provider).toBe('local_command')
      expect(res.transcript).toBe('')
      expect(res.vad.hasSpeech).toBe(true)
      expect(res.notice).toContain('Zero-key local STT ready')
      expect(['local_command', 'local_whisper', 'local_http']).toContain(detectRuntimeSttProvider())
      expect(encodePcm16ToWav(voicedPcm).subarray(0, 4).toString('ascii')).toBe('RIFF')
    } finally {
      if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi
      if (savedDeepgram !== undefined) process.env.DEEPGRAM_API_KEY = savedDeepgram
      if (savedLocalUrl !== undefined) process.env.LOCAL_STT_URL = savedLocalUrl
    }
  })
})
