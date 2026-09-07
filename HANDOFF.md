# Handoff: Cut the grid bot over from dry-run to Binance spot testnet

**Generated**: 2026-09-07 14:10 WIB
**Branch**: `chore/sync-report-feature-and-runtime-state` (pushed, tracking `origin`, not merged to `main`)
**Status**: In Progress — testnet soak running clean, no trades closed yet

## Goal

User wants to move `grid-bot.service` off the 6-week DRY_RUN soak and onto **Binance spot testnet** (`DRY_RUN=false`, `TESTNET=true`) to validate real exchange plumbing (auth, order placement, cancel, reconcile against real server responses) before ever considering a real-money run. No code changes — config + runtime-state only.

Prior session's work (top-level-trap fix, re-range to 1900–2500, evaluator learnability) is already committed (`7a38a9f`..`b3791d7`) and unaffected. This session is purely the testnet cutover.

## Completed

- [x] Confirmed testnet reachable: probed `testnet.binance.vision` via ccxt sandbox mode — ETH/USDT exists, min notional $5, price ~$2500 (tracks mainnet).
- [x] User generated **HMAC-SHA256 testnet API keys** at `testnet.binance.vision` (GitHub login) and wrote them into `.env`.
- [x] `.env` restructured: active `EXCHANGE_API_KEY`/`EXCHANGE_SECRET` = testnet keys; **old mainnet keys commented out** just below, labeled `Mainnet (NONAKTIF ...)`.
- [x] Verified testnet balance via API `fetchBalance`: **USDT 10000 free** (faucet auto-funded, plus 1 BTC / 1 ETH / assorted). Spot testnet has no balances UI — API is the only way.
- [x] `sudo systemctl stop grid-bot` (clean SIGTERM, released lock).
- [x] Full pre-switch backup: `cp -r data /root/projects/ethereum-bot-trading-BACKUP-dryrun-2026-09-07/` (sibling of repo, **outside git**).
- [x] Cleaned runtime state so testnet starts fresh:
  - `data/positions.json` → `{ "lots": [], "bids": [] }` (dropped 3 stale `dry-buy-*` bids — see Failed Approaches for why this is mandatory).
  - `data/breaker.json` → `{ "tripped": false, "consecutiveErrors": 0 }`.
  - `data/decision-log.json` → `[]`; the 25 dry-run events archived to `data/decision-log.dryrun-archive.json` (untracked).
  - `data/lessons.json` **untouched** — v2, `seed-atr-guard`=4, still enforced.
- [x] `.env`: `DRY_RUN=true` → `DRY_RUN=false` (`TESTNET=true` unchanged, grid/breaker unchanged).
- [x] `sudo systemctl start grid-bot` → startup log shows `mode : TESTNET (real orders on Binance sandbox)`.
- [x] Verified end-to-end: bot placed **3 real limit-buy orders** on the testnet book (order ids `9403816/17/18`, numeric — not `dry-buy-*`) at 2400/2300/2200. Confirmed via independent API `fetchOpenOrders` + `fetchBalance` (USDT 299.54 locked).
- [x] ~5 min of ticks, no fills, no errors, breaker not tripped.
- [x] Memories written: `testnet-soak-2026-09`, `live-capital-sizing` (+ `MEMORY.md` index).

## Not Yet Done

- [ ] Watch the soak — no lot has opened yet (price ~$2497, top bid $2400, needs a ~4% dip).
- [ ] Nothing committed. `.env` is gitignored; `data/*` drift + the new archive file are uncommitted (see Current State). User has previously folded such drift into "Sync runtime state" commits — offer, don't assume.
- [ ] PR to `main` still not opened (carried over from prior session): https://github.com/yayanrw/ethereum-bot-trading/pull/new/chore/sync-report-feature-and-runtime-state
- [ ] Real-money run — explicitly **not** now. Only after weeks of clean testnet. Sizing recommendation already given: start $300–400 total, `USDT_PER_LEVEL` $50–65. See memory `live-capital-sizing`.

## Failed Approaches (Don't Repeat These)

