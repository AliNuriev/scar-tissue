const { claimUpgradeVoucher } = require('../services/upgrades');

async function claimVoucher(req, res) {
  const { voucherCode, passengerId } = req.body;

  if (typeof voucherCode !== 'string' || !voucherCode ||
      typeof passengerId !== 'string' || !passengerId) {
    return res.status(400).json({
      error: 'Missing or invalid fields: voucherCode (string), passengerId (string)',
    });
  }

  try {
    const voucher = await claimUpgradeVoucher(voucherCode, passengerId);
    return res.status(200).json({ success: true, voucher });
  } catch (err) {
    if (err.name === 'VoucherUnavailableError') {
      return res.status(409).json({ error: err.message });
    }
    throw err;
  }
}

module.exports = { claimVoucher };
