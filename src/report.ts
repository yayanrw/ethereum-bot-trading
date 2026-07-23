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
import type { Decision } from './types.ts';

export interface DailyStats {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  trades: number;
  wins: number;
  winRatePct: number;
  totalPnlUsdt: number;
  avgPnlPct: number;
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
      return {
        date,
        trades: trades.length,
        wins,
        winRatePct: (wins / trades.length) * 100,
        totalPnlUsdt,
        avgPnlPct,
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
  return {
    date: 'ALL',
    trades,
    wins,
    winRatePct: (wins / trades) * 100,
    totalPnlUsdt,
    avgPnlPct,
  };
}

function printTable(days: DailyStats[], total: DailyStats | undefined): void {
  if (days.length === 0) {
    console.log('No closed trades yet — nothing to report.');
    return;
  }
  console.log('date        trades  wins  win%    pnl(usdt)   avg pnl%');
  for (const d of days) {
    console.log(
      `${d.date}  ${String(d.trades).padStart(6)}  ${String(d.wins).padStart(4)}  ` +
        `${d.winRatePct.toFixed(1).padStart(5)}%  ${d.totalPnlUsdt.toFixed(2).padStart(10)}  ` +
        `${d.avgPnlPct.toFixed(2).padStart(7)}%`,
    );
  }
  if (total) {
    console.log('----------  ------  ----  ------  ----------  --------');
    console.log(
      `${total.date.padEnd(10)}  ${String(total.trades).padStart(6)}  ${String(total.wins).padStart(4)}  ` +
        `${total.winRatePct.toFixed(1).padStart(5)}%  ${total.totalPnlUsdt.toFixed(2).padStart(10)}  ` +
        `${total.avgPnlPct.toFixed(2).padStart(7)}%`,
    );
  }
}

if (import.meta.main) {
  const decisions = await loadDecisions();
  const days = groupByDay(decisions);
  const total = overallStats(days);

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ days, total }, null, 2));
  } else {
    printTable(days, total);
  }
}
