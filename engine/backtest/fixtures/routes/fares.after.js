// Fixture: INC-007 unvalidated-input — post-fix (safe)
// Inputs validated and bounded before reaching the fare query.

const { z } = require('zod');

const FareQuerySchema = z.object({
  origin:      z.string().length(3),
  destination: z.string().length(3),
  minPrice:    z.coerce.number().min(0).optional(),
  maxPrice:    z.coerce.number().min(0).optional(),
}).refine(d => !d.minPrice || !d.maxPrice || d.minPrice <= d.maxPrice, {
  message: 'minPrice must be less than or equal to maxPrice',
});

async function searchFares(req, res) {
  const parsed = FareQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { origin, destination, minPrice, maxPrice } = parsed.data;
  const priceFilter = {};
  if (minPrice !== undefined) priceFilter.$gte = minPrice;
  if (maxPrice !== undefined) priceFilter.$lte = maxPrice;

  const fares = await Fare.find({
    origin,
    destination,
    price: Object.keys(priceFilter).length ? priceFilter : undefined,
  });

  res.json(fares);
}

module.exports = { searchFares };
