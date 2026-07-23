import { describeMode, loadConfig, type Config } from './config.ts';
import {
  checkDrawdown,
  checkPriceJump,
  freshBreakerState,
  shouldTripErrors,
  trip,
  type BreakerState,
} from './core/breaker.ts';
import { createExchange, type Exchange } from './core/exchange.ts';
import { MIN_CANDLES, snapshot as buildSnapshot } from './core/indicators.ts';
import { acquireLock } from './core/lock.ts';
import {
  appendDecisions,
  flush,
  loadBreaker,
  loadLessons,
  loadPositions,
  paths,
  savePositions,
  saveBreaker,
} from './core/memory.ts';
import { decideTick, gridLevels } from './strategies/grid.ts';
import type { Decision, IndicatorSnapshot, Lot, PositionsFile } from './types.ts';

const CANDLE_LIMIT = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function newDecision(
  type: Decision['type'],
  symbol: string,
  gridLevel: number,
  price: number,
  extra: Partial<Decision> & { indicators: IndicatorSnapshot },
): Decision {
  return {
    id: crypto.randomUUID(),
    type,
    at: new Date().toISOString(),
    symbol,
    gridLevel,
    price,
    ...extra,
  };
}

/**
 * Turn exchange reality into state: promote filled bids into lots, close lots
 * whose sell filled, drop orders that vanished. Runs before any decision so the
 * strategy never reasons about an order that is already gone.
 */
export async function reconcile(
  ex: Exchange,
  cfg: Config,
  positions: PositionsFile,
  current: IndicatorSnapshot | undefined,
): Promise<Decision[]> {
  const decisions: Decision[] = [];
  const symbol = cfg.grid.symbol;

  const survivingBids: typeof positions.bids = [];
  for (const bid of positions.bids) {
    const status = await ex.fetchOrderStatus(bid.orderId);
    if (status.state === 'open') {
      survivingBids.push(bid);
      continue;
    }
    if (status.state === 'canceled' || status.filled <= 0) continue;

    const entryPrice = status.average || bid.price;
    const lot: Lot = {
      id: crypto.randomUUID(),
      gridLevel: bid.gridLevel,
      entryPrice,
      qty: status.filled,
      costUsdt: entryPrice * status.filled,
      openedAt: new Date().toISOString(),
      entryIndicators: bid.placedIndicators,
    };
    positions.lots.push(lot);
    decisions.push(
      newDecision('entry_filled', symbol, bid.gridLevel, entryPrice, {
        qty: lot.qty,
        lotId: lot.id,
        entryPrice,
        indicators: bid.placedIndicators,
      }),
    );
    console.log(`[fill] BUY  lvl ${bid.gridLevel} qty ${lot.qty} @ ${entryPrice}`);
  }
  positions.bids = survivingBids;

  const survivingLots: Lot[] = [];
  for (const lot of positions.lots) {
    if (!lot.sellOrderId) {
      survivingLots.push(lot);
      continue;
    }
    const status = await ex.fetchOrderStatus(lot.sellOrderId);
    if (status.state === 'open') {
      survivingLots.push(lot);
      continue;
    }
    if (status.state === 'canceled' || status.filled <= 0) {
      lot.sellOrderId = undefined;
      survivingLots.push(lot);
      continue;
    }

    const exitPrice = status.average;
    // Gross PnL: exchange fees (~0.1% per side on Binance spot) are not deducted.
    const pnlUsdt = (exitPrice - lot.entryPrice) * status.filled;
    const pnlPct = (exitPrice / lot.entryPrice - 1) * 100;
    const holdingHours = (Date.now() - Date.parse(lot.openedAt)) / 3_600_000;

    decisions.push(
      newDecision('exit_filled', symbol, lot.gridLevel, exitPrice, {
        qty: status.filled,
        lotId: lot.id,
        entryPrice: lot.entryPrice,
        pnlUsdt,
        pnlPct,
        holdingHours,
        indicators: lot.entryIndicators,
        exitIndicators: current,
      }),
    );
    console.log(
      `[fill] SELL lvl ${lot.gridLevel} qty ${status.filled} @ ${exitPrice} ` +
        `pnl ${pnlUsdt.toFixed(2)} USDT (${pnlPct.toFixed(2)}%) held ${holdingHours.toFixed(1)}h`,
    );
  }
  positions.lots = survivingLots;

  return decisions;
}

