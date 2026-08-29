// Fixture: INC-007 unvalidated-input — pre-fix (vulnerable)
// maxPrice and minPrice come off req.query and go straight into the fare query.

async function searchFares(req, res) {
  const { origin, destination, maxPrice, minPrice } = req.query;

  const fares = await Fare.find({
    origin,
    destination,
    price: { $gte: minPrice, $lte: maxPrice },
  });

  res.json(fares);
}

module.exports = { searchFares };
