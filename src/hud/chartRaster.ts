import type {
  HyperliquidPerpSignal,
  PaperPosition,
  PolymarketOddsSignal,
  WatchedWalletPosition,
  WatchedWalletSnapshot,
} from '../../shared/types.js'

/**
 * Even G2 ImageContainerProperty firmware limits:
 *   width: 20..288 px
 *   height: 20..144 px
 *   color depth: 4-bit monochrome green (0 = transparent waveguide black, 1..15 = luminance)
 *
 * We compose full-width 552px charts into a Gray8 buffer quantized to exact 4-bit steps
 * (level * 17) and slice seamlessly into two 276px SDK-compliant image tiles so every
 * container obeys hardware bounds with zero borders and >75% transparent waveguide optics.
 */

export interface RenderedImageSlot {
  containerID: number
  containerName: string
  xPosition: number
  yPosition: number
  width: number
  height: number
  /** Exact width*height Gray8 pixels (0 = black/transparent, 17..255 = 4-bit green levels). */
  pixels: Uint8Array
  /** Standard RFC-2083 8-bit grayscale PNG bytes ready for Even SDK updateImageRawData. */
  pngBytes: Uint8Array
  /** Cache key so unchanged images skip redundant BLE/IPC transfers. */
  fingerprint: string
}

