// Fixture: INC-010 resource-leak — pre-fix (vulnerable)
// deleteWatch removes the record from the database but never clears the interval,
// leaving an orphaned timer still polling and holding its closure in memory.

const timers = new Map();

function createWatch(watchId, route) {
  const intervalId = setInterval(async () => {
    const fare = await fareService.poll(route);
    await Watch.updateOne({ _id: watchId }, { lastFare: fare });
  }, 60_000);
  timers.set(watchId, intervalId);
}

async function deleteWatch(watchId) {
  await Watch.deleteOne({ _id: watchId });
}

module.exports = { createWatch, deleteWatch };
