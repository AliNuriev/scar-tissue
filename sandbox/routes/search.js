// Fixture: unvalidated-input — pre-fix (vulnerable)
// Pattern: req.body fields passed directly to a database query with no check.

async function searchFlights(req, res) {
  const { origin, destination, departDate, passengers } = req.body;

  const results = await Flight.find({
    origin,
    destination,
    date: departDate,
  });

  const priced = await Fare.query({ flightIds: results.map(f => f.id), passengers });
  res.json(priced);
}

module.exports = { searchFlights };
