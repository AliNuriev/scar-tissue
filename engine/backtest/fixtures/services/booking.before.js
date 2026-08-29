// Fixture: race-condition — pre-fix (vulnerable)
// Pattern: read-check-write split across two awaits on shared state.

async function assignSeat(seatId, userId) {
  const seat = await Seat.findById(seatId);

  if (seat.status === 'available') {
    seat.status   = 'booked';
    seat.bookedBy = userId;
    await seat.save();
    return { success: true, seat };
  }

  return { success: false, reason: 'unavailable' };
}

module.exports = { assignSeat };
