# TapeHUD G2 — Track `03 · Exchanges & Stocks` Build Spec (<3h Sprint)

> **Event:** Heads Up: Even Realities Hackathon (DoraHacks ID `2477`, `https://dorahacks.io/hackathon/even-realities/detail`)  
> **Deadline:** **`2026-11-29 19:59 UTC`** (`2026-11-30 03:59 UTC+8`) · **Payout:** `USDT` on TON within 7 days of Dec 3 Demo Day (**Zero KYC**)  
> **Eligibility Verified (`2026-11-27 00:22 UTC+8`):** Official rules state *"Teams of 1 to 4 people... You can join one team only. A team can submit up to 2 projects."* Four teams already hold 2 live BUIDLs (`z121245017`, `samizdatproject`, `eliezercombi`, `u_e2140723d0bde2`). Our team holds `1` (`PulseHUD #51780` in `Messaging & News` + `Crypto & DeFi`), leaving **1 legal 2nd BUIDL slot** to target **Track `03 · Exchanges & Stocks` (`4800`)** — only **`15` total builds (`12` primary)** competing for **`$1,250` 1st (+ 1–2 G2 pairs)**, **`$375` 2nd**, **`$2,000` Grand Prize**, and **`$1,000` Best Telegram Integration** (1 cash prize per project).  
> **Isolation Rule:** Build in a **brand-new sibling directory & repo** (`/Users/mac/GENAI/agent-earn/dorahacks/tapehud-g2/`, e.g. GitHub `alphonshhhomenicmtu/tapehud-g2`). **DO NOT overwrite `dorahacks/even-realities/` (`PulseHUD`) or touch `makefun/`.** Disclose pre-Nov 23 open-source libraries cleanly in `README.md`.

---

## 1. Competitive Edge vs. All 15 Live `Exchanges & Stocks` Builds

Live audit of all `15` Track `4800` submissions shows `14/15` focus almost exclusively on single/multi-exchange crypto tickers or liquidation alerts (7 lack live web demos, and virtually none combine real **US equities + earnings/session risk** with **Interactive Brokers** + **all 4 crypto CEXs**). **TapeHUD G2** directly fulfills the organizers' exact Track 3 prompt (*"Follow PnL, positions and price alerts during a trading session — Confirm quick actions like 'Move $500 from spot to margin? Yes / No'"*) across **all 5 official Track 3 apps**:

1. **Multi-CEX Live Orderbook & Cross-Venue Spreads (`Binance` · `OKX` · `Bybit` · `Coinbase`):** Direct `CORS`-enabled live L2 BBO/spread comparison across `BTC`, `ETH`, `SOL` (`data-api.binance.vision`, `www.okx.com/api/v5/market`, `api.bybit.com/v5/market`, `api.exchange.coinbase.com`), flagging cross-exchange spread opportunities and margin utilization.
2. **US Equities, Pre/After-Hours & Earnings Session Tape (`Interactive Brokers` + `NVDA`, `AAPL`, `TSLA`, `SPY`, `QQQ`):** Node backend (`:8793`) proxies live Yahoo Finance (`chart/v8`) + Nasdaq (`/api/quote/.../info`) quotes & upcoming earnings/macro catalysts (`CORS`-safe via server + bundled static snapshot fallback for GitHub Pages) plus an optional **IBKR Client Portal Gateway (`localhost:5000/v1/api`)** paper-session adapter.
3. **Read-and-Write Session Actions + 2.0s Arm/Undo Ring (`25%` Judged First):** Single-tap/voice actions — **`"Move $500 spot -> margin? Yes / No"`**, **Set/Clear Price Alert (`±2%` / target price)**, **Trim 50% Winner**, **Flatten Session Hedge**, and **Push Alert -> Telegram Bot** — all paper/testnet-only (`Binance Spot Testnet`, `OKX Demo`, `IBKR Paper`, or `DEMO SESSION` book) behind a **commit-locked 2.0s Undo Countdown Ring**.
4. **Telegram Price/Earnings Alert Bridge (`$1,000` Special Prize Hook):** Optional `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (with zero-key Local Alert Desk fallback) pushes threshold triggers & session PnL digests so TapeHUD G2 stays eligible for **Best Telegram Integration** without adding a crowded track.

---

## 2. Architecture & Verified Pipeline Reuse (<3 Hours)

Reuse our verified `@evenrealities/*` toolchain (`even_hub_sdk@^0.0.16`, `pretext@^0.1.4`, `evenhub-cli@^0.2.0`, `evenhub-simulator@^0.9.5`) and proven G2 architectural invariants:

| Layer | File Targets (`dorahacks/tapehud-g2/`) | Verified Implementation Pattern |
|---|---|---|
| **G2 Layout & Optics** | `src/hud/layout.ts`, `src/hud/chartRaster.ts` | `576×288` 4-bit green waveguide (`<= 999` B text on rebuild, `textColor` `0..4`, `pretext` line wrapping, `0` scrollbars), dual `276×68` `updateImageRawData` depth/intraday candle tiles + `76×76` 2.0s Undo Ring, persistent `menuObject` (`<= 10` items). |
| **Input & Lifecycle** | `src/hud/events.ts`, `src/hud/controller.ts` | Protobuf `CLICK_EVENT` `0`-omission check strictly inside non-null envelopes (`sysEvent`/`textEvent`/`listEvent`), non-zero events checked first, `shutDownPageContainer(1)` on root double-tap, `idle -> armed -> committing -> done` state machine (`commitId` guard), idempotent `FOREGROUND_ENTER`/`EXIT`. |
| **Multi-Venue Backend** | `server/feeds/cex.ts`, `server/feeds/equities.ts`, `server/feeds/ibkr.ts`, `server/index.ts` (`:8793`) | Parallel pollers for Binance/OKX/Bybit/Coinbase (`LIVE`), Yahoo/Nasdaq US equities + earnings (`LIVE` on backend, `SNAPSHOT` on static GitHub Pages), optional IBKR Client Portal (`localhost:5000`), and paper/testnet Spot-to-Margin ledger (`DEMO` labeled, zero keys in `.ehpk`). |
| **Voice & Alerts** | `server/voice/localStt.ts`, `server/voice/intent.ts`, `src/hud/alerts.ts` | `LONG_PRESS` 16 kHz s16le PCM capture (`frame.slice()`), VAD + zero-key local Whisper CLI / `LOCAL_STT_URL` / Web Speech fallback, strict negation/abort parser (`"Move 500 spot to margin"`, `"Alert NVDA above 150"`, `"Cancel"`), proactive `▲ [ALERT]` banner (`Margin > 75%`, `CEX Spread >= 12 bps`, `Stock ±2% / Earnings < 24h`). |
| **Packaging & QA** | `app.json`, `package.json`, `scripts/verify-simulator.mjs` | `app.json` explicit origin whitelist (no wildcards; `min_app_version: "2.2.10"`, `min_sdk_version: "0.0.16"`, `supported_languages: ["en"]`), `npm run typecheck && npm test && npm run pack && npm run build:pages && npm run verify:sim` (`0` console errors, `0` LVGL missing glyphs, auto screenshots -> 1080p `<2m15s` demo video). |

---

## 3. 3-Hour Execution Runbook (Tomorrow)

1. **0:00–1:15 — Scaffold & Feeds:** Init `/Users/mac/GENAI/agent-earn/dorahacks/tapehud-g2` (`io.tapehud.eveng2`, backend `:8793`, web `:5179`). Implement `cex.ts` (Binance/OKX/Bybit/Coinbase live BBO/depth), `equities.ts` (Yahoo/Nasdaq + static snapshot generator `npm run snapshot`), `ibkr.ts` (IBKR Client Portal paper adapter + safe `DEMO` paper session), and `Spot -> Margin $500` transfer & price-alert state machine.
2. **1:15–2:05 — 576×288 G2 HUD, Voice & Tests:** Build 4 focused G2 views (`Equities + Earnings Tape`, `4-CEX Best Bid/Ask Depth`, `Spot->Margin & Alert Confirm Gate + 2.0s Undo Ring`, `Session PnL + IBKR/CEX Margin Gauge`), wire zero-key local STT + 20 Vitest tests (`Spot->Margin`, negation voice guard, CEX spread math, protobuf `CLICK_EVENT`, LVGL byte budget).
3. **2:05–2:45 — Simulator QA, `.ehpk`, Pages & 1080p Video:** Run `npm run typecheck && npm test && npm run pack && npm run build:pages && npm run verify:sim` (`evenhub-simulator@0.9.5` -> `0` errors, `0` missing glyphs, `tapehud-g2.ehpk`), render crisp 1080p simulator walkthrough (`<= 2m15s`, explicitly highlighting `"Move $500 spot -> margin? Yes / No"` and live NVDA + Binance/OKX/Bybit/Coinbase), push public GitHub repo + `gh-pages`, and upload YouTube Public demo.
4. **2:45–3:00 — Submit 2nd BUIDL on DoraHacks (`2477`):** Create distinct BUIDL **`TapeHUD G2`** under `03 · Exchanges & Stocks` (`4800`), attach GitHub repo + live GitHub Pages preview + 1080p YouTube demo + `docs/API-FEEDBACK.md` (5 concrete Binance/OKX/IBKR/Even Hub requests) + `.ehpk` release. Verify `PulseHUD #51780` remains untouched.