// Compact 3x5 bitmap pixel glyphs for crisp chart axis labels inside image buffers
const MINI_FONT: Record<string, readonly string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['000', '000', '000', '000', '010'],
  ':': ['000', '010', '000', '010', '000'],
  '-': ['000', '000', '111', '000', '000'],
  '+': ['000', '010', '111', '010', '000'],
  '%': ['101', '001', '010', '100', '101'],
  '$': ['111', '110', '111', '011', '111'],
  '>': ['100', '010', '001', '010', '100'],
  ' ': ['000', '000', '000', '000', '000'],
  A: ['010', '101', '111', '101', '101'],
  B: ['110', '101', '110', '101', '110'],
  C: ['111', '100', '100', '100', '111'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  F: ['111', '100', '110', '100', '100'],
  G: ['111', '100', '101', '101', '111'],
  H: ['101', '101', '111', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['111', '101', '101', '101', '101'],
  O: ['111', '101', '101', '101', '111'],
  P: ['111', '101', '111', '100', '100'],
  Q: ['111', '101', '101', '111', '001'],
  R: ['110', '101', '110', '101', '101'],
  S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  V: ['101', '101', '101', '101', '010'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  c: ['000', '111', '100', '100', '111'],
  k: ['100', '101', '110', '101', '101'],
  m: ['000', '111', '111', '101', '101'],
  s: ['000', '111', '110', '011', '111'],
}

export class Gray4Canvas {
  public readonly width: number
  public readonly height: number
  public readonly pixels: Uint8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.pixels = new Uint8Array(width * height)
  }

  /** Sets pixel to a 4-bit Even G2 luminance level (0..15). */
  public setLevel(x: number, y: number, level: number): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return
    const clamped = Math.max(0, Math.min(15, Math.round(level)))
    const val = clamped * 17
    const idx = yi * this.width + xi
    if (val > this.pixels[idx]) {
      this.pixels[idx] = val
    }
  }

  public overwriteLevel(x: number, y: number, level: number): void {
    const xi = Math.round(x)
    const yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return
    const clamped = Math.max(0, Math.min(15, Math.round(level)))
    this.pixels[yi * this.width + xi] = clamped * 17
  }

  public fillRect(x: number, y: number, w: number, h: number, level: number): void {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.width, Math.round(x + w))
    const y1 = Math.min(this.height, Math.round(y + h))
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        this.overwriteLevel(px, py, level)
      }
    }
  }

  public strokeRect(x: number, y: number, w: number, h: number, level: number): void {
    const x0 = Math.round(x)
    const y0 = Math.round(y)
    const x1 = Math.round(x + w - 1)
    const y1 = Math.round(y + h - 1)
    for (let px = x0; px <= x1; px += 1) {
      this.setLevel(px, y0, level)
      this.setLevel(px, y1, level)
    }
    for (let py = y0; py <= y1; py += 1) {
      this.setLevel(x0, py, level)
      this.setLevel(x1, py, level)
    }
  }

  public drawLine(x0: number, y0: number, x1: number, y1: number, level: number, thick = 1): void {
    let ax = Math.round(x0)
    let ay = Math.round(y0)
    const bx = Math.round(x1)
    const by = Math.round(y1)
    const dx = Math.abs(bx - ax)
    const dy = -Math.abs(by - ay)
    const sx = ax < bx ? 1 : -1
    const sy = ay < by ? 1 : -1
    let err = dx + dy

    while (true) {
      this.setLevel(ax, ay, level)
      if (thick >= 2) {
        this.setLevel(ax, ay + 1, level)
        this.setLevel(ax + 1, ay, Math.max(1, level - 2))
      }
      if (ax === bx && ay === by) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        ax += sx
      }
      if (e2 <= dx) {
        err += dx
        ay += sy
      }
    }
  }

  public drawDashedHLine(
    xStart: number,
    xEnd: number,
    y: number,
    level: number,
    dashOn = 4,
    dashOff = 4,
  ): void {
    const period = dashOn + dashOff
    const yi = Math.round(y)
    for (let x = Math.round(xStart); x <= Math.round(xEnd); x += 1) {
      if ((x - xStart) % period < dashOn) {
        this.setLevel(x, yi, level)
      }
    }
  }

  public drawCircleDot(cx: number, cy: number, radius: number, level: number): void {
    const r2 = radius * radius
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy <= r2) {
          this.setLevel(cx + dx, cy + dy, level)
        }
      }
    }
  }

  public drawRingArc(
    cx: number,
    cy: number,
    outerR: number,
    innerR: number,
    fraction: number,
    level: number,
  ): void {
    const clamped = Math.max(0, Math.min(1, fraction))
    const maxAngle = clamped * Math.PI * 2
    const outer2 = outerR * outerR
    const inner2 = innerR * innerR

    for (let py = Math.floor(cy - outerR - 1); py <= Math.ceil(cy + outerR + 1); py += 1) {
      for (let px = Math.floor(cx - outerR - 1); px <= Math.ceil(cx + outerR + 1); px += 1) {
        const dx = px - cx
        const dy = py - cy
        const d2 = dx * dx + dy * dy
        if (d2 > outer2 || d2 < inner2) continue
        // Clockwise from 12 o'clock (-PI/2)
        let angle = Math.atan2(dy, dx) + Math.PI / 2
        if (angle < 0) angle += Math.PI * 2
        if (angle <= maxAngle + 0.001) {
          this.setLevel(px, py, level)
        }
      }
    }
  }

  public drawMiniText(x: number, y: number, text: string, level: number, scale = 1): void {
    let cursorX = Math.round(x)
    const startY = Math.round(y)
    for (const ch of text) {
      const glyph = MINI_FONT[ch] ?? MINI_FONT[ch.toUpperCase()] ?? MINI_FONT[' ']
      for (let row = 0; row < glyph.length; row += 1) {
        const line = glyph[row]
        for (let col = 0; col < line.length; col += 1) {
          if (line[col] === '1') {
            if (scale === 1) {
              this.setLevel(cursorX + col, startY + row, level)
            } else {
              this.fillRect(cursorX + col * scale, startY + row * scale, scale, scale, level)
            }
          }
        }
      }
      cursorX += 4 * scale
    }
  }

  public sliceRect(x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h)
    for (let row = 0; row < h; row += 1) {
      const srcOffset = (y + row) * this.width + x
      out.set(this.pixels.subarray(srcOffset, srcOffset + w), row * w)
    }
    return out
  }
}

