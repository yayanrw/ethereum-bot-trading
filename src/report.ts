/**
 * Daily win-rate / PnL report over data/decision-log.json.
 *
 *   bun run report            # table, all days
 *   bun run report --json     # machine-readable, same rows
 *
 * Only exit_filled decisions carry a realised outcome — entry_blocked and
 * exit_held are excluded because there is nothing won or lost to count yet.
 */
import { loadDecisions } from './core/memory.ts';
import { loadConfig } from './config.ts';
import type { Decision } from './types.ts';

const MIN_GRID_STEP_SAMPLES = 20;

export interface GridStepAdvice {
  samples: number;
  enough: boolean;
  currentStep: number;
  minPrice?: number;
  maxPrice?: number;
  rangeUsdt?: number;
  avgAtrPct?: number;
  note: string;
}

/**
 * Pure, descriptive only — no I/O, no "optimal step" number. It reports the
 * realised price range and average ATR% seen across every logged decision
 * (entries, blocks, holds, exits all carry an indicator snapshot) so a human
 * can judge whether GRID_STEP is too wide or too narrow for how the market has
 * actually been moving. It deliberately does not compute a suggested value —
 * with this little history that would be a guess dressed up as a number.
 */
export function adviseGridStep(
  decisions: Decision[],
  currentStep: number,
  minSamples = MIN_GRID_STEP_SAMPLES,
): GridStepAdvice {
  const prices = decisions.map((d) => d.indicators.price).filter(Number.isFinite);
  const atrs = decisions.map((d) => d.indicators.atrPct).filter(Number.isFinite);
  const samples = prices.length;

  if (samples < minSamples) {
    return {
      samples,
      enough: false,
      currentStep,
      note: `Only ${samples} logged observations (need ${minSamples}) — too early to say anything about grid spacing.`,
    };
  }

  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const rangeUsdt = maxPrice - minPrice;
  const avgAtrPct = atrs.reduce((a, b) => a + b, 0) / atrs.length;
  const levelsInRange = rangeUsdt / currentStep;

  return {
    samples,
    enough: true,
    currentStep,
    minPrice,
    maxPrice,
    rangeUsdt,
    avgAtrPct,
    note:
      `Observed price range $${minPrice.toFixed(0)}-$${maxPrice.toFixed(0)} ` +
      `(${rangeUsdt.toFixed(0)} USDT) spans ~${levelsInRange.toFixed(1)} levels at the current ` +
      `$${currentStep} step; average ATR ${avgAtrPct.toFixed(2)}%. Judge width/narrowness from ` +
      `this, don't take it as a target — not a substitute for reviewing the price chart yourself.`,
  };
}

/**
 * % return per day of capital locked up. The strategy is no-cutloss and every
 * sell fills strictly above entry, so win rate is 100% by construction and
 * pnlPct is fixed by which grid level filled — neither varies with market
 * conditions. Holding time is the only outcome variable that does, and this
 * turns it into the same units as pnlPct so it reads as money, not hours.
 */
export function pctPerDay(d: Decision): number {
  const hours = d.holdingHours;
  if (hours === undefined || hours <= 0) return 0;
  return (d.pnlPct ?? 0) / (hours / 24);
}

export interface DailyStats {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  trades: number;
  wins: number;
  winRatePct: number;
  totalPnlUsdt: number;
  avgPnlPct: number;
  avgHoldingHours: number;
  avgPctPerDay: number;
}

/** UTC date key so grouping doesn't depend on the machine's local timezone. */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Pure — groups closed trades by day, sorted ascending. No I/O. */
export function groupByDay(decisions: Decision[]): DailyStats[] {
  const closed = decisions.filter((d) => d.type === 'exit_filled');
  const byDay = new Map<string, Decision[]>();
  for (const d of closed) {
    const key = dayKey(d.at);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(d);
    else byDay.set(key, [d]);
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, trades]) => {
      const wins = trades.filter((t) => (t.pnlPct ?? 0) > 0).length;
      const totalPnlUsdt = trades.reduce((s, t) => s + (t.pnlUsdt ?? 0), 0);
      const avgPnlPct = trades.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / trades.length;
      const avgHoldingHours = trades.reduce((s, t) => s + (t.holdingHours ?? 0), 0) / trades.length;
      const avgPctPerDay = trades.reduce((s, t) => s + pctPerDay(t), 0) / trades.length;
      return {
        date,
        trades: trades.length,
        wins,
        winRatePct: (wins / trades.length) * 100,
        totalPnlUsdt,
        avgPnlPct,
        avgHoldingHours,
        avgPctPerDay,
      };
    });
}

/** Pure — rolls the per-day rows into one grand total row. */
export function overallStats(days: DailyStats[]): DailyStats | undefined {
  if (days.length === 0) return undefined;
  const trades = days.reduce((s, d) => s + d.trades, 0);
  const wins = days.reduce((s, d) => s + d.wins, 0);
  const totalPnlUsdt = days.reduce((s, d) => s + d.totalPnlUsdt, 0);
  // Weighted by trade count, not a plain average of daily averages.
  const avgPnlPct = days.reduce((s, d) => s + d.avgPnlPct * d.trades, 0) / trades;
  const avgHoldingHours = days.reduce((s, d) => s + d.avgHoldingHours * d.trades, 0) / trades;
  const avgPctPerDay = days.reduce((s, d) => s + d.avgPctPerDay * d.trades, 0) / trades;
  return {
    date: 'ALL',
    trades,
    wins,
    winRatePct: (wins / trades) * 100,
    totalPnlUsdt,
    avgPnlPct,
    avgHoldingHours,
    avgPctPerDay,
  };
}

function printTable(days: DailyStats[], total: DailyStats | undefined): void {
  if (days.length === 0) {
    console.log('No closed trades yet — nothing to report.');
    return;
  }
  console.log('date        trades  wins  win%    pnl(usdt)   avg pnl%  avg hold(h)  avg %/day');
  for (const d of days) {
    console.log(
      `${d.date}  ${String(d.trades).padStart(6)}  ${String(d.wins).padStart(4)}  ` +
        `${d.winRatePct.toFixed(1).padStart(5)}%  ${d.totalPnlUsdt.toFixed(2).padStart(10)}  ` +
        `${d.avgPnlPct.toFixed(2).padStart(7)}%  ${d.avgHoldingHours.toFixed(1).padStart(11)}  ` +
        `${d.avgPctPerDay.toFixed(2).padStart(8)}%`,
    );
  }
  if (total) {
    console.log('----------  ------  ----  ------  ----------  --------  -----------  ---------');
    console.log(
      `${total.date.padEnd(10)}  ${String(total.trades).padStart(6)}  ${String(total.wins).padStart(4)}  ` +
        `${total.winRatePct.toFixed(1).padStart(5)}%  ${total.totalPnlUsdt.toFixed(2).padStart(10)}  ` +
        `${total.avgPnlPct.toFixed(2).padStart(7)}%  ${total.avgHoldingHours.toFixed(1).padStart(11)}  ` +
        `${total.avgPctPerDay.toFixed(2).padStart(8)}%`,
    );
  }
}

if (import.meta.main) {
  const decisions = await loadDecisions();
  const days = groupByDay(decisions);
  const total = overallStats(days);
  const config = loadConfig();
  const gridStepAdvice = adviseGridStep(decisions, config.grid.step);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ days, total, gridStepAdvice }, null, 2));
  } else {
    printTable(days, total);
    console.log(`\nGRID_STEP (currently $${gridStepAdvice.currentStep}): ${gridStepAdvice.note}`);
  }
}
