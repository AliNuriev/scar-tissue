'use strict';
const fs = require('fs');

const beforeCode = `
async function getBookingHistory(req, res) {
  const { accountId } = req.params;
  const bookings = await Booking.find({ accountId });
  res.json(bookings);
}
`;

const afterCode = `
const MAX_PAGE_SIZE = 50;
async function getBookingHistory(req, res) {
  const { accountId } = req.params;
  const limit = Math.min(parseInt(req.query.limit, 10) || MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const bookings = await Booking.find({ accountId }, { limit });
  res.json(bookings);
}
`;

const notificationsCode = fs.readFileSync('sandbox/services/notifications.js', 'utf8');

// Pattern: .find({...}) NOT followed by a second arg containing limit/take/slice/paginate within 100 chars
//          OR: await inside a for-of loop body (unbounded sequential fan-out)
const re = /\.find\(\s*\{[^}]*\}\s*\)(?![\s\S]{0,100}(limit|take|slice|paginate))|for\s*\([^)]*\bof\b[^)]*\)[\s\S]{0,300}?\bawait\b/s;

console.log('Matches before (bookings - unbounded find):', re.test(beforeCode));
console.log('Matches after  (bookings - fixed with limit):', re.test(afterCode));
console.log('Matches notifications.js (INC-009 - await in for-of):', re.test(notificationsCode));
