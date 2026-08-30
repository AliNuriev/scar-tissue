const fs = require('fs');

const preFix = fs.readFileSync('engine/backtest/fixtures/services/fares.before.js', 'utf8');
const postFix = fs.readFileSync('engine/backtest/fixtures/services/fares.after.js', 'utf8');
const pricewatch = fs.readFileSync('sandbox/services/pricewatch.js', 'utf8');

// Taxonomy detection_hint
const hint = new RegExp('(connect|acquire|createReadStream|setInterval|addListener)\\([\\s\\S]{0,600}?(?!finally)', 's');
console.log('=== Taxonomy detection_hint ===');
console.log('Matches pre-fix:', hint.test(preFix));
console.log('Matches post-fix:', hint.test(postFix));
console.log('Matches pricewatch:', hint.test(pricewatch));

// Proposed detection v2:
// Matches acquire/setInterval NOT followed by try within ~3 lines.
// Pattern: acquire/setInterval call, then newline(s)+whitespace+non-try-code, then await/call on same level
// Key insight: in pre-fix, the line after acquire is blank then a direct await (no try).
// In post-fix, the line after acquire is "try {".

// Pattern: (acquire|setInterval)\(...\); followed by [\n\r\s]* then NOT "try"
const v2 = new RegExp('(acquire|setInterval)\\([^)]*\\);[\\s]*\\n[\\s]*(?!try)', 'm');
console.log('\n=== v2 detection ===');
console.log('Matches pre-fix:', v2.test(preFix));
console.log('Matches post-fix:', v2.test(postFix));
console.log('Matches pricewatch:', v2.test(pricewatch));

// Pattern v3: acquire/setInterval call that is NOT inside a try block
// Look for "acquire" or "setInterval" preceded by "= await " (or as stmt) but NOT "try {" anywhere in the same func
// Simpler: match acquire/setInterval followed by a non-try statement before a release keyword
const v3 = new RegExp('(acquire|setInterval)\\([\\s\\S]{0,200}?\\);\\s*\\n(?:\\s*\\n)*\\s*(?!try\\b)[a-zA-Z]', 's');
console.log('\n=== v3 detection ===');
console.log('Matches pre-fix:', v3.test(preFix));
console.log('Matches post-fix:', v3.test(postFix));
console.log('Matches pricewatch:', v3.test(pricewatch));
