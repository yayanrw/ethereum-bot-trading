# Handoff: Grid bot — fix top-level trap, re-range, make evaluator learnable

**Generated**: 2026-08-21 10:15 WIB
**Branch**: `chore/sync-report-feature-and-runtime-state` (pushed, tracking `origin`, not yet merged to `main`)
**Status**: Ready for Review

## Goal

Fix three related problems found by analyzing 28 days of `data/decision-log.json` (2026-07-24 → 2026-08-21): a live defect where a lot bought at the top grid level never gets a sell order, a grid range that had drifted below market price, and an LLM reflection loop whose win-rate/pnl% feedback signal is mathematically constant and therefore useless.

Full writeup: `docs/plan-2026-08-21-perbaikan-grid-bot.md` (source of truth for the "why").

## Completed

- [x] **P0 defect fix** — `targetBidLevels` (`src/strategies/grid.ts`) now excludes the grid's top level from biddable levels (`levels.slice(0, -1)`). Root cause: `sellTargetFor` only looks *above* a lot's grid level, so a lot bought at the top level got `undefined` and `decideTick` skipped it forever (immortal position, no exit).
- [x] Regression tests added in `test/agent.test.ts` — confirmed (via `git stash` on `grid.ts` only) that both **fail without the fix**.
- [x] **P0 re-range** — `.env`: `GRID_LOWER` 1500→1900, `GRID_UPPER` 2200→2500, `MAX_DRAWDOWN_USDT` 400→350 (kept the "~50% of capital" comment honest at the new 700 USDT total). `.env` is gitignored — this edit is **not** in git history, see Setup Required below.
- [x] **P1 `seed-atr-guard` retune** — `data/lessons.json`: threshold 12→4 (12 never fired; observed atrPct peaked at 2.50% over the whole log). `version` bumped to 2.
- [x] **P1 evaluator learnability** — win rate is 100% by construction (no-cutloss, sells strictly above entry) and pnlPct is fixed by grid level, not market conditions, so the old win%/avg-pnl% buckets were constant everywhere. Replaced with median-hold-time and %/day-of-capital:
  - `src/report.ts`: new exported `pctPerDay(d)`; `DailyStats`/`groupByDay`/`overallStats`/`printTable` extended with `avgHoldingHours`/`avgPctPerDay`.
  - `src/strategies/evaluator.ts`: `bucketise` output format changed; ATR bucket edges recalibrated `[4,8,12]` → `[0.5,1,2]`; `SYSTEM_PROMPT` now explicitly tells the LLM win rate/pnlPct carry no signal and that `block_entry` can only help in a downtrend, only cost in an uptrend.
  - `src/types.ts`: `LessonEvidence.avgPctPerDay` added.
  - `test/evaluator.test.ts`, `test/report.test.ts`: fixtures and assertions updated to match.
