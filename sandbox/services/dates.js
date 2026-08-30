// Fixture: INC-004 boundary-error — pre-fix (vulnerable)
// addOneMonth increments the month component directly, leaving the day untouched.
// 31 Jan -> 31 Feb, which the Date constructor rolls forward into March.

function addOneMonth(date) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + 1);
  return result;
}

module.exports = { addOneMonth };
