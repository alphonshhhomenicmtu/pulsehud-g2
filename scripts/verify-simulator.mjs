import { spawn } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const ROOT = process.cwd()
const SHOT_DIR = resolve(ROOT, 'docs/screenshots')
const RAW_DIR = resolve(SHOT_DIR, 'raw')
const API_URL = 'http://127.0.0.1:8792'
const WEB_URL = 'http://127.0.0.1:5178'
const SIM_URL = 'http://127.0.0.1:9898'

const children = []
const lvglMissingGlyphs = []

function spawnProc(label, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => {
    const line = d.toString().trim()
    if (line) console.log(`[${label}] ${line}`)
  })
  child.stderr.on('data', (d) => {
    const line = d.toString().trim()
    if (!line) return
    if (line.includes('glyph dsc. not found')) {
      lvglMissingGlyphs.push(line)
    }
    console.error(`[${label}:err] ${line}`)
  })
  children.push(child)
  return child
}

function cleanup() {
  for (const child of children) {
    if (!child.pid) continue
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        // already exited
      }
    }
  }
}

const hardWatchdog = setTimeout(() => {
  console.error('[verify] Hard 45s watchdog triggered — force killing all children.')
  cleanup()
  process.exit(1)
}, 45_000)

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function waitForUrl(url, checkFn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      const text = await res.text()
      if (res.ok && (!checkFn || checkFn(text))) {
        return text
      }
      lastErr = `HTTP ${res.status}: ${text.slice(0, 120)}`
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
    await sleep(350)
  }
  throw new Error(`Timed out waiting for ${url} (${lastErr})`)
}

async function simInput(action, waitMs = 600) {
  console.log(`[verify] -> input: ${action}`)
  const res = await fetch(`${SIM_URL}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
    signal: AbortSignal.timeout(6000),
  })
  if (!res.ok) {
    throw new Error(`Simulator input "${action}" failed: HTTP ${res.status} ${await res.text()}`)
  }
  await sleep(waitMs)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

function compositeRgbaPngOverDarkLens(pngBuf, bgR = 4, bgG = 10, bgB = 6) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!pngBuf.subarray(0, 8).equals(sig)) return pngBuf

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatChunks = []

  while (offset < pngBuf.length) {
    const len = pngBuf.readUInt32BE(offset)
    const type = pngBuf.subarray(offset + 4, offset + 8).toString('ascii')
    const data = pngBuf.subarray(offset + 8, offset + 8 + len)
    offset += 12 + len
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (bitDepth !== 8 || colorType !== 6 || width <= 0 || height <= 0) {
    return pngBuf
  }

  const raw = inflateSync(Buffer.concat(idatChunks))
  const bpp = 4
  const stride = width * bpp
  const recon = Buffer.alloc(height * stride)

  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    if (pa <= pb && pa <= pc) return a
    if (pb <= pc) return b
    return c
  }

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const srcStart = y * (stride + 1) + 1
    const dstStart = y * stride
    for (let x = 0; x < stride; x += 1) {
      const val = raw[srcStart + x]
      const a = x >= bpp ? recon[dstStart + x - bpp] : 0
      const b = y > 0 ? recon[dstStart - stride + x] : 0
      const c = x >= bpp && y > 0 ? recon[dstStart - stride + x - bpp] : 0
      let out = val
      if (filter === 1) out = (val + a) & 0xff
      else if (filter === 2) out = (val + b) & 0xff
      else if (filter === 3) out = (val + ((a + b) >> 1)) & 0xff
      else if (filter === 4) out = (val + paeth(a, b, c)) & 0xff
      recon[dstStart + x] = out
    }
  }

  const outRaw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    const rowOut = y * (stride + 1)
    outRaw[rowOut] = 0
    const rowIn = y * stride
    for (let x = 0; x < width; x += 1) {
      const i = rowIn + x * 4
      const o = rowOut + 1 + x * 4
      const r = recon[i]
      const g = recon[i + 1]
      const b = recon[i + 2]
      const a = recon[i + 3] / 255
      outRaw[o] = Math.round(r * a + bgR * (1 - a))
      outRaw[o + 1] = Math.round(g * a + bgG * (1 - a))
      outRaw[o + 2] = Math.round(b * a + bgB * (1 - a))
      outRaw[o + 3] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', deflateSync(outRaw, { level: 9 })),
    makeChunk('IEND', Buffer.alloc(0)),
  ])
}

async function saveShot(endpoint, filename, compositeDark = true) {
  const res = await fetch(`${SIM_URL}${endpoint}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) {
    throw new Error(`Screenshot ${endpoint} failed: HTTP ${res.status}`)
  }
  const rawBuf = Buffer.from(await res.arrayBuffer())
  if (compositeDark) {
    await writeFile(resolve(RAW_DIR, filename), rawBuf)
    const composited = compositeRgbaPngOverDarkLens(rawBuf)
    await writeFile(resolve(SHOT_DIR, filename), composited)
    console.log(`[verify] Saved ${filename} (raw ${rawBuf.byteLength}B, dark-lens ${composited.byteLength}B)`)
  } else {
    await writeFile(resolve(SHOT_DIR, filename), rawBuf)
    console.log(`[verify] Saved ${filename} (${rawBuf.byteLength}B)`)
  }
}

