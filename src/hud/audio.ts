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
      // Copy PCM bytes so reused host audio buffers never overwrite prior frames
      this.chunks.push(frame.slice())
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
  // Uses firmware-verified Even G2 LVGL glyphs (━ / ─) with 0 missing-glyph risk
  const segments = 8
  const wave = 0.5 + 0.5 * Math.sin(tick * 0.9)
  const amplitude = Math.max(0.12, Math.min(1, level * 0.8 + wave * 0.25))
  const filled = Math.max(1, Math.min(segments, Math.round(amplitude * segments)))
  return `${'━'.repeat(filled)}${'─'.repeat(segments - filled)}`
}