- [x] Full verification: `bun test` → **102 pass, 0 fail**. `bun run report` confirms lot-1900 ≈ 0.20%/day vs lot-1800 ≈ 3.25%/day (16× spread — proves the new metric actually discriminates). `bun run evaluate` still correctly gates on `not-enough-trades` (2 < 5).
- [x] Isolated smoke tests (temp `DATA_DIR`, didn't touch the live process): confirmed `7 levels 1900..2500`, `700 USDT`, bids at 2300/2200/2100, never at 2500; and a manual trap test (`GRID_UPPER` forced below market) confirmed bids land one level down, never on the (now-invalid) top.
- [x] User restarted `grid-bot.service` (systemd) themselves — confirmed via `systemctl status` it picked up the new grid (`7 levels 1900..2500`, `capital: 700 USDT`) and placed bids at 2300/2200/2100.
- [x] 7 commits made and pushed to `origin/chore/sync-report-feature-and-runtime-state` (see `git log --oneline main..HEAD`).

## Not Yet Done

- [ ] PR not opened. GitHub gave this link on push: https://github.com/yayanrw/ethereum-bot-trading/pull/new/chore/sync-report-feature-and-runtime-state — user hasn't asked for it yet, just say the word.
- [ ] Everything below is **deliberately deferred** (documented as P2 in the plan doc, not a gap):
  - Blocked-duration instrumentation (`entry_blocked` currently logs only on transition, not duration).
  - Fee estimation alongside gross PnL (currently ~3.7% of profit; would matter more if `GRID_STEP` narrows).
  - Geometric grid step (fixed $100 step means % width shrinks as price rises).
  - `seed-rsi-guard` — left untouched, 6 blocks / 0 proven bad, wait for evaluator evidence.

## Failed Approaches (Don't Repeat These)

None. This was an approved plan executed as designed — no abandoned technical approaches. (One tool-call hiccup mid-session: an early `AskUserQuestion` call passed `preview: null` on some options and got an InputValidationError; fixed by omitting the field. Irrelevant to the codebase, mentioned only for completeness.)

## Key Decisions

| Decision | Rationale |
|---|---|
| Exclude top grid level via `levels.slice(0, -1)` in `targetBidLevels`, not by changing `sellTargetFor` | `sellTargetFor` was already correct and tested; the bug was entry-side allowing a fill with no possible exit. A grid of N levels has only N−1 tradeable bid slots. |
| Grid re-ranged to 1900–2500 (not some other range) | User's explicit choice via AskUserQuestion, given price was at 2349 and old range topped out at 2200. |
| `seed-atr-guard` lowered to 4%, not left at 12% | User's explicit choice; 12 never fired in the whole log (max observed 2.50%), so it was providing zero protection. |
| Evaluator buckets report median-hold + %/day instead of win%/avg-pnl% | Win rate is 100% by construction (no-cutloss, sell only above entry) and pnlPct is set by grid level, not market state — those two metrics are provably constant. Holding time is the only variable that reflects market conditions. |
| Committed pre-existing uncommitted `adviseGridStep` work (in `src/report.ts`/`test/report.test.ts`) as its own commit before layering the plan's changes | Kept this batch's diff clean and reviewable; that work predated this session's task. |
| Split the implementation into 4 commits (fix, retune, evaluator, runtime-state-sync) rather than one big commit | Each is independently reviewable and revertable. |

## Current State

**Working**: Full test suite green (102/102). `grid-bot.service` is live, restarted, running the new grid (1900–2500, 700 USDT) in DRY_RUN+TESTNET mode (no real funds at risk).

**Broken**: Nothing known.

**Uncommitted Changes**: Only `data/breaker.json` shows as modified (`git status`) — this is the live bot ticking and rewriting `lastPrice` every poll (60s). It is **not** part of this work; expected drift, safe to ignore or fold into a later "sync runtime state" commit. Do not treat it as a regression.

## Files to Know

| File | Why It Matters |
|---|---|
| `docs/plan-2026-08-21-perbaikan-grid-bot.md` | The approved plan — full analysis, rationale, and verification checklist this session executed against. Read this first for "why". |
| `src/strategies/grid.ts` | `targetBidLevels` — the P0 fix. `sellTargetFor` right below it is correct and untouched. |
| `src/strategies/evaluator.ts` | Reflection loop: `bucketise`, `SYSTEM_PROMPT`, `LESSONS_SCHEMA` — all touched for the learnability fix. |
| `src/report.ts` | `pctPerDay` — the single definition of the %/day metric, shared by the CLI report and the evaluator. |
| `data/lessons.json` | `seed-atr-guard` threshold now 4 (was 12). `seed-rsi-guard` untouched. |
| `.env` (gitignored, local only) | `GRID_LOWER=1900`, `GRID_UPPER=2500`, `MAX_DRAWDOWN_USDT=350`. **Not in git** — see Setup Required. |
| `test/agent.test.ts` | Has the two regression tests that catch the top-level-trap defect if it regresses. |

## Code Context

**The fix** (`src/strategies/grid.ts`):
```ts
export function targetBidLevels(
  price: number,
  levels: number[],
  lots: Lot[],
  maxOpenBids: number,
): number[] {
  const biddable = levels.slice(0, -1); // top level is a sell target only
  const taken = new Set(lots.map((l) => l.gridLevel));
  return biddable
    .filter((l) => l <= price && !taken.has(l))
    .reverse()
    .slice(0, maxOpenBids);
}
```

**The new outcome metric** (`src/report.ts`):
```ts
export function pctPerDay(d: Decision): number {
  const hours = d.holdingHours;
  if (hours === undefined || hours <= 0) return 0;
  return (d.pnlPct ?? 0) / (hours / 24);
}
```

**New evaluator bucket line format** (was `${n} trades, ${win}% win, avg ${pnl}%`):
```
BY ENTRY ATR% — 0.5-1: 8 trades, avg 3.40%, median hold 20.0h, 4.08%/hari | >2: 6 trades, avg 3.20%, median hold 400.0h, 0.19%/hari
```

## Resume Instructions

1. `git fetch && git log --oneline main..origin/chore/sync-report-feature-and-runtime-state` — confirm you see the same 7 commits listed under "Completed" above.
2. `bun test`
   - Expected: `102 pass, 0 fail`.
3. `bun run report`
   - Expected: table has `avg %/day` column; with the current `data/decision-log.json` the two closed trades show ≈0.20%/day (1900 lot, held 631.7h) and ≈3.25%/day (1800 lot, held 41.1h).
4. `systemctl status grid-bot --no-pager | head -20`
   - Expected: log lines show `grid : 7 levels 1900..2500 step 100` and `capital : ... 700 USDT fully at risk`, with resting bids only at 2300/2200/2100 (never 2500).
   - If it still shows the old 1500..2200 range: the service hasn't picked up `.env` yet — needs `systemctl restart grid-bot` (safe only when `lots=0`; check the log first).
5. To continue with P2 work (not requested yet, but the natural next step per the plan's "Yang sengaja TIDAK dikerjakan" section): start with blocked-duration instrumentation in `grid.ts`/`decision-log.json`, since the evaluator's `SYSTEM_PROMPT` already tells the LLM to detect over-tight rules but the data to do so doesn't exist yet.

## Setup Required

- `.env` is gitignored and was edited locally, not committed. A fresh clone needs it recreated with (at minimum) these values changed from whatever template/defaults exist:
  ```
  GRID_LOWER=1900
  GRID_UPPER=2500
  GRID_STEP=100
  MAX_DRAWDOWN_USDT=350
  ```
  Real exchange/LLM API keys go in the same file locally — never in git, never echoed into any doc.
- `grid-bot.service` (systemd, `/etc/systemd/system/grid-bot.service`) runs `bun run src/index.ts` against this repo's `cwd` and default `DATA_DIR=data/`. It has been running continuously since 2026-08-06 in DRY_RUN+TESTNET (no real funds). Only one instance can hold the lock on a given `DATA_DIR` (`src/core/lock.ts`) — don't run `bun run start` manually against the same `data/` while the service is up; use `DATA_DIR=/some/temp/dir` for manual smoke tests instead (that's how this session verified the fix without disturbing production).

## Edge Cases & Error Handling

- `lessons.json` changes take effect on the **next tick** without a restart (the bot reloads it every cycle). `.env` and any `.ts` code changes do **not** — they require `systemctl restart grid-bot`.
- If `GRID_UPPER` is ever set below the current market price (grid left behind again), the fix guarantees the bot bids one level below the top instead of at the (invalid) top — verified manually this session.
- `decision-log.json` is append-only and durable; re-ranging the grid does not touch it, so historical win-rate/PnL stats survive.

## Warnings

- `.env` contains real-looking `EXCHANGE_API_KEY`, `EXCHANGE_SECRET`, `ANTHROPIC_API_KEY` — do not commit, log, or paste this file's contents anywhere shareable.
- `data/breaker.json` (and to a lesser extent `positions.json`/`decision-log.json`) will keep drifting under `git status` as long as `grid-bot.service` runs — that's the live bot ticking, not uncommitted work you introduced. Check `git diff` content, not just the modified flag, before assuming something's wrong.
- This repo's PnL is **gross** everywhere (fees never deducted) — a deliberate, documented simplification, not a bug.
