import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { SttProvider } from '../../shared/types.js'
import {
  analyzePcmSpeech,
  encodePcm16ToWav,
  transcribeGlassesAudio as transcribeCloudOrBasic,
  type PcmSpeechAnalysis,
} from './intent.js'

const execFileAsync = promisify(execFile)

export interface LocalSttTranscriptionResult {
  transcript: string
  provider: SttProvider
  notice: string
  vad: PcmSpeechAnalysis
}

export interface LocalSttOptions {
  /** Optional injectable runner for deterministic unit/eval testing or custom local ASR backends. */
  localRunner?: (wav: Buffer) => Promise<string>
  /** Optional override for local Whisper HTTP endpoint (defaults to process.env.LOCAL_STT_URL). */
  localHttpUrl?: string
  /** Optional override for local whisper binary (defaults to auto-detected whisper-cli / whisper). */
  whisperBin?: string | null
  /** Optional override for local ggml model file path. */
  whisperModel?: string | null
}

const WHISPER_BIN_CANDIDATES = [
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cpp',
  '/usr/local/bin/whisper-cpp',
  '/opt/homebrew/bin/whisper',
  '/usr/local/bin/whisper',
]

const WHISPER_MODEL_CANDIDATES = [
  join(homedir(), '.cache', 'whisper', 'ggml-tiny.en.bin'),
  join(homedir(), '.cache', 'whisper', 'ggml-base.en.bin'),
  '/opt/homebrew/share/whisper-cpp/ggml-tiny.en.bin',
  '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin',
]

