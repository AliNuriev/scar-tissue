// Fixture: unbounded-resource — post-fix (safe)
// getBookingHistory applies a server-side cap before querying.

const MAX_PAGE_SIZE = 50;

async function getBookingHistory(req, res) {
  const { accountId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || MAX_PAGE_SIZE, MAX_PAGE_SIZE);

  const bookings = await Booking.find({ accountId }, { limit });

  res.json(bookings);
}

module.exports = { getBookingHistory };
