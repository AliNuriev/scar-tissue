// Fixture: INC-006 race-condition — pre-fix (vulnerable)
// creditPoints reads the member balance, checks for a duplicate ledger entry,
// then appends and saves in two separate awaited operations.

async function creditPoints(memberId, bookingRef, points) {
  const member = await Member.findById(memberId);
  const alreadyCredited = member.ledger.some(e => e.bookingRef === bookingRef);

  if (!alreadyCredited) {
    member.ledger.push({ bookingRef, points, creditedAt: new Date() });
    member.balance += points;
    await member.save();
  }
}

module.exports = { creditPoints };
