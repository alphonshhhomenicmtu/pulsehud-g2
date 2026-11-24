import type {
  ExecuteActionResponse,
  PulseStateSnapshot,
  StagedAction,
  VoiceCommandResponse,
} from '../../shared/types.js'
import { BrowserDirectEngine } from './browserDirect.js'

const API_BASE = ''

let directMode =
  import.meta.env.VITE_STATIC_PREVIEW === 'true' ||
  (typeof window !== 'undefined' && window.location.hostname.endsWith('.github.io'))

let directEngine: BrowserDirectEngine | null = null

function getDirectEngine(): BrowserDirectEngine {
  if (!directEngine) {
    directEngine = new BrowserDirectEngine()
  }
  return directEngine
}

export function isStaticBrowserMode(): boolean {
  return directMode
}

export async function fetchState(): Promise<PulseStateSnapshot> {
  if (directMode) {
    return getDirectEngine().init()
  }
  try {
    const res = await fetch(`${API_BASE}/api/state`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as PulseStateSnapshot
  } catch {
    directMode = true
    return getDirectEngine().init()
  }
}

export async function triggerRefresh(): Promise<PulseStateSnapshot> {
  if (directMode) {
    return getDirectEngine().refresh()
  }
  const res = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to refresh feeds (${res.status})`)
  return (await res.json()) as PulseStateSnapshot
}

export async function watchPublicWallet(payload: {
  address: string
  label?: string
}): Promise<{ ok: boolean; state: PulseStateSnapshot }> {
  if (directMode) {
    const state = await getDirectEngine().setWatchedWallet(payload.address, payload.label)
    return { ok: true, state }
  }
  const res = await fetch(`${API_BASE}/api/wallet/watch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = (await res.json()) as { ok?: boolean; error?: string; state?: PulseStateSnapshot }
  if (!res.ok || !json.state) {
    throw new Error(json.error ?? `Wallet watch failed (${res.status})`)
  }
  return { ok: true, state: json.state }
}

export async function executeStagedAction(action: StagedAction): Promise<ExecuteActionResponse> {
  if (directMode) {
    return getDirectEngine().executeAction(action)
  }
  const res = await fetch(`${API_BASE}/api/actions/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Action execution failed (${res.status}): ${errText}`)
  }
  return (await res.json()) as ExecuteActionResponse
}

export async function sendVoiceCommand(payload: {
  pcmBase64?: string
  transcript?: string
  activeSignalId?: string
}): Promise<VoiceCommandResponse> {
  if (directMode) {
    return getDirectEngine().processVoiceCommand(payload)
  }
  const res = await fetch(`${API_BASE}/api/voice/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Voice command failed (${res.status})`)
  return (await res.json()) as VoiceCommandResponse
}

export async function injectInboundTelegram(payload: {
  sender: string
  chatName: string
  text: string
}): Promise<{ ok: boolean; state: PulseStateSnapshot }> {
  if (directMode) {
    return getDirectEngine().injectInboundTelegram(payload)
  }
  const res = await fetch(`${API_BASE}/api/telegram/inbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Inbound Telegram message failed (${res.status})`)
  return (await res.json()) as { ok: boolean; state: PulseStateSnapshot }
}

export async function updateTelegramConfig(payload: {
  botToken: string
  chatId: string
}): Promise<{ ok: boolean; state: PulseStateSnapshot }> {
  if (directMode) {
    return { ok: true, state: getDirectEngine().getSnapshot() }
  }
  const res = await fetch(`${API_BASE}/api/telegram/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Telegram config update failed (${res.status})`)
  return (await res.json()) as { ok: boolean; state: PulseStateSnapshot }
}

export async function toggleOfflineReplay(enabled: boolean): Promise<PulseStateSnapshot> {
  if (directMode) {
    return getDirectEngine().setOfflineReplay(enabled)
  }
  const res = await fetch(`${API_BASE}/api/mode/replay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) throw new Error(`Failed to toggle replay mode (${res.status})`)
  return (await res.json()) as PulseStateSnapshot
}

export function subscribeStateStream(
  onSnapshot: (snapshot: PulseStateSnapshot) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  if (directMode) {
    onStatus?.(true)
    return getDirectEngine().subscribe(onSnapshot)
  }
  const es = new EventSource(`${API_BASE}/api/stream`)
  es.onopen = () => onStatus?.(true)
  es.onerror = () => onStatus?.(false)
  es.onmessage = (evt) => {
    try {
      const parsed = JSON.parse(evt.data) as PulseStateSnapshot
      onSnapshot(parsed)
    } catch {
      // Ignore malformed SSE frame
    }
  }
  return () => es.close()
}
