import { describe, expect, it } from 'vitest'
import { createFallbackHyperliquidSignals, createFallbackPolymarketSignals } from '../server/feeds/fallbackSnapshot.js'
import { PaperLedger } from '../server/engine/paperLedger.js'
import { TelegramBridge } from '../server/telegram/bridge.js'
import { encodePcm16ToWav, parseVoiceIntent } from '../server/voice/intent.js'

describe('Voice PCM WAV encoder & intent staging parser', () => {
  const hl = createFallbackHyperliquidSignals()
  const pm = createFallbackPolymarketSignals()
  const ledger = new PaperLedger()
  ledger.seedIfEmpty(hl, pm)
  const tg = new TelegramBridge({ botToken: '', chatId: '' })
  tg.seedDeskMessages(hl, pm)
  const ctx = {
    hl,
    pm,
    tg: tg.getMessages(),
    portfolio: ledger.snapshot(),
  }

  it('encodes 16 kHz s16le mono PCM into a valid RIFF/WAVE header', () => {
    const pcm = new Uint8Array(3200) // 100ms frame
    const wav = encodePcm16ToWav(pcm, 16000)
    expect(wav.byteLength).toBe(44 + 3200)
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(wav.readUInt32LE(24)).toBe(16000)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt16LE(34)).toBe(16)
  })

  it('stages Hyperliquid paper short from natural spoken phrase', () => {
    const staged = parseVoiceIntent('Paper short 1500 BTC', ctx)
    expect(staged).not.toBeNull()
    expect(staged?.type).toBe('hl_paper_short')
    expect(staged?.coin).toBe('BTC')
    expect(staged?.notionalUsd).toBe(1500)
    expect(staged?.source).toBe('voice')
  })

  it('stages Polymarket paper YES bet from voice phrase', () => {
    const staged = parseVoiceIntent('Buy 75 yes Bitcoin', ctx)
    expect(staged).not.toBeNull()
    expect(staged?.type).toBe('pm_paper_yes')
    expect(staged?.notionalUsd).toBe(75)
  })

  it('stages Telegram desk reply from voice phrase', () => {
    const staged = parseVoiceIntent('Reply: hedging 25% right now', ctx)
    expect(staged).not.toBeNull()
    expect(staged?.type).toBe('tg_reply')
    expect(staged?.telegramText).toBe('hedging 25% right now')
  })

  it('stages live Telegram digest broadcast', () => {
    const staged = parseVoiceIntent('Send live digest to Telegram', ctx)
    expect(staged).not.toBeNull()
    expect(staged?.type).toBe('tg_broadcast_digest')
    expect(staged?.telegramText).toContain('[PulseHUD G2 Digest]')
  })
})