async function getConsoleEntries() {
  const res = await fetch(`${SIM_URL}/api/console`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) return []
  const data = await res.json()
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.entries)) return data.entries
  if (Array.isArray(data?.logs)) return data.logs
  if (Array.isArray(data?.messages)) return data.messages
  return []
}

let exitCode = 0
try {
  // Clean previous screenshots so directory only contains current verified captures
  await rm(SHOT_DIR, { recursive: true, force: true })
  await mkdir(RAW_DIR, { recursive: true })

  console.log('[verify] Starting PulseHUD backend server...')
  spawnProc('server', 'npx', ['tsx', 'server/index.ts'])
  await waitForUrl(`${API_URL}/api/health`, (txt) => txt.includes('"ok":true'), 18000)

  const initialState = await (await fetch(`${API_URL}/api/state`)).json()
  console.log('[verify] Live API initial sync:', JSON.stringify(initialState.health, null, 2))

  console.log('[verify] Starting Vite dev server...')
  spawnProc('vite', 'npx', ['vite', '--host', '127.0.0.1', '--port', '5178'])
  await waitForUrl(WEB_URL, (txt) => txt.includes('PulseHUD'), 15000)

  console.log('[verify] Launching official EvenHub Simulator v0.9.5 (--automation-port 9898)...')
  spawnProc('sim', 'npx', ['evenhub-simulator', WEB_URL, '--automation-port', '9898'])
  await waitForUrl(`${SIM_URL}/api/ping`, (txt) => txt.includes('pong'), 18000)

  const readyDeadline = Date.now() + 15000
  let readyFound = false
  let bridgeMode = 'unknown'
  while (Date.now() < readyDeadline) {
    const entries = await getConsoleEntries()
    const readyLine = entries.find((e) =>
      String(e.message ?? e.text ?? JSON.stringify(e)).includes('[PulseHUD] Ready'),
    )
    if (readyLine) {
      readyFound = true
      const raw = String(readyLine.message ?? readyLine.text ?? JSON.stringify(readyLine))
      bridgeMode = raw.includes('bridge=even-g2') ? 'even-g2' : 'standalone'
      console.log('[verify] Simulator WebView boot log:', raw)
      break
    }
    await sleep(400)
  }

  if (!readyFound) {
    throw new Error('PulseHUD did not emit Ready log inside evenhub-simulator')
  }

  await sleep(800)

  // 01: Live Hyperliquid Perp card
  await saveShot('/api/screenshot/glasses', '01-feed-hyperliquid.png')

  // 02: Swipe down -> Live Polymarket CLOB Odds card
  await simInput('down', 650)
  await saveShot('/api/screenshot/glasses', '02-feed-polymarket.png')

  // 03: Swipe down -> Telegram Desk unread alert card
  await simInput('down', 650)
  await saveShot('/api/screenshot/glasses', '03-feed-telegram.png')

  // 04: Tap -> Telegram 3 Context-Aware Smart Reply Drafts
  await simInput('click', 700)
  await saveShot('/api/screenshot/glasses', '04-actions-telegram-drafts.png')

  // 05: Tap -> Safety Confirmation Gate for Telegram Reply
  await simInput('click', 700)
  await saveShot('/api/screenshot/glasses', '05-confirm-telegram-reply.png')

  // 06: Tap -> Execute & Deliver Reply -> Toast feedback on Feed
  await simInput('click', 850)
  await saveShot('/api/screenshot/glasses', '06-executed-toast-feed.png')

  // 07: Swipe up twice back to Hyperliquid BTC-PERP -> Tap -> Write Actions
  await simInput('up', 500)
  await simInput('up', 500)
  await simInput('click', 700)
  await saveShot('/api/screenshot/glasses', '07-actions-hyperliquid-trade.png')

  // 08: Tap -> Safety Confirmation Gate for Hyperliquid Paper Short
  await simInput('click', 700)
  await saveShot('/api/screenshot/glasses', '08-confirm-hyperliquid-paper-trade.png')

  // Execute Hyperliquid Paper Short
  await simInput('click', 850)

  // 09: Open Native G2 OS Contextual Menu -> Capture menu overlay
  await simInput('context_menu', 850)
  await saveShot('/api/screenshot/glasses', '09-context-menu-overlay.png')

  // Select "Paper Portfolio" from the native OS contextual menu:
  // Simulator menu starts on item 0 ("All Signals"), so "Paper Portfolio" is 4 down presses away.
  for (let i = 0; i < 4; i += 1) {
    await simInput('down', 280)
  }
  await simInput('click', 850)
  await saveShot('/api/screenshot/glasses', '10-portfolio-ledger.png')

  // 11: Companion WebView screenshot (native macOS WKWebView capture)
  await saveShot('/api/screenshot/webview', '11-companion-webview.png', false)

  // Also test live /api/voice/command & /api/telegram/inbound endpoints end-to-end
  const voiceRes = await (
    await fetch(`${API_URL}/api/voice/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: 'Buy 50 yes BTC' }),
      signal: AbortSignal.timeout(5000),
    })
  ).json()

  const inboundTg = await (
    await fetch(`${API_URL}/api/telegram/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'Quant Desk',
        chatName: 'Alpha Trading Desk',
        text: 'ETH funding flipped negative — watching bounce.',
      }),
      signal: AbortSignal.timeout(5000),
    })
  ).json()

  const finalState = await (await fetch(`${API_URL}/api/state`, { signal: AbortSignal.timeout(5000) })).json()
  const consoleEntries = await getConsoleEntries()
  const errors = consoleEntries.filter((e) => {
    const lvl = String(e.level ?? '').toLowerCase()
    const msg = String(e.message ?? e.text ?? '')
    return lvl === 'error' || msg.includes('[uncaught]') || msg.includes('[unhandledrejection]')
  })

  const report = {
    verifiedAt: new Date().toISOString(),
    simulatorVersion: '0.9.5',
    sdkVersion: '0.0.16',
    bridgeMode,
    health: finalState.health,
    hyperliquidCount: finalState.hyperliquid.length,
    hyperliquidTop: finalState.hyperliquid[0]
      ? {
          coin: finalState.hyperliquid[0].coin,
          markPx: finalState.hyperliquid[0].markPx,
          change24hPct: finalState.hyperliquid[0].change24hPct,
          fundingAprPct: finalState.hyperliquid[0].fundingAprPct,
          spreadBps: finalState.hyperliquid[0].spreadBps,
        }
      : null,
    polymarketCount: finalState.polymarket.length,
    polymarketTop: finalState.polymarket[0]
      ? {
          shortTitle: finalState.polymarket[0].shortTitle,
          yesPrice: finalState.polymarket[0].yesPrice,
          clobMidpoint: finalState.polymarket[0].clobMidpoint,
          spreadCents: finalState.polymarket[0].spreadCents,
        }
      : null,
    voiceIntentTest: {
      transcript: voiceRes.transcript,
      stagedHeadline: voiceRes.stagedAction?.headline ?? null,
    },
    telegramInboundTest: {
      ok: inboundTg.ok,
      smartDraftCount: inboundTg.message?.smartDrafts?.length ?? 0,
    },
    executedReceipts: finalState.portfolio.receipts,
    positions: finalState.portfolio.positions,
    lvglMissingGlyphCount: lvglMissingGlyphs.length,
    consoleErrorCount: errors.length,
    consoleErrors: errors,
  }

  await writeFile(resolve(SHOT_DIR, 'verification-report.json'), JSON.stringify(report, null, 2))
  console.log('[verify] Verification Summary:', JSON.stringify(report, null, 2))

  if (bridgeMode !== 'even-g2') {
    throw new Error(`Expected bridgeMode=even-g2 inside simulator, got ${bridgeMode}`)
  }
  if (errors.length > 0) {
    throw new Error(`Found ${errors.length} console errors in simulator webview`)
  }
  if (lvglMissingGlyphs.length > 0) {
    throw new Error(`Found ${lvglMissingGlyphs.length} LVGL missing glyph warnings`)
  }
  if (finalState.portfolio.receipts.length < 2) {
    throw new Error(`Expected >= 2 confirmed write receipts, got ${finalState.portfolio.receipts.length}`)
  }

  console.log('[verify] ALL SIMULATOR CHECKS PASSED WITH ZERO ERRORS & ZERO MISSING GLYPHS!')
} catch (err) {
  console.error('[verify] FAILED:', err)
  exitCode = 1
} finally {
  clearTimeout(hardWatchdog)
  cleanup()
  process.exit(exitCode)
}