- **Editing `.env` via `nano`/`pico`/`vi` through the Claude Code `!` prompt** — fails with `Standard input is not a terminal`. The `!` prompt only runs non-interactive commands. Fix: user pasted keys into chat and the agent wrote them with the Edit tool (acceptable here — testnet keys can only touch sandbox play-money). For real keys later: use a real SSH terminal, or a non-interactive `sed -i` one-liner with `read -rsp`.
- **Starting testnet against the existing `data/positions.json`** (which held 3 `dry-buy-33/34/37` bids) — would be broken. `reconcile` calls `ex.fetchOrderStatus("dry-buy-33")` → real Binance `fetchOrder` → `OrderNotFound` thrown (NOT caught in `fetchOrderStatus`, only `cancelOrder` catches it) → `tick()` throws → after `MAX_CONSECUTIVE_ERRORS=5` the breaker latches. That's why positions.json MUST be cleared to empty before the first testnet start. `lots` was already `[]` so only bids needed clearing.

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Testnet-live (`DRY_RUN=false`+`TESTNET=true`), not straight to real money | Real orders hit a real matching engine / real server responses — exercises the exact code paths (`CcxtExchange`, auth, cancel, reconcile) that DRY_RUN never touches, with zero financial risk. |
| Reuse the same `data/` dir, don't add a separate `DATA_DIR` for testnet | systemd unit has `ProtectSystem=strict` + `ReadWritePaths=.../data` — a new dir would need a unit edit + `daemon-reload`. Cleaning `data/` in place is simpler and fully reversible via the external backup. |
| Archive `decision-log.json` to `*.dryrun-archive.json`, start live log at `[]` | Keeps `bun run report` for the testnet phase clean (no dry-run trades mixed in). Evaluator re-gates at 0 trades → won't run until 5 fresh testnet closes; that's expected/desired. |
| Keep mainnet keys commented in `.env`, not deleted | One-line rollback. |
| `MAX_DRAWDOWN_USDT=350` left as-is | No real money at risk on testnet; not worth changing. |
| Backup dir placed at `/root/projects/ethereum-bot-trading-BACKUP-dryrun-2026-09-07/` (sibling, outside repo) | Keeps it out of `git status` and outside the systemd `ReadWritePaths` sandbox. |

## Current State

**Working**: `grid-bot.service` `active`, testnet mode. 3 resting testnet buy orders at 2400/2300/2200 (verified on exchange). Ticking every 60s, `lots 0 bids 3`, breaker clean. Full test suite still 102/102 (unchanged — no code touched).

**Broken**: Nothing.

**Uncommitted Changes**:
- `data/breaker.json` — `lastPrice` now testnet feed value, fresh (no trip).
- `data/positions.json` — 3 testnet bids with numeric order ids (was 3 `dry-buy-*`).
- `data/decision-log.json` — reset to `[]` (was 25 dry-run events; hence the `-227 lines` in `git diff --stat`).
- `data/decision-log.dryrun-archive.json` — **untracked**, the archived 25 events.
- `.env` — **gitignored**, not in `git status`: `DRY_RUN=false`, testnet keys active, mainnet keys commented.

## Files to Know

| File | Why It Matters |
|------|----------------|
| `.env` (gitignored) | `DRY_RUN=false`, `TESTNET=true`. Active exchange keys = testnet; mainnet keys commented right below. Grid 1900–2500 / $100 / 3 bids unchanged. |
| `src/core/exchange.ts` | `makeClient` line ~42: `if (cfg.testnet) client.setSandboxMode(true)` — the only thing that makes it testnet. `CcxtExchange` (real orders) vs `DryRunExchange` (sim) chosen at `createExchange` by `cfg.dryRun`. |
| `src/index.ts` | `reconcile` (line ~53) is what would choke on stale `dry-buy-*` ids. Main loop + `tick` here. |
| `data/positions.json` | Live order state. Numeric `orderId` = real testnet order. |
| `data/decision-log.dryrun-archive.json` | The 25 pre-cutover dry-run events, if anyone needs the history / wants to run `report` on it. |
| `/root/projects/ethereum-bot-trading-BACKUP-dryrun-2026-09-07/` | Full pre-cutover `data/` snapshot for rollback. |
| `HANDOFF.md` (this file, committed `b3791d7` previously) | Was the prior session's fix handoff — now overwritten with this one. |

## Code Context

**What selects the exchange impl** (`src/core/exchange.ts`):
```ts
function makeClient(cfg: Config) {
  const client = new ccxt.binance({
    apiKey: cfg.exchange.apiKey, secret: cfg.exchange.secret,
    enableRateLimit: true, options: { defaultType: 'spot' },
  });
  if (cfg.testnet) client.setSandboxMode(true);   // -> testnet.binance.vision
  return client;
}
// createExchange: cfg.dryRun ? new DryRunExchange(cfg) : new CcxtExchange(cfg)
```

**Check testnet state independently** (keys are read from `.env` by Bun):
```bash
bun -e '
import ccxt from "ccxt";
const c = new ccxt.binance({ apiKey: process.env.EXCHANGE_API_KEY, secret: process.env.EXCHANGE_SECRET,
  enableRateLimit: true, options: { defaultType: "spot" } });
c.setSandboxMode(true);
console.log(await c.fetchOpenOrders("ETH/USDT"));
console.log((await c.fetchBalance()).free.USDT);
'
```