export async function tick(
  ex: Exchange,
  cfg: Config,
  breaker: BreakerState = freshBreakerState,
): Promise<BreakerState> {
  const price = await ex.fetchPrice();

  // A single-tick price spike is treated as an untrusted feed glitch: skip acting
  // on it. lastPrice is updated regardless, so a real new level is accepted next
  // tick rather than being skipped forever.
  const jump = checkPriceJump(price, breaker.lastPrice, cfg.breaker.maxPriceJumpPct);
  breaker = { ...breaker, lastPrice: price };
  if (jump) {
    console.warn(`[breaker] ${jump}`);
    return breaker;
  }

  // Dry-run only: let simulated resting orders fill against the real price.
  ex.markPrice(price);

  const candles = await ex.fetchClosedCandles(CANDLE_LIMIT);
  if (candles.length < MIN_CANDLES) {
    console.warn(`[tick] only ${candles.length} closed candles, need ${MIN_CANDLES} — skipping`);
    return breaker;
  }
  const snap = buildSnapshot(candles, price);

  const positions = await loadPositions();
  const fills = await reconcile(ex, cfg, positions, snap);

  // Drawdown is checked on freshly-reconciled lots, so the trip reflects reality
  // and takes effect on this same tick's plan.
  if (!breaker.tripped) {
    const dd = checkDrawdown(positions.lots, price, cfg.breaker.maxDrawdownUsdt);
    if (dd) {
      breaker = trip(breaker, dd);
      console.error(`[breaker] TRIPPED — ${dd}. Halting new entries; reset with 'bun run reset-breaker'.`);
    }
  }

  const lessons = await loadLessons();
  const plan = decideTick({
    snapshot: snap,
    positions,
    lessons,
    config: cfg.grid,
    roundQty: (usdt, p) => ex.amountFor(usdt, p),
  });

  if (breaker.tripped) {
    // Halt the entry side entirely: cancel every resting bid, place none. Exits
    // (placeSells / cancelSells) are left untouched — closing a lot at its target
    // reduces exposure, which is what we want while halted.
    plan.cancelBids = [...positions.bids];
    plan.placeBids = [];
    plan.entryBlockedBy = 'circuit-breaker';
  }

  for (const bid of plan.cancelBids) {
    await ex.cancelOrder(bid.orderId);
    positions.bids = positions.bids.filter((b) => b.orderId !== bid.orderId);
  }

  for (const p of plan.placeBids) {
    const orderId = await ex.createLimitBuy(p.qty, ex.priceFor(p.price));
    positions.bids.push({
      orderId,
      gridLevel: p.gridLevel,
      price: p.price,
      qty: p.qty,
      placedAt: new Date().toISOString(),
      placedIndicators: snap,
    });
  }

  for (const lot of plan.cancelSells) {
    if (lot.sellOrderId) await ex.cancelOrder(lot.sellOrderId);
    lot.sellOrderId = undefined;
  }

  for (const s of plan.placeSells) {
    s.lot.sellOrderId = await ex.createLimitSell(s.qty, ex.priceFor(s.price));
  }

  for (const { lot, blockedBy } of plan.holdState) lot.heldBy = blockedBy;
  positions.entryBlockedBy = plan.entryBlockedBy;

  await savePositions(positions);
  await appendDecisions([...fills, ...plan.skipped]);

  const held = plan.holdState.filter((h) => h.blockedBy !== undefined).length;
  console.log(
    `[tick] ${new Date().toISOString()} px ${price.toFixed(2)} ` +
      `rsi ${snap.rsi14.toFixed(1)} atr ${snap.atrPct.toFixed(2)}% ` +
      `emaSpread ${snap.emaSpreadPct.toFixed(2)}% vol×${snap.volumeRatio.toFixed(2)} | ` +
      `lots ${positions.lots.length} bids ${positions.bids.length}` +
      (breaker.tripped ? ' | HALTED (circuit breaker)' : '') +
      (plan.entryBlockedBy && !breaker.tripped ? ` | ENTRY BLOCKED by ${plan.entryBlockedBy}` : '') +
      (held ? ` | ${held} lot(s) HELD at target` : ''),
  );

  return breaker;
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Refuse to start if another bot already runs against this data dir — a second
  // instance would place duplicate orders. Acquired before touching the exchange
  // or any state. Throws LockError (exits non-zero) if held by a live process.
  const releaseLock = await acquireLock(paths.lock);

  const ex = createExchange(cfg);
  await ex.init();

  const levels = gridLevels(cfg.grid);
  const minCost = ex.minCostUsdt();
  if (minCost > 0 && cfg.grid.usdtPerLevel < minCost) {
    throw new Error(
      `USDT_PER_LEVEL=${cfg.grid.usdtPerLevel} is below the exchange minimum order value of ${minCost} — every order would be rejected.`,
    );
  }

  console.log(`mode        : ${describeMode(cfg)}`);
  console.log(`symbol      : ${cfg.grid.symbol}  timeframe ${cfg.timeframe}`);
  console.log(
    `grid        : ${levels.length} levels ${cfg.grid.lower}..${cfg.grid.upper} step ${cfg.grid.step}`,
  );
  console.log(
    `capital     : ${cfg.grid.usdtPerLevel} USDT/level = ${(levels.length * cfg.grid.usdtPerLevel).toFixed(0)} USDT fully at risk`,
  );
  console.log(`open bids   : up to ${cfg.grid.maxOpenBids} levels below price`);
  console.log(
    `breaker     : drawdown ${cfg.breaker.maxDrawdownUsdt || 'off'} USDT, ` +
      `${cfg.breaker.maxConsecutiveErrors || 'off'} errors, ` +
      `${cfg.breaker.maxPriceJumpPct || 'off'}% price gap`,
  );

  let breaker = await loadBreaker();
  if (breaker.tripped) {
    console.warn(
      `\n[breaker] ALREADY TRIPPED (${breaker.trippedAt}): ${breaker.reason}\n` +
        `          Running with entries HALTED. Reset with 'bun run reset-breaker'.\n`,
    );
  }

  let running = true;
  const stop = async (sig: string) => {
    if (!running) return;
    running = false;
    console.log(`\n[${sig}] stopping — flushing state`);
    await flush();
    await releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  while (running) {
    try {
      breaker = await tick(ex, cfg, breaker);
      breaker = { ...breaker, consecutiveErrors: 0 }; // a clean tick clears the streak
    } catch (err) {
      // A network blip must not kill a bot holding open positions — but a broken
      // exchange that keeps failing must not be acted on blindly either.
      console.error('[tick] failed:', err instanceof Error ? err.message : err);
      const errors = breaker.consecutiveErrors + 1;
      breaker = { ...breaker, consecutiveErrors: errors };
      if (!breaker.tripped && shouldTripErrors(errors, cfg.breaker.maxConsecutiveErrors)) {
        breaker = trip(breaker, `${errors} consecutive tick failures`);
        console.error(
          `[breaker] TRIPPED — ${errors} consecutive failures. Halting new entries; ` +
            `reset with 'bun run reset-breaker'.`,
        );
      }
    }
    await saveBreaker(breaker);
    await sleep(cfg.pollIntervalMs);
  }
}

if (import.meta.main) {
  await main();
}