// Pure-TS IEEE CRC-32 + Adler-32 + RFC-2083 8-bit Grayscale PNG encoder (browser & Node safe)
const PNG_CRC_TABLE = (() => {
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

function pngCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    c = PNG_CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let a = 1
  let b = 0
  const mod = 65521
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]) % mod
    b = (b + a) % mod
  }
  return ((b << 16) | a) >>> 0
}

function writeU32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff
  buf[offset + 1] = (value >>> 16) & 0xff
  buf[offset + 2] = (value >>> 8) & 0xff
  buf[offset + 3] = value & 0xff
}

function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  writeU32BE(out, 0, data.length)
  out[4] = type.charCodeAt(0)
  out[5] = type.charCodeAt(1)
  out[6] = type.charCodeAt(2)
  out[7] = type.charCodeAt(3)
  out.set(data, 8)
  const crc = pngCrc32(out.subarray(4, 8 + data.length))
  writeU32BE(out, 8 + data.length, crc)
  return out
}

function zlibStore(raw: Uint8Array): Uint8Array {
  const maxBlock = 65535
  const blockCount = Math.max(1, Math.ceil(raw.length / maxBlock))
  const out = new Uint8Array(2 + raw.length + blockCount * 5 + 4)
  // Standard zlib header (CMF=0x78 deflate 32K window, FLG=0x01 FCHECK)
  out[0] = 0x78
  out[1] = 0x01

  let srcPos = 0
  let dstPos = 2
  for (let b = 0; b < blockCount; b += 1) {
    const remaining = raw.length - srcPos
    const len = Math.min(maxBlock, remaining)
    const isFinal = b === blockCount - 1 ? 1 : 0
    out[dstPos++] = isFinal
    out[dstPos++] = len & 0xff
    out[dstPos++] = (len >>> 8) & 0xff
    const nlen = ~len & 0xffff
    out[dstPos++] = nlen & 0xff
    out[dstPos++] = (nlen >>> 8) & 0xff
    out.set(raw.subarray(srcPos, srcPos + len), dstPos)
    srcPos += len
    dstPos += len
  }

  writeU32BE(out, dstPos, adler32(raw))
  return out
}

/**
 * Encodes a Gray8 pixel buffer (width * height bytes) into a standard 8-bit grayscale PNG
 * (colorType = 0, bitDepth = 8) accepted by Even Hub SDK updateImageRawData and browsers.
 */
export function encodeGray8ToPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const scanlineStride = width + 1
  const raw = new Uint8Array(scanlineStride * height)
  for (let y = 0; y < height; y += 1) {
    const dst = y * scanlineStride
    raw[dst] = 0 // Filter type 0 (None)
    raw.set(pixels.subarray(y * width, (y + 1) * width), dst + 1)
  }

  const ihdr = new Uint8Array(13)
  writeU32BE(ihdr, 0, width)
  writeU32BE(ihdr, 4, height)
  ihdr[8] = 8 // 8-bit depth
  ihdr[9] = 0 // Grayscale
  ihdr[10] = 0 // Compression
  ihdr[11] = 0 // Filter
  ihdr[12] = 0 // Non-interlaced

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdrChunk = buildPngChunk('IHDR', ihdr)
  const idatChunk = buildPngChunk('IDAT', zlibStore(raw))
  const iendChunk = buildPngChunk('IEND', new Uint8Array(0))

  const png = new Uint8Array(sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length)
  let offset = 0
  png.set(sig, offset)
  offset += sig.length
  png.set(ihdrChunk, offset)
  offset += ihdrChunk.length
  png.set(idatChunk, offset)
  offset += idatChunk.length
  png.set(iendChunk, offset)
  return png
}

function formatAxisPrice(px: number): string {
  if (px >= 10000) return `${(px / 1000).toFixed(1)}k`
  if (px >= 100) return `${Math.round(px)}`
  if (px >= 10) return px.toFixed(1)
  return px.toFixed(2)
}

