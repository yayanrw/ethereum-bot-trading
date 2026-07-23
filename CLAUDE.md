# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Autonomous ETH/USDT spot grid-trading bot (Bun + TypeScript, ES modules). Strategy: buy the dip in installments, no cutloss, each lot sold separately one grid level up. A daily LLM reflection loop rewrites the machine-executable rules the bot reads before every entry/exit. Runtime: Bun (no Node). LLM model default `claude-opus-4-8`.

The README is unusually detailed — read it for strategy rationale, safety modes, circuit-breaker semantics, and deploy. It is written in Indonesian.

## Commands

```bash
bun install
bun test                          # full suite, no network, no API key
bun test test/agent.test.ts       # single file
bun test -t "sellTargetFor"       # single test by name
bun run start                     # bot loop (src/index.ts) — default DRY_RUN=true
bun run evaluate                  # reflection loop (needs >=5 closed trades + LLM access)
bun run report                    # win rate + PnL per day; --json for machines
bun run reset-breaker             # print trip reason, then clear the latched breaker
```

No lint/format step configured. No build step — Bun runs TS directly.

## Architecture

**The whole trading brain is one pure function.** `decideTick` in `src/strategies/grid.ts` takes a snapshot + positions + lessons + config and returns a `TickPlan` (bids to place/cancel, sells to place/cancel, holds, log entries). It performs zero I/O. That is why the test suite runs without an exchange or network. When changing trading logic, change `decideTick` and test it directly — do not push side effects into it.

`src/index.ts` is the only place with side effects: it polls the exchange, calls `reconcile` (turns filled orders into lots / closes sold lots), runs `decideTick`, then executes the plan against the exchange and persists state. The main loop lives here.

**Data flow per tick (default 60s):**
1. Fetch live price + OHLCV; **drop the last candle** (still forming — its close/volume mutate each poll and would flicker rules).
2. Build `IndicatorSnapshot` (`src/core/indicators.ts`, dependency-free: rsi14, atrPct, ema20/50, emaSpreadPct, volumeRatio).
3. `reconcile` promotes filled bids → lots, closes lots whose sell filled, records PnL.
4. Reload `data/lessons.json` (evaluator may rewrite it live — no restart).
5. `decideTick` → execute → persist.

**Entry vs exit asymmetry (deliberate — see README):** Bids DO rest on the book (a gap-down must not skip levels). Sells do NOT rest — a resting sell fills before the bot can re-poll, so `hold_sell` could never intervene; sells are submitted only after price reaches target AND rules pass. When a `block_entry` rule fires, all resting bids are cancelled.

**lessons.json = executable predicates, not prose.** A lesson has `action` (`block_entry` | `hold_sell`), a `when` array of `{indicator, op, value}` conditions AND-ed together, plus human-readable `rationale`/`evidence`. Empty `when` never fires (guards against a broken rule halting all trading). `indicator` must be a numeric field on `IndicatorSnapshot`. `evaluateRules` applies first-match-wins per action.

**The reflection loop** (`src/strategies/evaluator.ts`, also a CLI entrypoint) gates before spending tokens (<5 closed trades, or no new trades since last revision → abort), builds a bucketed trade report, asks the LLM for a *complete replacement rule set*, validates semantic constraints client-side (max 8 rules, unique ids, no empty-`when`, finite thresholds — violation aborts, never silently fixed), backs up to `data/lessons.bak.json`, bumps `version`.

**LLM access** (`src/core/llm.ts`): `LLM_PROVIDER` selects `api` (`@anthropic-ai/sdk` + `ANTHROPIC_API_KEY`, server-enforced schema) or `claude-code` (shells out to `claude -p`, no API key, schema in prompt + client validation). Auto: `api` if `ANTHROPIC_API_KEY` set, else `claude-code`. `ANTHROPIC_BASE_URL` and `LLM_MODEL` override endpoint/model. Output fences are stripped unconditionally.

**Persistence** (`src/core/memory.ts`): all writes are atomic (temp file + rename) via a write queue; corrupt files are moved aside, never overwritten. `DATA_DIR` (default `data/`) holds `lessons.json`, `positions.json`, `decision-log.json`, `breaker.json`, `bot.lock`. `decision-log.json` is the durable source of win rate — survives restarts.

**Circuit breaker** (`src/core/breaker.ts`): a safety cutout, NOT a stop-loss (strategy is no-cutloss). Trips halt new entries + cancel resting bids while existing lots stay held and sells keep running. Drawdown and consecutive-error trips **latch** (persist across restart via `breaker.json`, manual reset only); a price-jump trip only **skips the tick**.

**Single-instance lock** (`src/core/lock.ts`): atomic exclusive-create on `bot.lock`; a second instance against the same `DATA_DIR` refuses to start. Stale locks are reclaimed if the holding pid is dead on this host (single-host only — pid is meaningless across hosts / NFS).

**Config** (`src/config.ts`): all env-driven, validated at load. Live trading (`DRY_RUN=false` + `TESTNET=false`) refuses to start without `LIVE_CONFIRM=i-understand-the-risk`. In dry-run, exchange keys are optional (read endpoints are unauthenticated) and fills are simulated honestly (only when real price touches the level — never instant-fill).

## Conventions

- Keep `decideTick` and everything it calls pure; tests depend on it.
- `now`/`id`/`roundQty` are injected into `decideTick` for deterministic tests — pass them, don't reach for `Date.now()`/`crypto.randomUUID()` inside the pure core.
- Recorded PnL is **gross** — exchange fees are never deducted anywhere.
