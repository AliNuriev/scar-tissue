// Fixture: race-condition — post-fix (safe)
// Pattern: condition moved into the write itself; database decides the winner.

async function assignSeat(seatId, userId) {
  const claimed = await Seat.findOneAndUpdate(
    { _id: seatId, status: 'available' },
    { status: 'booked', bookedBy: userId },
    { new: true },
  );

  if (!claimed) {
    return { success: false, reason: 'unavailable' };
  }

  return { success: true, seat: claimed };
}

module.exports = { assignSeat };