**Expected `positions.json` shape after a fill** — bid promoted to lot, then a sell order id attached:
```json
{ "lots": [ { "id": "<uuid>", "gridLevel": 2400, "entryPrice": 2400, "qty": 0.0416,
             "costUsdt": 99.84, "openedAt": "...", "sellOrderId": "<numeric>" } ],
  "bids": [ /* 2300, 2200, and a fresh 2400 re-bid once the lot clears */ ] }
```

**Non-obvious**: a resting bid at level N, once filled, gets a sell placed at N+$100 (`sellTargetFor`). Sells do NOT rest on the book between ticks by design — they're submitted only when price reaches target AND rules pass. Top grid level (2500) is never bid (`targetBidLevels` does `levels.slice(0,-1)`).

## Resume Instructions

1. Confirm the service is alive and in testnet mode:
   ```
   systemctl is-active grid-bot
   journalctl -u grid-bot --no-pager -o cat | grep -E 'mode|\[tick\]' | tail -5
   ```
   - Expected: `active`; a startup line `mode : TESTNET (real orders on Binance sandbox)`; recent `[tick] ... lots N bids M`.
   - If `mode : DRY-RUN`: `.env` wasn't picked up — `sudo systemctl restart grid-bot` (safe only when `lots 0`; check the last tick first).

2. Confirm the bot's state matches the exchange (run the `bun -e` snippet under Code Context):
   - Expected: `fetchOpenOrders` returns the same bids `data/positions.json` lists; USDT locked ≈ `0.0416*2400 + 0.0434*2300 + 0.0454*2200` ≈ $300 while `lots 0`.
   - If they diverge: `reconcile` will self-heal on the next tick — watch one cycle before doing anything.

3. Watch for the first fill (price must dip to ~$2400):
   ```
   journalctl -u grid-bot -f -o cat
   ```
   - Expected on a dip: `[fill] BUY  lvl 2400 ...` then within a few ticks a sell placed at 2500; on recovery `[fill] SELL lvl 2400 ... pnl ~4.16 USDT (4.17%)`.
   - `bun run report` will start showing rows only after the first close.

4. Only after ~2–4 weeks clean: discuss a real-money run. Do NOT flip `TESTNET=false` without: restoring mainnet keys, setting `LIVE_CONFIRM=i-understand-the-risk`, re-sizing capital per memory `live-capital-sizing`, and explicit user go-ahead.

## Setup Required

- `.env` must have valid **testnet** `EXCHANGE_API_KEY`/`EXCHANGE_SECRET` (HMAC-SHA256 from `testnet.binance.vision`, GitHub login). Mainnet keys will be rejected by the sandbox endpoint.
- Testnet balance is faucet-granted automatically on first key creation (~10000 USDT). No claim step, no UI — verify with the API snippet above.
- `grid-bot.service` runs as root, `WorkingDirectory=/root/projects/ethereum-bot-trading`, `EnvironmentFile=-.../.env`, `ReadWritePaths=.../data`. Only one instance per `DATA_DIR` (lock on `data/bot.lock`) — never `bun run start` against `data/` while the service is up; use `DATA_DIR=/tmp/...` for manual tests.

## Edge Cases & Error Handling

- Stale/foreign order id in `positions.json` on a testnet/live start → `fetchOrder` throws `OrderNotFound`, uncaught in `fetchOrderStatus`, tick fails, breaker latches after 5. → Always clear `positions.json` when switching exchange identity.
- `lessons.json` reloads every tick (no restart). `.env` and `.ts` changes need `systemctl restart grid-bot`.
- Testnet feed can be thin / jumpy — `MAX_PRICE_JUMP_PCT=15` will *skip* (not latch) a tick on a >15% inter-tick move. Historic dry-run logs show this firing; harmless.
- Circuit-breaker drawdown/error trips **latch** across restart (`data/breaker.json`); clear with `bun run reset-breaker`.

## Warnings

- `journalctl -u grid-bot` **without a date filter** shows August dry-run lines (`[dry-run] fill ...`, `[breaker] price moved 15%`, 88.1h holds). Those are pre-cutover. The testnet session starts at the `2026-09-07T07:03:10Z` tick. Filter with `--since "2026-09-07 14:03"`.
- `git diff --stat` shows `data/decision-log.json` losing 227 lines — that's the deliberate archive+reset, not data loss. The events are in `data/decision-log.dryrun-archive.json` and the backup dir.
- `.env` contains real testnet keys (low risk) AND commented real mainnet keys (NOT low risk) AND a real `ANTHROPIC_API_KEY`. Never commit, echo, or paste the file.
- Recorded PnL is **gross** everywhere — no fees deducted. Intentional.
- Do not delete `/root/projects/ethereum-bot-trading-BACKUP-dryrun-2026-09-07/` until the testnet phase is clearly over.
