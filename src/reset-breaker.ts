/**
 * Clear a latched circuit breaker so the bot resumes placing entries.
 *
 *   bun run reset-breaker
 *
 * The breaker latches on purpose — it will not auto-clear. Only run this after
 * you have looked at WHY it tripped (the reason is printed below) and are
 * satisfied it is safe to resume deploying capital.
 */
import { freshBreakerState } from './core/breaker.ts';
import { loadBreaker, saveBreaker } from './core/memory.ts';

const current = await loadBreaker();

if (!current.tripped) {
  console.log('Breaker is not tripped — nothing to reset.');
} else {
  console.log(`Breaker was tripped at ${current.trippedAt}`);
  console.log(`Reason: ${current.reason}`);
  await saveBreaker(freshBreakerState);
  console.log('Reset. The bot will resume placing entries on its next tick.');
}
