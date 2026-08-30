// scar-tissue-allow: unvalidated-input-route-handler — pre-fix fixture for INC-002
// Fixture: INC-002 unbounded-resource — pre-fix (vulnerable)
// getBookingHistory fetches every booking for the account with no limit or pagination.

async function getBookingHistory(req, res) {
  const { accountId } = req.params;

  const bookings = await Booking.find({ accountId });

  res.json(bookings);
}

module.exports = { getBookingHistory };
