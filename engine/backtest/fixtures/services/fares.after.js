// Fixture: INC-005 resource-leak — post-fix (safe)
// fetchPartnerFares acquires a connection and always releases it in a finally block.

async function fetchPartnerFares(origin, destination, date) {
  const conn = await pool.acquire();
  try {
    const response = await partnerApi.getFares(conn, { origin, destination, date });
    return response.fares;
  } finally {
    await pool.release(conn);
  }
}

module.exports = { fetchPartnerFares };
