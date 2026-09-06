// Check for the history page's monthly aggregation: node test-monthly-summary.js
// ponytail: pulls the function straight out of app.js instead of introducing a
// module system, so the test always runs the shipped code.
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(require('path').join(__dirname, 'app.js'), 'utf8');
const start = src.indexOf('    function buildMonthlySummary(list) {');
const end = src.indexOf('    function monthLabel(key) {');
assert.ok(start !== -1 && end > start, 'buildMonthlySummary not found in app.js');
const buildMonthlySummary = new Function(
    src.slice(start, end) + '\nreturn buildMonthlySummary;'
)();

const entries = [
    // Car / CNG: two measured tanks in Sep, one pending in Oct
    { date: '2026-09-02', vehicleType: 'Car', fuelType: 'CNG', spent: 800, qty: 10, status: 'completed', distanceDriven: 200 },
    { date: '2026-09-20', vehicleType: 'Car', fuelType: 'CNG', spent: 400, qty: 5,  status: 'completed', distanceDriven: 100 },
    { date: '2026-10-01', vehicleType: 'Car', fuelType: 'CNG', spent: 500, qty: 6,  status: 'pending' },
    // Scooty / Petrol: first fill in Sep, still running
    { date: '2026-09-04', vehicleType: 'Scooty', fuelType: 'Petrol', spent: 519, qty: 5.088, status: 'pending' },
    // undated rows are ignored rather than bucketed under a bogus month
    { date: '', vehicleType: 'Bike', fuelType: 'Petrol', spent: 999, qty: 9, status: 'pending' },
];

const months = buildMonthlySummary(entries);

// Newest month first
assert.deepStrictEqual(months.map(m => m.key), ['2026-10', '2026-09']);

const sep = months[1];
assert.strictEqual(sep.entries, 3);
assert.strictEqual(sep.pending, 1);
assert.strictEqual(sep.spent, 1719);          // includes the pending scooty tank
assert.strictEqual(sep.spentCompleted, 1200); // only measured tanks
assert.strictEqual(sep.km, 300);
assert.strictEqual(sep.spentCompleted / sep.km, 4); // ₹4/km

const carCng = sep.groups.get('Car|CNG');
assert.strictEqual(carCng.km, 300);
assert.strictEqual(carCng.qtyCompleted, 15);
assert.strictEqual(carCng.km / carCng.qtyCompleted, 20); // 20 km/kg

// A pending-only group reports spend and fuel but no distance or mileage
const scooty = sep.groups.get('Scooty|Petrol');
assert.strictEqual(scooty.spent, 519);
assert.strictEqual(scooty.km, 0);
assert.strictEqual(scooty.qtyCompleted, 0);

// Pending tanks carry spend into their own month with zero distance
assert.strictEqual(months[0].spent, 500);
assert.strictEqual(months[0].km, 0);

// Money and fuel sitting in an unmeasured tank are tracked separately, so the
// month can say "you also drove on this" instead of pretending it never happened
assert.strictEqual(sep.spentPending, 519);
assert.strictEqual(sep.qtyPending, 5.088);
assert.strictEqual(scooty.spentPending, 519);
assert.strictEqual(scooty.qtyPending, 5.088);
assert.strictEqual(carCng.spentPending, 0);
assert.strictEqual(months[0].spentPending, 500);

console.log('monthly summary: all assertions passed');
