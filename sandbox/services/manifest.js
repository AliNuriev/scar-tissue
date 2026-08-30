// Fixture: INC-008 boundary-error — pre-fix (vulnerable)
// getManifestPage uses start + pageSize - 1 as the slice end index.
// Array.slice treats the end as exclusive, so the last passenger is always dropped.

function getManifestPage(passengers, page, pageSize) {
  const start = page * pageSize;
  return passengers.slice(start, start + pageSize - 1);
}

module.exports = { getManifestPage };
