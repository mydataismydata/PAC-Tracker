import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairMirrors, type MirrorRow } from './mirrors';

const WINDOW = { recipientLag: 60, payerLag: 14 };

function row(kind: 'e' | 'c', date: string | null, amount = 100): MirrorRow {
  return { id: `${kind}-${date}-${amount}`, hash: `${kind}:${date}:${amount}`, amount, date: date ? Date.parse(date) : null };
}

// Ponte Vedra Democratic Club to the St. Johns County Democratic Executive
// Committee, 2017: nine $100 payments by the club's reports, five $100 receipts
// and one $200 receipt by the committee's.
const payments = [
  '2017-02-15', '2017-03-09', '2017-04-29', '2017-05-05', '2017-06-09',
  '2017-07-18', '2017-08-25', '2017-09-28', '2017-10-11',
].map((d) => row('e', d));
const receipts = [
  row('c', '2017-02-24'), row('c', '2017-03-28'), row('c', '2017-05-11', 200),
  row('c', '2017-06-23'), row('c', '2017-08-29'), row('c', '2017-10-10'),
];

test('five receipts absorb five payments, never nine', () => {
  const pairs = pairMirrors(payments, receipts, WINDOW);
  assert.equal(pairs.length, 5);
  assert.equal(new Set(pairs.map((p) => p.contribution.hash)).size, 5);
  assert.ok(pairs.every((p) => p.contribution.amount === 100));
});

test('a later sweep finds nothing once the paired receipts are spoken for', () => {
  const first = pairMirrors(payments, receipts, WINDOW);
  const gone = new Set(first.map((p) => p.expenditure.hash));
  const taken = new Set(first.map((p) => p.contribution.hash));
  const second = pairMirrors(
    payments.filter((e) => !gone.has(e.hash)),
    receipts.filter((c) => !taken.has(c.hash)),
    WINDOW,
  );
  assert.deepEqual(second, []);
});

test('a nearer payment does not strand one whose only partner it could take', () => {
  // The first payment fits both receipts and the second is nearer to it; the
  // second payment fits only that nearer receipt. Both must pair.
  const e1 = row('e', '2024-03-01');
  const e2 = row('e', '2024-03-03');
  const near = row('c', '2024-03-02');
  const far = row('c', '2024-03-20');
  const pairs = pairMirrors([e1, e2], [near, far], WINDOW);
  assert.equal(pairs.length, 2);
  assert.equal(pairs.find((p) => p.expenditure === e1)?.contribution, far);
  assert.equal(pairs.find((p) => p.expenditure === e2)?.contribution, near);
});

test('the window is asymmetric and inclusive at both ends', () => {
  const e = row('e', '2024-01-01');
  assert.equal(pairMirrors([e], [row('c', '2024-03-01')], WINDOW).length, 1); // recipient 60 days later
  assert.equal(pairMirrors([e], [row('c', '2024-03-02')], WINDOW).length, 0); // 61 days later
  assert.equal(pairMirrors([e], [row('c', '2023-12-18')], WINDOW).length, 1); // payer 14 days later
  assert.equal(pairMirrors([e], [row('c', '2023-12-17')], WINDOW).length, 0); // 15 days later
});

test('different amounts and undated rows never pair', () => {
  assert.deepEqual(pairMirrors([row('e', '2024-01-01')], [row('c', '2024-01-01', 101)], WINDOW), []);
  assert.deepEqual(pairMirrors([row('e', null)], [row('c', null)], WINDOW), []);
  assert.deepEqual(pairMirrors([row('e', '2024-01-01')], [row('c', null)], WINDOW), []);
});

test('a filing brought back keeps the receipt it was paired with before', () => {
  const e = row('e', '2024-05-10');
  const nearer = row('c', '2024-05-11');
  const before = row('c', '2024-05-30');
  const pairs = pairMirrors([e], [nearer, before], WINDOW, new Map([[e.hash, before.hash]]));
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].contribution, before);
});
