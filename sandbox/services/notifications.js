// Fixture: INC-009 unbounded-resource — pre-fix (vulnerable)
// sendDisruptionNotifications awaits each delivery sequentially, one passenger at a time.
// For a large disruption this runs for hours with no concurrency.

async function sendDisruptionNotifications(passengers, rebookingDetails) {
  for (const passenger of passengers) {
    await notificationClient.deliver(passenger.id, rebookingDetails);
  }
}

module.exports = { sendDisruptionNotifications };
