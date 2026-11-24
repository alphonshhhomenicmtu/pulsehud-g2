# Heads Up: Even Realities Hackathon — Verified Specification

**Source:** [https://dorahacks.io/hackathon/even-realities/detail](https://dorahacks.io/hackathon/even-realities/detail) & [https://hub.evenrealities.com/docs](https://hub.evenrealities.com/docs)
**Captured:** 2026-11-24

---

## 1. Hackathon Overview & Schedule

- **Event:** Heads Up: Even Realities Hackathon (Even Realities × TVM Ventures × Daos Hub)
- **Format:** 7-day virtual hackathon, open to builders worldwide; physical glasses are **not required** (official free Even Hub simulator is explicitly endorsed).
- **Build Week:** Nov 23 – Nov 29, 2026
- **Submission Deadline:** Nov 29, 2026, 23:59 GMT+4 (19:59 UTC / Nov 30, 03:59 UTC+8)
- **Judging & Finalists Announced:** Nov 30 – Dec 1, 2026
- **Demo Day:** Dec 3, 2026, 14:00–18:00 GMT+4 at Daos Hub, Dubai (remote demo supported for finalists)
- **Total Prize Pool:** $10,000 USDT on TON (paid within 7 days of Demo Day, **zero KYC**) + up to 10 pairs of Even G2 smart glasses + fast-track VC pitch to TVM Ventures & partner VCs.

### Prize Breakdown

| Prize | Cash (USDT on TON) | Hardware |
|---|---|---|
| Grand Prize | $2,000 | 2 pairs of G2 |
| 1st Place in each of 4 tracks | $1,250 | 1–2 pairs of G2 |
| 2nd Place in each of 4 tracks | $375 | — |
| Special Prize: Best Telegram Integration | $1,000 | — |
| Community Partner Award | Up to $500 | — |

*Note:* A project can win one cash prize (the highest award it places for; the next project moves up). A project bridging multiple tracks (e.g., Crypto & DeFi + Telegram) can enter up to **2 tracks** and is automatically eligible for the **Best Telegram Integration** special prize and the **Grand Prize**.

---

## 2. Target Tracks & Scope

### Primary Track: `02 · Crypto & DeFi`
- **Apps in scope:** Gram Wallet, **Polymarket**, **Hyperliquid**, Trust Wallet
- **Core use cases:** Check a wallet balance, live odds, or an open position; place a testnet/paper bet or order by voice and confirm with one tap.
- **Safety rule:** Demos **must** use testnet, paper trading, or read-only data. Never hold user funds. No financial advice. Never commit API keys or secrets.

### Secondary Track & Special Prize: `01 · Messaging & News` + `Best Telegram Integration`
- **Apps in scope:** **Telegram** (accounts, bots, channels, Mini Apps), Discord, Slack
- **Core use cases:** See new messages only from selected chats/channels, get short digests of followed crypto/trading communities, reply by voice, or approve a smart/AI-drafted reply with one tap.
- **Cross-track synergy explicitly called out in hackathon rules:** *"If your app genuinely connects apps from several tracks (e.g. Telegram + Hyperliquid in one flow), you can also enter a second track (up to 2)."*

---

## 3. Exact Judging Rubric (100%)

| Criterion | Weight | What Judges Look For |
|---|---:|---|
| **Usefulness on G2** | **30%** | Solves a real everyday moment, works at a glance and hands-free. |
| **Read and Write** | **25%** | **Primary judging priority.** Shows one thing that matters, then lets you act in seconds: a short voice phrase, one tap, or R1 ring confirmation with smart defaults or AI drafts instead of long dictation. |
| **Technical Execution** | **20%** | Works end to end, reliable, clean code, real API integrations. |
| **UX for Display and Voice** | **15%** | Clear on a 576 × 288 monochrome green display; natural by voice; glanceable ("one thing on screen and a few words — think 'trading session' or 'inbox in 30 seconds', not dashboards"). |
| **Business Potential & Safety** | **10%** | Real users and demand; careful with data and money (testnet/paper/read-only, zero custody, explicit human confirmation before any write action). |

---

## 4. Submission Deliverables & Rules

1. **Public GitHub/GitLab/Bitbucket repository** with a clear `README.md` explaining setup and explicitly disclosing what existed prior to Nov 23 (this project is built 100% from scratch during the hackathon).
2. **Demo video (up to 3 minutes)** running in the official Even Hub simulator (or on G2).
3. **Short project description:** problem, target user, how it works, selected track(s).
4. **Optional deliverables (high-value polish):**
   - Packaged `.ehpk` bundle (`npm run pack` via `@evenrealities/evenhub-cli`)
   - Up to 5 actionable API feature requests for the integrated ecosystems.
5. **Hard rules:**
   - Do not hold user funds; paper/testnet/read-only execution only.
   - No financial advice.
   - Never commit API keys or secrets (`.env.example` only; backend proxy handles outbound API keys and CORS).
   - Respect integrated service terms and user privacy.

---

## 5. Even Realities G2 Hardware & Even Hub SDK Constraints

Verified directly from `@evenrealities/even_hub_sdk@0.0.16`, `@evenrealities/evenhub-simulator@0.9.5`, `@evenrealities/evenhub-cli@0.2.0`, `@evenrealities/pretext@0.1.4`, and `hub.evenrealities.com/docs`.

### Hardware Specifications

| Spec | Value |
|---|---|
| Display | **576 × 288 px** per eye, dual micro-LED |
| Color Depth | Monochrome green, **4-bit greyscale** (16 levels; black `0` = transparent/off; `textColor` supports 5 brightness levels `0`–`4`) |
| Connectivity | Bluetooth LE 5.2 to phone Even Realities App WebView |
| Audio Input | 4-mic array on glasses (`16,000 Hz`, signed 16-bit LE PCM, mono; 100 ms = 3,200 bytes / 1,600 samples per `audioEvent`) |
| Inputs | Temple touchpads + optional **R1 ring** (`CLICK`, `DOUBLE_CLICK`, `SCROLL_TOP`, `SCROLL_BOTTOM`, `LONG_PRESS`, `LONG_PRESS_RELEASE`, `CONTEXT_MENU`) |
| Camera / Speaker | **None on glasses** (visual-first, quiet, private heads-up UX) |

### SDK & Display Rules (Strict Compliance)

1. **Canvas & Containers:**
   - Absolute pixel coordinates on `576 × 288`. No CSS/DOM on the glasses; companion UI renders in the phone WebView.
   - Max **4 image containers** and **8 other containers** per page.
   - **Exactly ONE** container per page must have `isEventCapture: 1`.
   - `containerName` max **16 characters**, unique per page; `containerID` unique per page.
   - No background fills — structure relies on typography, brightness (`textColor` `0`–`4`), Unicode indicators (`●`, `○`, `▸`, `━`, `─`, `▲`, `▼`), and optional borders (`borderWidth` `0`–`5`, `borderColor` `0`–`15`, `borderRadius` `0`–`10`, `paddingLength` `0`–`32`).
   - `zOrderIndex` is all-or-nothing and unique per page.
2. **Text & List Limits:**
   - `createStartUpPageContainer` / `rebuildPageContainer`: max **999 bytes** (~1,000 chars) per text container.
   - `textContainerUpgrade`: max **2,000 bytes**; flicker-free in-place updates (preferred for live data ticks; must match `containerID` + `containerName` exactly).
   - `ListContainerProperty`: max **20 items**, **63 bytes** per item label.
   - Fixed firmware LVGL line height: **27 px** (use `@evenrealities/pretext` `measureTextWrap` for pixel-accurate layout wrapping).
3. **Contextual Menu (`menuObject`):**
   - Up to **10 custom items**, `itemName` max **32 UTF-8 bytes**, `itemID` non-zero `uint32` (`>= 1`).
   - Raised via tap + long press (or simulator `context_menu` action); arrives on `event.menuItemClickEvent.itemID`.
   - Re-send `menuObject` on every `rebuildPageContainer` call to preserve items.
   - Opening/closing menu fires `FOREGROUND_ENTER_EVENT` (4) / `FOREGROUND_EXIT_EVENT` (5) — handlers must be idempotent and must NOT tear down app state on menu dismissal.
4. **Protobuf Zero-Value Input Gotcha (Critical):**
   - `OsEventTypeList.CLICK_EVENT` is `0`, which protobuf omits on the wire (`eventType` is `undefined`).
   - Resolve `envelope.eventType ?? OsEventTypeList.CLICK_EVENT` strictly **inside** a non-null envelope check (`event.sysEvent`, `event.textEvent`, `event.listEvent`).
   - Check explicit non-zero types (`DOUBLE_CLICK_EVENT`, `SCROLL_TOP_EVENT`, `SCROLL_BOTTOM_EVENT`, `LONG_PRESS`, etc.) **before** `CLICK_EVENT`.
   - Route `sysEvent`, `textEvent`, `listEvent`, `menuItemClickEvent`, and `audioEvent` independently.
5. **Exit Compliance (QA Requirement):**
   - On root pages, double-tap MUST call `bridge.shutDownPageContainer(1)` to show the native system exit-confirmation dialog. On nested detail/confirmation screens, double-tap returns cleanly to the parent HUD view.
6. **Networking & Security:**
   - WebView requests pass two gates: `app.json` `permissions` network whitelist (full origin, no wildcards) AND standard CORS headers.
   - Route external APIs (Polymarket Gamma/CLOB, Hyperliquid Info, Telegram Bot API, optional STT/LLM) through our own backend server so secrets never ship in the client bundle and CORS is cleanly controlled.

### Official Simulator Automation API (`@evenrealities/evenhub-simulator@0.9.5`)

Launched via `evenhub-simulator http://localhost:5173 --automation-port 9898`:
- `GET http://127.0.0.1:9898/api/ping` — health check (`pong`)
- `GET http://127.0.0.1:9898/api/screenshot/glasses` — raw **576 × 288** LVGL framebuffer PNG
- `GET http://127.0.0.1:9898/api/screenshot/webview` — companion WebView PNG
- `GET http://127.0.0.1:9898/api/console` — captured WebView console & error stream
- `POST http://127.0.0.1:9898/api/input` — send touchpad/ring inputs: `"up"`, `"down"`, `"click"`, `"double_click"`, `"long_press"`, `"long_press_release"`, `"context_menu"`

---

## 6. Product Design: **PulseHUD** — Glanceable DeFi & Telegram Trading Copilot for Even G2

### Value Proposition
Active crypto and prediction-market traders miss fast moves — a Hyperliquid funding flip, a Polymarket odds swing, or an urgent alpha message from their Telegram trading desk — whenever they step away from their monitors. Pulling out a phone breaks focus in meetings, while walking, or on the go.

**PulseHUD** turns Even G2 glasses into a calm, monochrome **Read-and-Write trading & Telegram desk** built around a 3-second glance-and-act loop:

1. **Glance (Read — Live Data, Zero Clutter):**
   - **Feed Card HUD** (one crisp signal per screen, never a crowded dashboard):
     - **Hyperliquid Perps** (live `api.hyperliquid.xyz/info` `metaAndAssetCtxs` + `l2Book`): live mark price, 24h move, annualized funding rate spikes, open interest, and live paper/read-only position PnL & liquidation cushion.
     - **Polymarket Odds** (live `gamma-api.polymarket.com` + `clob.polymarket.com` midpoint & L2 spread): live high-volume crypto/macro YES/NO odds, 24h shift, orderbook spread, and paper bet PnL.
     - **Telegram Desk & Alerts** (live Telegram Bot API `getUpdates` + `sendMessage` + inline callback bridge, with an instant local interactive Desk Inbox when no bot token is configured so judges can test the complete round-trip in 10 seconds): filtered messages from pinned desk chats/channels with instant smart-draft replies.
   - Graceful **Live + Verified Snapshot Fallback**: connects directly to live public Polymarket & Hyperliquid APIs on boot (and polls every 10s), automatically caching the latest verified live market frame for zero-downtime offline replay during live stage demos.

2. **Act in Seconds (Write — One Tap, Ring, or Short Voice Phrase):**
   - **Single Tap** on any live signal opens a focused **1-Tap Action / Confirm Card** with smart defaults (never typing on glasses):
     - On a **Hyperliquid** perp alert -> stage a **Paper Hedge / Limit Order** (e.g., `PAPER SHORT 0.05 BTC @ $61,580` or `TIGHTEN STOP -1.5%`) OR **Share Alert to Telegram Desk** (`POST TO TG DESK`).
     - On a **Polymarket** odds alert -> stage a **Paper YES/NO Bet** (e.g., `PAPER YES $50 @ 62c`) OR **Share Odds Call to Telegram**.
     - On a **Telegram** desk message -> cycle 3 context-aware **1-Tap Smart Replies** (e.g., `Copied - hedging 25% now`, `Holding flat, watching funding`, `Ping me if odds cross 70c`) OR hold to **Dictate Voice Reply**.
   - **Explicit Human Confirmation Gate:** Every write action enters a dedicated, high-contrast **CONFIRM CARD** (`> CONFIRM [1 TAP]` / `Swipe: Switch Option` / `Double-Tap: Cancel`) — zero accidental orders, full safety audit trail, paper-only execution ledger, and real Telegram Bot delivery when `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` are set.
   - **Push-to-Talk Voice Command (`LONG_PRESS` / `LONG_PRESS_RELEASE`):** Captures real 16 kHz s16le PCM from `bridge.audioControl(true)` (`audioEvent`), streams to our backend `/api/voice/command` (supports real OpenAI Whisper / Deepgram STT when configured, plus deterministic voice-intent parsing + simulator voice command triggers in companion UI), turning short phrases like *"Buy 50 yes Bitcoin"*, *"Short 0.05 BTC paper"*, *"Reply to desk: taking profit now"*, or *"Send BTC alert to Telegram"* directly into a 1-tap Confirmation Card!
   - **Native G2 Contextual Menu (`menuObject`):** Instant hands-free jump between `Signals Feed`, `Hyperliquid Perps`, `Polymarket Odds`, `Telegram Desk`, `Paper Ledger`, and `Broadcast Digest -> TG`.
   - **Companion WebView Control Panel (Phone / Simulator Left Pane):** Clean dark-emerald companion console showing live API connectivity status, real-time paper portfolio & PnL ledger, Telegram Bot pairing/setup + live two-way Desk chat emulator (mirrored to real Telegram when configured), live audio/voice command bar, and live mirrored glasses telemetry.