export function detectLocalWhisperBinary(): string | null {
  const envBin = process.env.LOCAL_WHISPER_BIN?.trim()
  if (envBin && existsSync(envBin)) return envBin
  for (const candidate of WHISPER_BIN_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function detectLocalWhisperModel(): string | null {
  const envModel = process.env.LOCAL_WHISPER_MODEL?.trim()
  if (envModel && existsSync(envModel)) return envModel
  for (const candidate of WHISPER_MODEL_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Node runtime STT provider detection (never bundled into client WebView).
 * Priority: OpenAI Whisper -> Deepgram -> Zero-Key Local HTTP STT -> Zero-Key Local Whisper CLI -> Local Command/Web Speech.
 */
export function detectRuntimeSttProvider(): SttProvider {
  if (process.env.OPENAI_API_KEY?.trim()) return 'openai_whisper'
  if (process.env.DEEPGRAM_API_KEY?.trim()) return 'deepgram'
  if (process.env.LOCAL_STT_URL?.trim()) return 'local_http'
  if (detectLocalWhisperBinary()) return 'local_whisper'
  return 'local_command'
}

async function runWhisperCli(bin: string, wav: Buffer, modelPath: string | null): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'pulsehud-stt-'))
  const wavPath = join(tempDir, 'g2-voice.wav')
  try {
    await writeFile(wavPath, wav)
    const isCpp = bin.includes('whisper-cli') || bin.includes('whisper-cpp')
    const args: string[] = []
    if (isCpp) {
      if (modelPath) args.push('-m', modelPath)
      args.push('-f', wavPath, '-l', 'en', '-nt', '-np')
    } else {
      args.push(wavPath, '--language', 'en', '--model', 'tiny.en', '--output_format', 'txt', '--output_dir', tempDir)
    }

    const { stdout } = await execFileAsync(bin, args, {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    })

    const cleaned = stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^\[[0-9:.\s\->]+\]\s*/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('whisper_'))
      .join(' ')
      .trim()

    return cleaned
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function transcribeViaLocalHttp(url: string, wav: Buffer): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'g2-voice.wav')
  form.append('model', 'whisper-tiny.en')
  form.append('language', 'en')

  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`Local STT HTTP ${res.status}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const json = (await res.json()) as {
      text?: string
      transcript?: string
      results?: Array<{ transcript?: string }>
    }
    return (json.text ?? json.transcript ?? json.results?.[0]?.transcript ?? '').trim()
  }
  return (await res.text()).trim()
}

/**
 * Full Node-side G2 16 kHz s16le mono PCM transcription pipeline with zero-key local STT fallback.
 *   1. Local PCM VAD gate rejects pure silence / accidental holds (0 false executions).
 *   2. Cloud STT if OPENAI_API_KEY or DEEPGRAM_API_KEY is configured.
 *   3. Zero-key local STT runner / LOCAL_STT_URL (whisper.cpp server) / local whisper-cli binary.
 *   4. Graceful zero-key fallback notice directing to Companion Web Speech / Voice Bar (never throws).
 */
export async function transcribeGlassesAudioWithFallback(
  pcm: Uint8Array,
  options: LocalSttOptions = {},
): Promise<LocalSttTranscriptionResult> {
  const vad = analyzePcmSpeech(pcm, 16000)
  if (!vad.hasSpeech) {
    return {
      transcript: '',
      provider: detectRuntimeSttProvider(),
      notice:
        'No speech detected in G2 PCM capture (silence/noise gated — 0 writes). Hold & speak clearly, or use Companion Voice Bar.',
      vad,
    }
  }

  // Cloud providers take precedence only when explicitly configured by user
  if (
    !options.localRunner &&
    (process.env.OPENAI_API_KEY?.trim() || process.env.DEEPGRAM_API_KEY?.trim())
  ) {
    return transcribeCloudOrBasic(pcm)
  }

  const wav = encodePcm16ToWav(pcm, 16000)

  // 1. Injectable / custom local STT runner (e.g. ONNX Whisper-tiny or deterministic eval fixture)
  if (options.localRunner) {
    const transcript = (await options.localRunner(wav)).trim()
    return {
      transcript,
      provider: 'local_whisper',
      notice: transcript
        ? 'Transcribed locally via zero-key Whisper fallback (16 kHz G2 PCM).'
        : 'Zero-key local STT heard no actionable words — try again or use Voice Bar.',
      vad,
    }
  }

  // 2. Zero-key local OpenAI/whisper.cpp HTTP server (LOCAL_STT_URL)
  const localHttpUrl = (options.localHttpUrl ?? process.env.LOCAL_STT_URL)?.trim()
  if (localHttpUrl) {
    try {
      const transcript = await transcribeViaLocalHttp(localHttpUrl, wav)
      return {
        transcript,
        provider: 'local_http',
        notice: transcript
          ? 'Transcribed via zero-key local STT HTTP endpoint (16 kHz G2 PCM).'
          : 'Local STT endpoint returned empty transcript — speak closer to G2 mics.',
        vad,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'local STT unreachable'
      return {
        transcript: '',
        provider: 'local_command',
        notice: `Local STT endpoint unavailable (${msg}); fell back to zero-key Web Speech / Voice Bar.`,
        vad,
      }
    }
  }

  // 3. Zero-key local whisper-cli / whisper binary auto-detection
  const whisperBin =
    options.whisperBin !== undefined ? options.whisperBin : detectLocalWhisperBinary()
  if (whisperBin) {
    const modelPath =
      options.whisperModel !== undefined ? options.whisperModel : detectLocalWhisperModel()
    try {
      const transcript = await runWhisperCli(whisperBin, wav, modelPath)
      return {
        transcript,
        provider: 'local_whisper',
        notice: transcript
          ? 'Transcribed locally via zero-key Whisper CLI (16 kHz G2 PCM).'
          : 'Local Whisper CLI returned empty transcript — try again or use Voice Bar.',
        vad,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'whisper-cli error'
      return {
        transcript: '',
        provider: 'local_command',
        notice: `Local Whisper CLI fallback skipped (${msg}); use Browser Web Speech or Companion Voice Bar.`,
        vad,
      }
    }
  }

  // 4. Graceful zero-key fallback (PCM validated & WAV-encoded, zero keys needed)
  return {
    transcript: '',
    provider: 'local_command',
    notice: `Captured ${(vad.durationMs / 1000).toFixed(1)}s voiced 16 kHz PCM (RMS ${Math.round(vad.rms * 100)}%). Zero-key local STT ready via whisper-cli, LOCAL_STT_URL, or Companion Web Speech.`,
    vad,
  }
}
