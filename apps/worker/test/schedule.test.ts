import { describe, expect, it } from 'vitest';
import { scheduleTick } from '../src/queues.js';

/**
 * The bug this pins down shipped and ran for the life of the project.
 *
 * BullMQ derives a repeatable job's key from its name *and* its repeat
 * options, so re-adding `tick` with a new `every` does not update the existing
 * schedule - it creates a second one, and both keep firing. Nothing surfaces
 * it: every tick still succeeds, the queue still looks healthy, and the only
 * symptom is a cadence nobody chose. A worker up 26 minutes had run the prober
 * 34 times against a 300-second setting.
 *
 * It matters because the prober's cadence is what the database transfer budget
 * rests on, and that budget had already been exhausted once, taking the site
 * down with it.
 */
class FakeQueue {
  readonly added: { name: string; opts: { repeat: { every: number } } }[] = [];
  removed: string[] = [];
  constructor(private jobs: { key: string }[] = []) {}
  getRepeatableJobs(): Promise<{ key: string }[]> {
    return Promise.resolve([...this.jobs]);
  }
  removeRepeatableByKey(key: string): Promise<boolean> {
    this.removed.push(key);
    this.jobs = this.jobs.filter((j) => j.key !== key);
    return Promise.resolve(true);
  }
  add(name: string, _data: object, opts: object): Promise<unknown> {
    this.added.push({ name, opts: opts as { repeat: { every: number } } });
    return Promise.resolve({});
  }
}

describe('scheduleTick', () => {
  it('removes an old cadence rather than leaving it to fire alongside the new one', async () => {
    const q = new FakeQueue([{ key: 'bench-prober:tick::::60000' }]);
    const stale = await scheduleTick(q, 300_000);
    expect(q.removed).toEqual(['bench-prober:tick::::60000']);
    expect(q.added).toHaveLength(1);
    expect(q.added[0]?.opts.repeat.every).toBe(300_000);
    expect(stale).toBe(1);
  });

  it('clears every accumulated schedule, not just the most recent', async () => {
    // One per cadence change over the project's life, all still firing.
    const q = new FakeQueue([{ key: 'a:30000' }, { key: 'a:60000' }, { key: 'a:600000' }]);
    expect(await scheduleTick(q, 300_000)).toBe(3);
    expect(q.removed).toHaveLength(3);
    expect(await q.getRepeatableJobs()).toHaveLength(0);
  });

  it('reports nothing stale on a clean queue, and still installs the schedule', async () => {
    const q = new FakeQueue();
    expect(await scheduleTick(q, 300_000)).toBe(0);
    expect(q.removed).toEqual([]);
    expect(q.added[0]?.opts.repeat.every).toBe(300_000);
  });

  it('is idempotent: running it twice leaves exactly one schedule', async () => {
    const q = new FakeQueue();
    await scheduleTick(q, 300_000);
    // A real queue would now report the job just added, which the second run
    // must remove before re-adding - otherwise every boot doubles the rate.
    const asReal = new FakeQueue([{ key: 'installed' }]);
    await scheduleTick(asReal, 300_000);
    expect(asReal.removed).toEqual(['installed']);
    expect(asReal.added).toHaveLength(1);
  });
});