function sliceToDualTiles(
  canvas: Gray4Canvas,
  xLeft: number,
  yTop: number,
  fingerprint: string,
): RenderedImageSlot[] {
  const tileW = Math.floor(canvas.width / 2)
  const tileH = canvas.height
  const leftPixels = canvas.sliceRect(0, 0, tileW, tileH)
  const rightPixels = canvas.sliceRect(tileW, 0, tileW, tileH)

  return [
    {
      containerID: 5,
      containerName: 'chartL',
      xPosition: xLeft,
      yPosition: yTop,
      width: tileW,
      height: tileH,
      pixels: leftPixels,
      pngBytes: encodeGray8ToPng(leftPixels, tileW, tileH),
      fingerprint: `${fingerprint}:L`,
    },
    {
      containerID: 6,
      containerName: 'chartR',
      xPosition: xLeft + tileW,
      yPosition: yTop,
      width: tileW,
      height: tileH,
      pixels: rightPixels,
      pngBytes: encodeGray8ToPng(rightPixels, tileW, tileH),
      fingerprint: `${fingerprint}:R`,
    },
  ]
}

/**
 * Renders borderless 15m Hyperliquid OHLC candlesticks + volume/funding histogram ticks
 * + optional Entry / Break-Even Stop / Liquidation reference lines into two seamless
 * 276x72 (552x72 total) 4-bit monochrome G2 image tiles.
 */
