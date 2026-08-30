'use strict';

const assert = require('assert');

// Invariant: pool outstanding count must return to zero after failures on the error path.

let outstanding = 0;

global.pool = {
  acquire: async () => { outstanding++; return {}; },
  release: async () => { outstanding--; },
};

global.partnerApi = {
  getFares: async () => { throw new Error('502 Bad Gateway'); },
};

const { fetchPartnerFares } = require('../services/fares');

async function testConnectionsReturnToPoolAfterFailure() {
  const N = 5;
  const calls = [];
  for (let i = 0; i < N; i++) {
    calls.push(fetchPartnerFares('A', 'B', '2026-06-01').catch(() => {}));
  }
  await Promise.all(calls);

  assert.strictEqual(
    outstanding,
    0,
    `Expected 0 outstanding connections after ${N} failures, got ${outstanding}`
  );
  console.log('PASS: all connections returned to pool after errors');
}

async function run() {
  await testConnectionsReturnToPoolAfterFailure();
}

run().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
