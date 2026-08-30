// Fixture: INC-011 error-swallowing — pre-fix (vulnerable)
// getAncillaryCatalogue catches provider errors, logs them, and returns an empty array.
// An empty result is indistinguishable from a route with no ancillary offers.

async function getAncillaryCatalogue(routeId) {
  try {
    return await catalogueProvider.fetch(routeId);
  } catch (err) {
    console.error('catalogue fetch failed', err);
    return [];
  }
}

module.exports = { getAncillaryCatalogue };