export function renderHyperliquidCandlesTiles(
  signal: HyperliquidPerpSignal,
  watchedPos?: WatchedWalletPosition,
  paperPos?: PaperPosition,
): RenderedImageSlot[] {
  const totalW = 552
  const totalH = 68
  const canvas = new Gray4Canvas(totalW, totalH)

  const candles = signal.candles15m.slice(-24)
  if (candles.length === 0) {
    canvas.drawMiniText(8, 30, 'SYNCING 15M CANDLES', 8, 1)
    return sliceToDualTiles(canvas, 12, 128, `hl-empty:${signal.coin}`)
  }

  let minPx = Infinity
  let maxPx = -Infinity
  let maxVol = 0
  for (const c of candles) {
    if (c.l < minPx) minPx = c.l
    if (c.h > maxPx) maxPx = c.h
    if (c.v > maxVol) maxVol = c.v
  }

  // Include paper/watched entry if reasonably close to chart range so lines remain readable
  const refEntry = paperPos?.entryPrice ?? watchedPos?.entryPx ?? null
  const refLiq = watchedPos?.liquidationPx ?? null
  const baseSpan = Math.max(maxPx - minPx, signal.markPx * 0.002)
  if (refEntry && Math.abs(refEntry - signal.markPx) <= baseSpan * 1.4) {
    minPx = Math.min(minPx, refEntry)
    maxPx = Math.max(maxPx, refEntry)
  }
  if (refLiq && Math.abs(refLiq - signal.markPx) <= baseSpan * 1.6) {
    minPx = Math.min(minPx, refLiq)
    maxPx = Math.max(maxPx, refLiq)
  }

  const pad = Math.max((maxPx - minPx) * 0.12, signal.markPx * 0.0005)
  const scaleMin = minPx - pad
  const scaleMax = maxPx + pad
  const span = Math.max(1e-6, scaleMax - scaleMin)

  const chartLeft = 48
  const chartRight = totalW - 14
  const chartTop = 5
  const chartBottom = 53
  const chartH = chartBottom - chartTop

  const toY = (px: number) =>
    Math.max(chartTop, Math.min(chartBottom, Math.round(chartBottom - ((px - scaleMin) / span) * chartH)))

  // Ultra-subtle borderless axis guides (transparent waveguide background stays >75% black)
  canvas.drawDashedHLine(chartLeft, chartRight, chartTop, 2, 2, 6)
  canvas.drawDashedHLine(chartLeft, chartRight, Math.round((chartTop + chartBottom) / 2), 2, 2, 8)
  canvas.drawDashedHLine(chartLeft, chartRight, chartBottom, 2, 2, 6)

  // Left-side compact price axis & timeframe markers
  canvas.drawMiniText(2, 3, formatAxisPrice(maxPx), 8, 1)
  canvas.drawMiniText(2, 27, '15m', 6, 1)
  canvas.drawMiniText(2, 49, formatAxisPrice(minPx), 8, 1)

  // Optional Entry / Break-Even Stop dashed line
  if (refEntry && refEntry >= scaleMin && refEntry <= scaleMax) {
    const ey = toY(refEntry)
    canvas.drawDashedHLine(chartLeft, chartRight, ey, 7, 5, 4)
    canvas.drawMiniText(chartLeft + 2, Math.max(2, ey - 7), paperPos?.stopLossMode === 'breakeven' ? 'BE' : 'ENT', 9, 1)
  }

  // Optional Liquidation warning dotted line
  if (refLiq && refLiq >= scaleMin && refLiq <= scaleMax) {
    const ly = toY(refLiq)
    canvas.drawDashedHLine(chartLeft, chartRight, ly, 13, 2, 2)
    canvas.drawMiniText(chartRight - 14, Math.max(2, ly - 7), 'LIQ', 14, 1)
  }

  // Draw crisp 15m OHLC candlesticks + subtle bottom volume intensity ticks
  const usableW = chartRight - chartLeft - 6
  const stepX = usableW / Math.max(1, candles.length)
  const bodyW = Math.max(5, Math.min(13, Math.floor(stepX * 0.62)))

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]
    const cx = Math.round(chartLeft + i * stepX + stepX * 0.5)
    const yHigh = toY(c.h)
    const yLow = toY(c.l)
    const yOpen = toY(c.o)
    const yClose = toY(c.c)
    const topBody = Math.min(yOpen, yClose)
    const botBody = Math.max(yOpen, yClose)
    const bodyH = Math.max(2, botBody - topBody + 1)
    const isBull = c.c >= c.o

    // Wick
    canvas.drawLine(cx, yHigh, cx, yLow, isBull ? 12 : 9, 1)

    // Candle body: Bull = bright hollow outline (15); Bear = solid shaded block (9)
    const bx = Math.round(cx - bodyW / 2)
    if (isBull) {
      canvas.fillRect(bx, topBody, bodyW, bodyH, 0)
      canvas.strokeRect(bx, topBody, bodyW, bodyH, 15)
    } else {
      canvas.fillRect(bx, topBody, bodyW, bodyH, 9)
      canvas.strokeRect(bx, topBody, bodyW, bodyH, 11)
    }

    // Bottom volume / activity bar (rows 60..70)
    if (maxVol > 0) {
      const volH = Math.max(1, Math.round((c.v / maxVol) * 10))
      canvas.fillRect(cx - 2, totalH - 1 - volH, 4, volH, isBull ? 6 : 4)
    }
  }

  // Live mark price indicator dot on the right edge
  const markY = toY(signal.markPx)
  canvas.drawCircleDot(chartRight + 4, markY, 3, 15)

  const lastCandle = candles[candles.length - 1]
  const fp = `hl:${signal.coin}:${signal.markPx.toFixed(2)}:${lastCandle.t}:${lastCandle.c}:${refEntry ?? 0}:${refLiq ?? 0}:${paperPos?.stopLossMode ?? ''}`
  return sliceToDualTiles(canvas, 12, 128, fp)
}

/**
 * Renders a borderless 24h Polymarket probability trajectory sparkline (0c..100c)
 * with subtle 50c reference line and live CLOB midpoint marker.
 */
