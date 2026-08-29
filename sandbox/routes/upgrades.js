const { claimUpgradeVoucher } = require('../services/upgrades');

async function claimVoucher(req, res) {
  const { voucherCode, passengerId } = req.body;

  if (typeof voucherCode !== 'string' || !voucherCode.trim()) {
    return res.status(400).json({ error: 'voucherCode must be a non-empty string' });
  }
  if (typeof passengerId !== 'string' || !passengerId.trim()) {
    return res.status(400).json({ error: 'passengerId must be a non-empty string' });
  }

  const result = await claimUpgradeVoucher(voucherCode.trim(), passengerId.trim());

  if (!result.success) {
    return res.status(409).json({ error: 'Voucher not found or already used' });
  }

  res.json({ success: true, voucher: result.voucher });
}

module.exports = { claimVoucher };
