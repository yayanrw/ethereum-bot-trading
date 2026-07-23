/**
 * Circuit breaker — a safety cutout, NOT a stop loss.
 *
 * The strategy has no cutloss by design, so this never sells at a loss. What it
 * does is refuse to deploy MORE capital when something looks wrong: it halts new
 * entries and pulls resting bids, while leaving open lots and their profit-taking
 * sells untouched (holding is the strategy; closing a lot at its target reduces
 * exposure, so exits stay live even while halted).
 *
 * Three independent conditions:
 *
 *   drawdown  - unrealised mark-to-market loss on open lots exceeds a ceiling.
 *               This is the real risk of a no-cutloss grid: price falls through
 *               the whole ladder and every lot is underwater. LATCHED — once
 *               tripped it stays tripped until manually reset, so it can't
 *               auto-clear and re-trip in a fee-burning loop.
 *   errors    - N consecutive tick failures (exchange down, auth broken). The
 *               loop otherwise logs and continues forever; blindly acting on a
 *               broken exchange is worse than stopping. LATCHED.
 *   price gap - the price moved more than X% since the PREVIOUS tick. A one-off
 *               feed glitch spikes then reverts, so the tick is SKIPPED (not
 *               latched) and self-corrects next tick; a real crash moves
 *               gradually across ticks and is not skipped.
 *
 * Any threshold of 0 disables that check.
 */
import type { Lot } from '../types.ts';

export interface BreakerConfig {
  /** Max unrealised loss (USDT) across open lots before latching. 0 = off. */
  maxDrawdownUsdt: number;
  /** Consecutive tick failures before latching. 0 = off. */
  maxConsecutiveErrors: number;
  /** Max % price move vs the previous tick before skipping the tick. 0 = off. */
  maxPriceJumpPct: number;
}

export interface BreakerState {
  tripped: boolean;
  reason?: string;
  trippedAt?: string;
  /** Raw price seen last tick, for the gap check. Updated every tick. */
  lastPrice?: number;
  consecutiveErrors: number;
}

export const freshBreakerState: BreakerState = { tripped: false, consecutiveErrors: 0 };

/** Total mark-to-market loss (positive magnitude) on lots currently underwater. */
export function unrealizedLossUsdt(lots: Lot[], price: number): number {
  let loss = 0;
  for (const lot of lots) {
    const mtm = (price - lot.entryPrice) * lot.qty;
    if (mtm < 0) loss += -mtm;
  }
  return loss;
}

/** Reason string if drawdown trips, else undefined. */
export function checkDrawdown(lots: Lot[], price: number, maxUsdt: number): string | undefined {
  if (maxUsdt <= 0) return undefined;
  const loss = unrealizedLossUsdt(lots, price);
  if (loss > maxUsdt) {
    return `unrealised drawdown ${loss.toFixed(2)} USDT exceeds limit ${maxUsdt} across ${lots.length} lot(s)`;
  }
  return undefined;
}

/**
 * Reason string if the tick should be SKIPPED for a suspicious price jump, else
 * undefined. Compares against the previous tick's raw price; the first tick
 * (no prior price) always passes.
 */
export function checkPriceJump(
  price: number,
  lastPrice: number | undefined,
  maxPct: number,
): string | undefined {
  if (maxPct <= 0 || lastPrice === undefined || lastPrice <= 0) return undefined;
  const jumpPct = Math.abs(price / lastPrice - 1) * 100;
  if (jumpPct > maxPct) {
    return `price moved ${jumpPct.toFixed(1)}% since last tick (${lastPrice} -> ${price}), over ${maxPct}% — skipping`;
  }
  return undefined;
}

/** Whether the consecutive-error count should latch the breaker. */
export function shouldTripErrors(consecutiveErrors: number, max: number): boolean {
  return max > 0 && consecutiveErrors >= max;
}

/** Latch the breaker. Idempotent — an already-tripped state keeps its first reason. */
export function trip(state: BreakerState, reason: string, now = () => new Date().toISOString()): BreakerState {
  if (state.tripped) return state;
  return { ...state, tripped: true, reason, trippedAt: now() };
}
