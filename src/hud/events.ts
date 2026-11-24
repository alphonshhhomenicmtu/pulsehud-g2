import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type NormalizedHudGesture =
  | { kind: 'click' }
  | { kind: 'double_click' }
  | { kind: 'scroll_up' }
  | { kind: 'scroll_down' }
  | { kind: 'long_press' }
  | { kind: 'long_press_release' }
  | { kind: 'menu_item'; itemID: number }
  | { kind: 'audio_pcm'; pcm: Uint8Array }
  | { kind: 'system_exit' }
  | { kind: 'foreground_change'; entered: boolean }
  | { kind: 'ignore' }

/**
 * Resolves the OsEventTypeList strictly inside a present envelope.
 *
 * Critical Even Hub SDK rule:
 * OsEventTypeList.CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire.
 * A single tap therefore arrives with `eventType === undefined` inside `sysEvent` or `textEvent`.
 * Resolving the default outside the envelope check would erroneously convert audio frames,
 * menu selections, and empty envelopes into phantom clicks.
 */
export function resolveEnvelopeEventType(envelope?: {
  eventType?: OsEventTypeList
}): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

/**
 * Classifies any raw EvenHubEvent into a single unambiguous HUD gesture.
 * Explicit non-zero event types are always checked before the zero-value CLICK_EVENT fallback.
 */
export function normalizeEvenHubEvent(event: EvenHubEvent): NormalizedHudGesture {
  if (event.audioEvent?.audioPcm) {
    return { kind: 'audio_pcm', pcm: event.audioEvent.audioPcm }
  }

  if (event.menuItemClickEvent?.itemID !== undefined) {
    return { kind: 'menu_item', itemID: event.menuItemClickEvent.itemID }
  }

  const sysType = resolveEnvelopeEventType(event.sysEvent)
  const textType = resolveEnvelopeEventType(event.textEvent)
  const listType = resolveEnvelopeEventType(event.listEvent)

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    return { kind: 'system_exit' }
  }

  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    return { kind: 'foreground_change', entered: true }
  }

  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    return { kind: 'foreground_change', entered: false }
  }

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    return { kind: 'double_click' }
  }

  if (
    sysType === OsEventTypeList.LONG_PRESS_EVENT ||
    textType === OsEventTypeList.LONG_PRESS_EVENT
  ) {
    return { kind: 'long_press' }
  }

  if (
    sysType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT ||
    textType === OsEventTypeList.LONG_PRESS_RELEASE_EVENT
  ) {
    return { kind: 'long_press_release' }
  }

  if (
    textType === OsEventTypeList.SCROLL_TOP_EVENT ||
    listType === OsEventTypeList.SCROLL_TOP_EVENT ||
    sysType === OsEventTypeList.SCROLL_TOP_EVENT
  ) {
    return { kind: 'scroll_up' }
  }

  if (
    textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    listType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
    sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  ) {
    return { kind: 'scroll_down' }
  }

  if (
    sysType === OsEventTypeList.CLICK_EVENT ||
    textType === OsEventTypeList.CLICK_EVENT ||
    listType === OsEventTypeList.CLICK_EVENT
  ) {
    return { kind: 'click' }
  }

  return { kind: 'ignore' }
}
