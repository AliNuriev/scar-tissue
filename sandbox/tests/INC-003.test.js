'use strict';

const assert = require('assert');

// Stub globals that search.js references so the test is not an environment check.
global.Flight = { find: async () => [] };
global.Fare   = { query: async () => [] };

const { searchFlights } = require('../routes/search');

function makeRes() {
  const res = { statusCode: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json   = () => {};
  return res;
}

async function testInvalidPayloadIsRejected() {
  // Invariant: passengers sent as a string must produce a 4xx, not a 5xx or a throw.
  const req = { body: { origin: 'LHR', destination: 'JFK', departDate: '2026-06-01', passengers: 'two' } };
  const res = makeRes();

  await searchFlights(req, res);

  assert.ok(
    res.statusCode >= 400 && res.statusCode < 500,
    `Expected 4xx for malformed input but got: ${res.statusCode}`
  );
  console.log('PASS: invalid payload returns 4xx');
}

async function testValidPayloadIsNotRejected() {
  // Invariant: a well-formed request must not be refused with a 4xx.
  const req = { body: { origin: 'LHR', destination: 'JFK', departDate: '2026-06-01', passengers: 2 } };
  const res = makeRes();

  await searchFlights(req, res);

  assert.ok(
    res.statusCode === null || (res.statusCode >= 200 && res.statusCode < 400),
    `Expected non-4xx for valid input but got: ${res.statusCode}`
  );
  console.log('PASS: valid payload is not rejected');
}

async function run() {
  await testInvalidPayloadIsRejected();
  await testValidPayloadIsNotRejected();
}

run().catch(err => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
