const { VoucherUnavailableError } = require('../errors');

/**
 * Claim a seat-upgrade voucher on behalf of a passenger.
 *
 * The availability check and the claim are merged into a single atomic
 * findOneAndUpdate so that two concurrent requests cannot both see the
 * voucher as unused and both succeed.
 */
async function claimUpgradeVoucher(voucherCode, passengerId) {
  const claimed = await Voucher.findOneAndUpdate(
    { code: voucherCode, status: 'unused' },
    { status: 'used', claimedBy: passengerId, claimedAt: new Date() },
    { new: true }
  );

  if (!claimed) {
    throw new VoucherUnavailableError(voucherCode);
  }

  return claimed;
}

module.exports = { claimUpgradeVoucher };
