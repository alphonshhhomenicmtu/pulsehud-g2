import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExecuteActionRequest, VoiceCommandResponse } from '../shared/types.js'
import { MarketHub } from './feeds/marketHub.js'
import { parseVoiceIntent } from './voice/intent.js'
import {
  detectRuntimeSttProvider,
  transcribeGlassesAudioWithFallback,
} from './voice/localStt.js'

function loadDotEnv(): void {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!(key in process.env)) {
      process.env[key] = val
    }
  }
}

loadDotEnv()

const PORT = Number(process.env.PORT ?? 8792)
const hub = new MarketHub()

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(res)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > 8 * 1024 * 1024) {
      throw new Error('Payload too large')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {} as T
  return JSON.parse(raw) as T
}

const server = createServer(async (req, res) => {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const snap = hub.getSnapshot()
      sendJson(res, 200, { ok: true, serverTime: snap.serverTime, health: snap.health })
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, hub.getSnapshot())
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(`data: ${JSON.stringify(hub.getSnapshot())}\n\n`)
      const unsubscribe = hub.subscribe((snapshot) => {
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
      })
      const keepAlive = setInterval(() => {
        res.write(': keepalive\n\n')
      }, 20_000)
      req.on('close', () => {
        clearInterval(keepAlive)
        unsubscribe()
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const snap = await hub.refresh()
      sendJson(res, 200, snap)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/mode/replay') {
      const body = await readJsonBody<{ enabled?: boolean }>(req)
      const snap = hub.setOfflineReplay(Boolean(body.enabled))
      sendJson(res, 200, snap)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/wallet/watch') {
      const body = await readJsonBody<{ address?: string; label?: string }>(req)
      if (!body?.address?.trim()) {
        sendJson(res, 400, { ok: false, error: 'Public 0x address is required' })
        return
      }
      const state = await hub.setWatchedWallet(body.address, body.label)
      sendJson(res, 200, { ok: true, state })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/actions/execute') {
      const body = await readJsonBody<ExecuteActionRequest>(req)
      if (!body?.action?.type) {
        sendJson(res, 400, { ok: false, error: 'Missing staged action payload' })
        return
      }
      const result = await hub.executeAction(body.action)
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/telegram/inbound') {
      const body = await readJsonBody<{ sender?: string; chatName?: string; text?: string }>(req)
      if (!body?.text?.trim()) {
        sendJson(res, 400, { ok: false, error: 'Message text is required' })
        return
      }
      const msg = hub.injectTelegramMessage(
        body.sender ?? 'Desk Trader',
        body.chatName ?? 'Alpha Trading Desk',
        body.text,
      )
      sendJson(res, 200, { ok: true, message: msg, state: hub.getSnapshot() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/telegram/config') {
      const body = await readJsonBody<{ botToken?: string; chatId?: string }>(req)
      const state = hub.configureTelegram(body.botToken ?? '', body.chatId ?? '')
      sendJson(res, 200, { ok: true, state })
      return
    }

    if (req.method === 'POST' && url.pathname === '/api/voice/command') {
      const body = await readJsonBody<{
        pcmBase64?: string
        transcript?: string
        activeSignalId?: string
      }>(req)

      const snap = hub.getSnapshot()
      let transcript = (body.transcript ?? '').trim()
      let provider = detectRuntimeSttProvider()
      let notice = 'Parsed spoken intent — tap arms 2.0s undo window on G2'
      let audioBytes: number | undefined
      let durationMs: number | undefined

      if (!transcript && body.pcmBase64) {
        const pcm = Uint8Array.from(Buffer.from(body.pcmBase64, 'base64'))
        audioBytes = pcm.byteLength
        durationMs = Math.round((pcm.byteLength / 2 / 16000) * 1000)
        const sttResult = await transcribeGlassesAudioWithFallback(pcm)
        transcript = sttResult.transcript
        provider = sttResult.provider
        notice = sttResult.notice
      }

      const stagedAction = transcript
        ? parseVoiceIntent(transcript, {
            hl: snap.hyperliquid,
            pm: snap.polymarket,
            tg: snap.telegram,
            portfolio: snap.portfolio,
            activeSignalId: body.activeSignalId,
          })
        : null

      if (transcript && !stagedAction) {
        notice = `Heard "${transcript}" — try "Paper short 1000 BTC", "Take 50% BTC", "Move BTC stop to breakeven", or "Reply: hedging now"`
      }

      const response: VoiceCommandResponse = {
        ok: true,
        transcript,
        provider,
        audioBytes,
        durationMs,
        stagedAction,
        notice,
      }
      sendJson(res, 200, response)
      return
    }

    sendJson(res, 404, { ok: false, error: `Route not found: ${url.pathname}` })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal server error'
    sendJson(res, 500, { ok: false, error: message })
  }
})

await hub.start()

server.listen(PORT, '127.0.0.1', () => {
  const snap = hub.getSnapshot()
  console.log(
    `[PulseHUD Server v2.2] Listening on http://127.0.0.1:${PORT} | HL=${snap.health.hyperliquid.status} (${snap.hyperliquid.length}, candles=${snap.health.hyperliquid.candlesLoaded}) | PM=${snap.health.polymarket.status} (${snap.polymarket.length}, clob=${snap.health.polymarket.clobVerified}) | WATCH=${snap.watchedWallet.status} (${snap.watchedWallet.positions.length} pos) | TG=${snap.health.telegram.mode} (${snap.telegram.length}) | STT=${snap.health.stt.provider}`,
  )
})

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    hub.stop()
    server.close(() => process.exit(0))
  })
}
