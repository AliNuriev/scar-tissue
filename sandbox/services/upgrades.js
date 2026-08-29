async function claimUpgradeVoucher(voucherCode, passengerId) {
  // Atomically mark the voucher used only if it is currently unused.
  // A single findOneAndUpdate avoids the read-check-write window that
  // would allow two concurrent requests to claim the same voucher.
  const voucher = await Voucher.findOneAndUpdate(
    { code: voucherCode, used: false },
    { $set: { used: true, usedBy: passengerId, usedAt: new Date() } },
    { new: true }
  );

  if (!voucher) {
    return { success: false, reason: 'voucher_not_found_or_already_used' };
  }

  return { success: true, voucher };
}

module.exports = { claimUpgradeVoucher };
