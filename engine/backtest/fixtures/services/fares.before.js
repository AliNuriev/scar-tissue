// Fixture: INC-005 resource-leak — pre-fix (vulnerable)
// fetchPartnerFares acquires a connection and releases it only on the success path.
// If the partner call throws, the connection is never returned to the pool.

async function fetchPartnerFares(origin, destination, date) {
  const conn = await pool.acquire();

  const response = await partnerApi.getFares(conn, { origin, destination, date });

  await pool.release(conn);
  return response.fares;
}

module.exports = { fetchPartnerFares };