export function renderPolymarketSparklineTiles(signal: PolymarketOddsSignal): RenderedImageSlot[] {
  const totalW = 552
  const totalH = 68
  const canvas = new Gray4Canvas(totalW, totalH)

  const pts = signal.sparkline24h.length >= 2 ? signal.sparkline24h : [signal.yesPrice, signal.yesPrice]
  let minP = Math.min(...pts, 0.5)
  let maxP = Math.max(...pts, 0.5)
  const pad = Math.max(0.06, (maxP - minP) * 0.18)
  minP = Math.max(0, minP - pad)
  maxP = Math.min(1, maxP + pad)
  const span = Math.max(0.05, maxP - minP)

  const chartLeft = 44
  const chartRight = totalW - 18
  const chartTop = 6
  const chartBottom = 54
  const chartH = chartBottom - chartTop

  const toY = (p: number) =>
    Math.max(chartTop, Math.min(chartBottom, Math.round(chartBottom - ((p - minP) / span) * chartH)))

  // Axis labels + 50c dotted line
  canvas.drawMiniText(2, 5, `${Math.round(maxP * 100)}c`, 8, 1)
  canvas.drawMiniText(2, 50, `${Math.round(minP * 100)}c`, 8, 1)

  const y50 = toY(0.5)
  canvas.drawDashedHLine(chartLeft, chartRight, y50, 4, 3, 5)
  canvas.drawMiniText(2, Math.max(15, Math.min(41, y50 - 2)), '50c', 6, 1)

  const usableW = chartRight - chartLeft
  const stepX = usableW / Math.max(1, pts.length - 1)

  let prevX = chartLeft
  let prevY = toY(pts[0])
  for (let i = 1; i < pts.length; i += 1) {
    const nx = Math.round(chartLeft + i * stepX)
    const ny = toY(pts[i])
    canvas.drawLine(prevX, prevY, nx, ny, 14, 2)
    // Subtle stippled vertical drop under curve for depth without filling waveguide
    for (let sy = ny + 4; sy <= chartBottom; sy += 6) {
      canvas.setLevel(nx, sy, 3)
    }
    prevX = nx
    prevY = ny
  }

  // Current live CLOB midpoint highlight dot
  canvas.drawCircleDot(prevX, prevY, 3, 15)
  canvas.drawMiniText(chartRight - 28, 60, '24H CLOB', 6, 1)

  const fp = `pm:${signal.marketId}:${signal.yesPrice.toFixed(4)}:${pts.length}`
  return sliceToDualTiles(canvas, 12, 128, fp)
}

/**
 * Renders a 76x76 4-bit monochrome Armed Countdown Ring for the 2.0-second Post-Tap Undo Safety Window.
 * Fits strictly inside Even G2 ImageContainerProperty bounds (20..288 x 20..144).
 */
export function renderUndoCountdownRing(
  remainingMs: number,
  totalMs: number,
  armed: boolean,
): RenderedImageSlot {
  const size = 76
  const canvas = new Gray4Canvas(size, size)
  const cx = 38
  const cy = 38

  // Subtle full background ring track
  canvas.drawRingArc(cx, cy, 34, 29, 1, armed ? 4 : 3)

  if (armed) {
    const ratio = Math.max(0, Math.min(1, remainingMs / Math.max(1, totalMs)))
    canvas.drawRingArc(cx, cy, 35, 28, ratio, 15)

    // Cardinal warning ticks
    canvas.fillRect(cx - 1, 0, 2, 4, 12)
    canvas.fillRect(cx - 1, size - 4, 2, 4, 12)
    canvas.fillRect(0, cy - 1, 4, 2, 12)
    canvas.fillRect(size - 4, cy - 1, 4, 2, 12)

    const secText = `${(Math.max(0, remainingMs) / 1000).toFixed(1)}s`
    // Centered 2x bitmap digits (each char 8px wide -> 4 chars ~30px)
    canvas.drawMiniText(cx - 15, cy - 8, secText, 15, 2)
    canvas.drawMiniText(cx - 15, cy + 8, 'UNDO', 10, 1)
  } else {
    // Standby armed-ready ring
    canvas.drawRingArc(cx, cy, 34, 30, 1, 8)
    canvas.drawMiniText(cx - 11, cy - 9, '2.0', 13, 2)
    canvas.drawMiniText(cx - 15, cy + 7, 'SAFE', 8, 1)
  }

  const bucket = armed ? Math.ceil(remainingMs / 120) : -1
  const pngBytes = encodeGray8ToPng(canvas.pixels, size, size)
  return {
    containerID: 7,
    containerName: 'ring',
    xPosition: 488,
    yPosition: 78,
    width: size,
    height: size,
    pixels: canvas.pixels,
    pngBytes,
    fingerprint: `ring:${armed ? 1 : 0}:${bucket}`,
  }
}

