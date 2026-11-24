# Optional Hackathon Deliverable: Concrete API & SDK Feature Requests

As requested in the DoraHacks submission guidelines (*"Optional: feature requests, up to 5 things the APIs you used were missing"*), here are five concrete developer-experience improvements surfaced while building **PulseHUD** across the **Even Hub SDK (`0.0.16`)**, **Even Hub Simulator (`0.9.5`)**, **Hyperliquid**, **Polymarket**, and **Telegram**:

1. **Even Hub SDK — Native `CLICK_EVENT` Envelope Helper (`isClickEvent` / Normalized Event API):**
   Because `OsEventTypeList.CLICK_EVENT` has protobuf ordinal `0` and zero-value fields are omitted on the wire, single taps arrive with `eventType === undefined` inside `sysEvent`/`textEvent`. Exposing a first-party `normalizeEvenHubEvent()` helper (or populating `eventType: 0` inside `evenHubEventFromJson`) would eliminate the #1 subtle input bug for new G2 developers.

2. **Even Hub Simulator — Synthetic Audio Injection Endpoint on `--automation-port`:**
   The `--automation-port` HTTP control plane (`POST /api/input`, `GET /api/screenshot/glasses`, `GET /api/console`) is outstanding for automated QA and CI. Adding a `POST /api/audio/inject` endpoint that feeds a WAV/PCM fixture into `audioEvent` would allow end-to-end automated testing of voice-driven G2 apps without physical microphones.

3. **Even Hub SDK — Optional Single-Line Right-Alignment or Two-Column Text Primitives:**
   Because the G2 LVGL font is proportional rather than monospaced, aligning a ticker on the left and a price/percentage flush-right currently requires manual pixel measurement (`@evenrealities/pretext`) and space padding or splitting into two adjacent `TextContainerProperty` boxes. A lightweight `textAlign` property (`left | center | right`) on `TextContainerProperty` would make glanceable financial and messaging cards sharper while reducing container count.

4. **Polymarket CLOB Public API — Explicit Sort-Order Guarantee & Single-Call Batch Midpoints:**
   In `GET /book?token_id=...`, `bids` and `asks` ordering requires client-side min/max scanning to guarantee top-of-book spread calculation, and hydrating multiple prediction markets requires one HTTP round-trip per token ID. A single `GET /midpoints?token_ids=...` or `GET /books` public GET endpoint with guaranteed best-level-first ordering would cut latency for wearable HUD polling by 60–70%.

5. **Telegram Bot API — Native Lightweight "Wearable Digest / Thread Preview" Filter:**
   Bots operating in high-velocity crypto group chats receive every message when privacy mode is disabled. An optional server-side keyword/mention filter or lightweight unread-summary endpoint for authorized user/bot pairs would reduce phone-battery wakeups and BLE traffic when streaming selected Telegram rooms to smart glasses.
