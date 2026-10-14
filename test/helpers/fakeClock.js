// -----------------------------------------------------------------------------
// A fake clock: timers that fire only when the test moves the time forward,
// in the order of their due time. Enough to test the KNXnet/IP timeouts (1 s
// ACK, 10 s answers, 60 s heartbeat) without waiting for them.
// -----------------------------------------------------------------------------

/** 2026-10-14T08:00:00Z */
export const FIXTURE_NOW = Date.UTC(2026, 9, 14, 8, 0, 0);

/** Let every pending promise and socket callback run. */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function createFakeClock(start = FIXTURE_NOW) {
  let now = start;
  let nextId = 1;
  const pending = new Map();
  const add = (fn, ms, every) => {
    const id = nextId++;
    pending.set(id, { id, fn, at: now + Math.max(0, ms ?? 0), every });
    return id;
  };
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => add(fn, ms),
      clearTimeout: (id) => pending.delete(id),
      setInterval: (fn, ms) => add(fn, ms, ms),
      clearInterval: (id) => pending.delete(id),
    },
    pending: () => [...pending.values()],
    /** Move the time forward, firing every timer due on the way. */
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await settle();
        const due = [...pending.values()]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) {
          break;
        }
        now = due.at;
        if (due.every) {
          due.at += due.every;
        } else {
          pending.delete(due.id);
        }
        due.fn();
      }
      now = target;
      await settle();
    },
  };
}
