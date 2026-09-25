import { test } from 'node:test';
import assert from 'node:assert/strict';
import { componentBreakdown, largestRemainderPercentages } from '../../src/ui/format.js';

test('largest remainder sums to exactly 100', () => {
  assert.deepEqual(largestRemainderPercentages([1 / 3, 1 / 3, 1 / 3]), [34, 33, 33]);
  assert.deepEqual(largestRemainderPercentages([0.52, 0.43, 0.05]), [52, 43, 5]);
  assert.deepEqual(largestRemainderPercentages([0.505, 0.495]), [51, 49]);
  assert.deepEqual(largestRemainderPercentages([0, 0]), [0, 0]);
  for (let t = 0; t < 200; t++) {
    const f = Array.from({ length: 1 + (t % 6) }, (_, i) => ((i * 7919 + t * 104729) % 97) + 1);
    assert.equal(largestRemainderPercentages(f).reduce((s, v) => s + v, 0), 100);
  }
});

test('breakdown keeps minor clusters in "Other colors" instead of renormalizing', () => {
  const clusters = [{ fraction: 0.52 }, { fraction: 0.43 }, { fraction: 0.03 }, { fraction: 0.02 }];
  const { items, otherPercent } = componentBreakdown(clusters, 0.08);
  assert.deepEqual(items.map((i) => i.percent), [52, 43]);
  assert.equal(otherPercent, 5);
  const single = componentBreakdown([{ fraction: 1 }], 0.08);
  assert.deepEqual(single.items.map((i) => i.percent), [100]);
  assert.equal(single.otherPercent, 0);
});
