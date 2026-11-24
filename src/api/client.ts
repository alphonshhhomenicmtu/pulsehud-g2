import type {
  ExecuteActionResponse,
  PulseStateSnapshot,
  StagedAction,
  VoiceCommandResponse,
} from '../../shared/types.js'

const API_BASE = ''

export async function fetchState(): Promise<PulseStateSnapshot> {
  const res = await fetch(`${API_BASE}/api/state`)
  if (!res.ok) throw new Error(`Failed to fetch state (${res.status})`)
  return (await res.json()) as PulseStateSnapshot
}

export async function triggerRefresh(): Promise<PulseStateSnapshot> {
  const res = await fetch(`${API_BASE}/api/refresh`, { method: 'POST' })
  if (!res.ok) throw new Error(`Failed to refresh feeds (${res.status})`)
  return (await res.json()) as PulseStateSnapshot
}

export async function executeStagedAction(action: StagedAction): Promise<ExecuteActionResponse> {
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
  const res = await fetch(`${API_BASE}/api/telegram/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`Telegram config update failed (${res.status})`)
  return (await res.json()) as { ok: boolean; state: PulseStateSnapshot }
}

export async function toggleOfflineReplay(enabled: boolean): Promise<PulseStateSnapshot> {
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
