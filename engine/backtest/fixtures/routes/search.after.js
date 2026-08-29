// Fixture: unvalidated-input — post-fix (safe)
// Pattern: inputs validated against a schema before any business logic.

const { z } = require('zod');

const SearchSchema = z.object({
  origin:      z.string().length(3),
  destination: z.string().length(3),
  departDate:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  passengers:  z.number().int().min(1).max(9),
});

async function searchFlights(req, res) {
  const parsed = SearchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { origin, destination, departDate, passengers } = parsed.data;

  const results = await Flight.find({ origin, destination, date: departDate });
  const priced  = await Fare.query({ flightIds: results.map(f => f.id), passengers });
  res.json(priced);
}

module.exports = { searchFlights };
