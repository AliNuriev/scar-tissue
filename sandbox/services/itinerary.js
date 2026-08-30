// Fixture: INC-012 contract-violation — pre-fix (vulnerable)
// renderItinerary reads the operating carrier through a deep property chain on the
// partner response with no shape validation at the boundary.
// If the partner moves a field, the nested access throws on a null intermediate.

async function renderItinerary(bookingRef) {
  const schedule = await partnerApi.getSchedule(bookingRef);

  const operatingCarrier = schedule.segments[0].carrier.operating.iata;

  return {
    ref: bookingRef,
    carrier: operatingCarrier,
    departure: schedule.segments[0].departure,
    arrival: schedule.segments[0].arrival,
  };
}

module.exports = { renderItinerary };