/**
 * Renders a borderless 552x56 Margin Utilization & Liquidation Cushion bar graphic
 * for the live public Hyperliquid clearinghouseState Watcher screen.
 */
export function renderWalletRiskBarTiles(wallet: WatchedWalletSnapshot): RenderedImageSlot[] {
  const totalW = 552
  const totalH = 56
  const canvas = new Gray4Canvas(totalW, totalH)

  // Top bar: Margin Ratio 0..100%
  canvas.drawMiniText(2, 4, 'MARGIN', 9, 1)
  const barX = 48
  const barW = 420
  const barY = 3
  const barH = 11
  canvas.strokeRect(barX, barY, barW, barH, 6)
  const marginFill = Math.round((Math.min(100, Math.max(0, wallet.marginRatioPct)) / 100) * (barW - 4))
  if (marginFill > 0) {
    canvas.fillRect(barX + 2, barY + 2, marginFill, barH - 4, wallet.marginRatioPct >= 65 ? 15 : 11)
  }
  canvas.drawMiniText(barX + barW + 8, 5, `${wallet.marginRatioPct.toFixed(1)}%`, 13, 1)

  // Bottom horizontal mini-bars: top 3 positions liquidation cushion (closer to 0% = higher risk!)
  const topPos = wallet.positions.slice(0, 3)
  if (topPos.length === 0) {
    canvas.drawMiniText(48, 30, 'NO OPEN PERP POSITIONS', 7, 1)
  } else {
    const colW = Math.floor((totalW - 12) / topPos.length)
    for (let i = 0; i < topPos.length; i += 1) {
      const p = topPos[i]
      const x0 = 6 + i * colW
      const liqText =
        p.liqDistancePct !== null
          ? p.liqDistancePct > 99
            ? '>99%'
            : `${p.liqDistancePct.toFixed(1)}%`
          : 'SAFE'
      canvas.drawMiniText(x0, 22, `${p.coin} ${p.side === 'LONG' ? 'L' : 'S'} ${p.leverage}X`, 11, 1)
      canvas.drawMiniText(x0 + 82, 22, `LIQ ${liqText}`, p.liqDistancePct !== null && p.liqDistancePct < 10 ? 15 : 9, 1)

      const gaugeW = colW - 18
      canvas.strokeRect(x0, 33, gaugeW, 10, 5)
      // Fill represents buffer safety (capped at 50% distance = full bar)
      const safeRatio =
        p.liqDistancePct === null ? 1 : Math.min(1, Math.max(0.05, p.liqDistancePct / 50))
      const fillW = Math.max(2, Math.round(safeRatio * (gaugeW - 4)))
      canvas.fillRect(
        x0 + 2,
        35,
        fillW,
        6,
        p.liqDistancePct !== null && p.liqDistancePct < 10 ? 15 : 9,
      )
    }
  }

  const fp = `wallet:${wallet.address}:${wallet.marginRatioPct.toFixed(1)}:${wallet.positions.length}:${wallet.positions[0]?.unrealizedPnlUsd.toFixed(0) ?? 0}`
  return sliceToDualTiles(canvas, 12, 138, fp)
}
