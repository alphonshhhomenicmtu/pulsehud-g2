import { describe, expect, it } from 'vitest'
import {
  AudioEvent,
  MenuItemClickEvent,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
} from '@evenrealities/even_hub_sdk'
import { normalizeEvenHubEvent, resolveEnvelopeEventType } from '../src/hud/events.js'

describe('Even Hub protobuf-safe event routing', () => {
  it('resolves omitted zero-value CLICK_EVENT inside sysEvent', () => {
    // Protobuf omits zero-value fields, so CLICK_EVENT (0) arrives with eventType undefined
    const event = { sysEvent: new Sys_ItemEvent({ eventSource: 1 }) }
    expect(resolveEnvelopeEventType(event.sysEvent)).toBe(OsEventTypeList.CLICK_EVENT)
    expect(normalizeEvenHubEvent(event)).toEqual({ kind: 'click' })
  })

  it('never turns audio PCM frames into phantom clicks', () => {
    const event = {
      audioEvent: new AudioEvent({ audioPcm: new Uint8Array([1, 2, 3, 4]) }),
    }
    expect(normalizeEvenHubEvent(event)).toEqual({
      kind: 'audio_pcm',
      pcm: new Uint8Array([1, 2, 3, 4]),
    })
  })

  it('routes contextual menu item clicks independently of event capture containers', () => {
    const event = {
      menuItemClickEvent: new MenuItemClickEvent({ itemID: 4 }),
    }
    expect(normalizeEvenHubEvent(event)).toEqual({ kind: 'menu_item', itemID: 4 })
  })

  it('matches explicit non-zero types before CLICK_EVENT fallback', () => {
    expect(
      normalizeEvenHubEvent({
        sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.DOUBLE_CLICK_EVENT }),
      }),
    ).toEqual({ kind: 'double_click' })

    expect(
      normalizeEvenHubEvent({
        textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT }),
      }),
    ).toEqual({ kind: 'scroll_down' })

    expect(
      normalizeEvenHubEvent({
        textEvent: new Text_ItemEvent({ eventType: OsEventTypeList.SCROLL_TOP_EVENT }),
      }),
    ).toEqual({ kind: 'scroll_up' })

    expect(
      normalizeEvenHubEvent({
        sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_EVENT }),
      }),
    ).toEqual({ kind: 'long_press' })

    expect(
      normalizeEvenHubEvent({
        sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT }),
      }),
    ).toEqual({ kind: 'long_press_release' })
  })

  it('keeps FOREGROUND_ENTER and FOREGROUND_EXIT non-destructive for contextual menu overlay', () => {
    expect(
      normalizeEvenHubEvent({
        sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }),
      }),
    ).toEqual({ kind: 'foreground_change', entered: true })

    expect(
      normalizeEvenHubEvent({
        sysEvent: new Sys_ItemEvent({ eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }),
      }),
    ).toEqual({ kind: 'foreground_change', entered: false })
  })
})
