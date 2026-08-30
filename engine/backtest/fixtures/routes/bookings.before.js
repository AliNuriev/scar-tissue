// Fixture: unbounded-resource — pre-fix (vulnerable)
// getBookingHistory fetches every record with no limit or pagination.

async function getBookingHistory(req, res) {
  const { accountId } = req.params;

  const bookings = await Booking.find({ accountId });

  res.json(bookings);
}

module.exports = { getBookingHistory };
