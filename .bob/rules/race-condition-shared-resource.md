---
id: race-condition-shared-resource
bug_class: race-condition
source_incidents: [INC-001]
confidence: 0.86
created_at: 2026-08-29T10:18:30Z
scope: ["src/**/*.js", "services/**/*.js", "routes/**/*.js"]
detection: "await[^;]+find[^;]+;[\\s\\S]{0,400}?if[\\s\\S]{0,400}?await[^;]+(save|update|insert)"
status: active
---

## Rule

When code reads shared state, makes a decision based on what it read, and then
writes back to that same state, the read and the write must happen atomically.
Do not split an availability check and the corresponding claim into separate
awaited statements.

## When this applies

Any state reachable by more than one concurrent request: database rows, cache
entries, counters, inventory, quotas, seat or slot allocations, balances. It
does not apply to values that are local to a single request and never shared.

## Why

Two passengers booked the same seat within the same second. Both requests read
the seat as available, both passed the check, and both wrote a booking. The
window between the read and the write was about forty milliseconds, which is
invisible in manual testing and in code review, and the code had passed both.
Recovery required manual reconciliation of the affected bookings and direct
contact with the passengers.

## Instead of this

```js
const seat = await Seat.findById(seatId);
if (seat.status === 'available') {
  seat.status = 'booked';
  seat.bookedBy = userId;
  await seat.save();
}
```

## Do this

```js
const claimed = await Seat.findOneAndUpdate(
  { _id: seatId, status: 'available' },
  { status: 'booked', bookedBy: userId },
  { new: true }
);

if (!claimed) {
  throw new SeatUnavailableError(seatId);
}
```

The condition moves into the write itself, so the database decides the winner.
A transaction or an explicit lock is equally acceptable; two separate awaited
statements are not.

## Escape hatch

Permitted when the code provably runs single-writer, such as a migration or a
scheduled job with a guaranteed single instance. Mark it and say why:

```js
// scar-tissue-allow: race-condition-shared-resource — single-writer migration
```