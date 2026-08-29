// Fixture: unvalidated-input — post-fix (safe)
// Pattern: inputs validated against an explicit schema before any business logic.

async function searchFlights(req, res) {
  const { origin, destination, departDate, passengers } = req.body;

  if (
    typeof origin !== 'string' || !origin ||
    typeof destination !== 'string' || !destination ||
    typeof departDate !== 'string' || !departDate ||
    typeof passengers !== 'number' || !Number.isInteger(passengers) || passengers < 1
  ) {
    return res.status(400).json({ error: 'Invalid or missing required fields: origin, destination, departDate, passengers (integer >= 1)' });
  }

  const results = await Flight.find({
    origin,
    destination,
    date: departDate,
  });

  const priced = await Fare.query({ flightIds: results.map(f => f.id), passengers });
  res.json(priced);
}

module.exports = { searchFlights };
