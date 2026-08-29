// Fixture: INC-006 race-condition — post-fix (safe)
// Moves the duplicate check into the write itself using a conditional update.

async function creditPoints(memberId, bookingRef, points) {
  const result = await Member.findOneAndUpdate(
    { _id: memberId, 'ledger.bookingRef': { $ne: bookingRef } },
    {
      $push:  { ledger: { bookingRef, points, creditedAt: new Date() } },
      $inc:   { balance: points },
    },
    { new: true },
  );

  if (!result) {
    throw new DuplicateCreditError(bookingRef);
  }
}

module.exports = { creditPoints };
