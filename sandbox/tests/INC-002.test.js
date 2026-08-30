'use strict';

const assert = require('assert');

// Invariant: response must never return more than a capped page size regardless of how many records exist.

const LARGE_RECORD_COUNT = 4000;
const MAX_PAGE_SIZE      = 50;

global.Booking = {
  find: async (_query, opts) => {
    const all = Array.from({ length: LARGE_RECORD_COUNT }, (_, i) => ({ id: i }));
    return opts && opts.limit ? all.slice(0, opts.limit) : all;
  },
};

const { getBookingHistory } = require('../routes/bookings');

function makeRes() {
  const res = { body: null };
  res.json = (data) => { res.body = data; };
  return res;
}

async function testResponseIsCappedWhenManyRecordsExist() {
  const req = { params: { accountId: 'acc-001' }, query: {} };
  const res = makeRes();

  await getBookingHistory(req, res);

  assert.ok(
    Array.isArray(res.body) && res.body.length <= MAX_PAGE_SIZE,
    `Expected at most ${MAX_PAGE_SIZE} records but got ${Array.isArray(res.body) ? res.body.length : res.body}`
  );
  console.log('PASS: response is capped when many records exist');
}

async function run() {
  await testResponseIsCappedWhenManyRecordsExist();
}

run().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
