/**
 * Buffers 16 kHz signed 16-bit little-endian mono PCM frames from the Even G2
 * 4-microphone array (100 ms / 3,200 bytes per audioEvent) and computes a live
 * RMS energy meter for the monochrome HUD.
 */
export class GlassesAudioCapture {
  private chunks: Uint8Array[] = []
  private totalBytes = 0
  private active = false
  private startedAt = 0
  private lastLevel = 0
  private readonly maxBytes = 16000 * 2 * 12 // 12 seconds safety ceiling

  public start(): void {
    this.chunks = []
    this.totalBytes = 0
    this.active = true
    this.startedAt = Date.now()
    this.lastLevel = 0.15
  }

  public isActive(): boolean {
    return this.active
  }

  public pushPcm(frame: Uint8Array): { durationMs: number; level: number } {
    if (!this.active) {
      return { durationMs: this.getDurationMs(), level: 0 }
    }
    if (this.totalBytes + frame.byteLength <= this.maxBytes) {
      this.chunks.push(frame)
      this.totalBytes += frame.byteLength
    }

    // Compute normalized RMS amplitude over signed 16-bit LE samples
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
    const sampleCount = Math.floor(frame.byteLength / 2)
    let sumSq = 0
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = view.getInt16(i * 2, true) / 32768
      sumSq += sample * sample
    }
    const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0
    this.lastLevel = Math.min(1, rms * 4.5)
    return { durationMs: this.getDurationMs(), level: this.lastLevel }
  }

  public getDurationMs(): number {
    if (this.totalBytes > 0) {
      return Math.round((this.totalBytes / 2 / 16000) * 1000)
    }
    return this.active ? Date.now() - this.startedAt : 0
  }

  public getLevel(): number {
    return this.lastLevel
  }

  public stopAndEncodeBase64(): { base64: string; bytes: number; durationMs: number } {
    this.active = false
    const merged = new Uint8Array(this.totalBytes)
    let offset = 0
    for (const chunk of this.chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const durationMs = this.getDurationMs()
    const bytes = merged.byteLength
    this.chunks = []
    this.totalBytes = 0
    this.lastLevel = 0

    let binary = ''
    const step = 0x8000
    for (let i = 0; i < merged.length; i += step) {
      binary += String.fromCharCode(...merged.subarray(i, i + step))
    }
    return {
      base64: bytes > 0 ? btoa(binary) : '',
      bytes,
      durationMs,
    }
  }
}

export function renderVoiceMeter(level: number, tick: number): string {
  const glyphs = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  const bars: string[] = []
  for (let i = 0; i < 8; i += 1) {
    const wave = 0.5 + 0.5 * Math.sin(tick * 0.9 + i * 0.85)
    const amplitude = Math.max(0.08, Math.min(1, level * 0.75 + wave * 0.35))
    const idx = Math.min(glyphs.length - 1, Math.floor(amplitude * glyphs.length))
    bars.push(glyphs[idx])
  }
  return bars.join('')
}
