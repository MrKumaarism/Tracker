// Check for the history page's monthly aggregation: node test-monthly-summary.js
// ponytail: pulls the function straight out of app.js instead of introducing a
// module system, so the test always runs the shipped code.
const assert = require('assert');
const fs = require('fs');

const src = fs.readFileSync(require('path').join(__dirname, 'app.js'), 'utf8');
const start = src.indexOf('    function buildMonthlySummary(list) {');
const end = src.indexOf('    function monthLabel(key) {');
assert.ok(start !== -1 && end > start, 'buildMonthlySummary not found in app.js');
// isSupportFuel lives at module scope and decides which fills are cost-only
const supStart = src.indexOf('function isSupportFuel(vehicleType, fuelType) {');
const supEnd = src.indexOf('}', src.indexOf('return vehicleType', supStart)) + 1;
assert.ok(supStart !== -1 && supEnd > supStart, 'isSupportFuel not found in app.js');

const buildMonthlySummary = new Function(
    src.slice(supStart, supEnd) + src.slice(start, end) + '\nreturn buildMonthlySummary;'
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

// Car petrol is backup/startup fuel: it counts as spend but never as a cycle,
// so it cannot drag the month's mileage or cost-per-km around
const withPetrol = buildMonthlySummary(entries.concat([
    { date: '2026-09-11', vehicleType: 'Car', fuelType: 'Petrol', spent: 300, qty: 2.94, status: 'support' },
]));
const sepP = withPetrol.find(m => m.key === '2026-09');
assert.strictEqual(sepP.spentSupport, 300);
assert.strictEqual(sepP.spent, 2019);            // 1719 + 300
assert.strictEqual(sepP.spentCompleted, 1200);   // unchanged
assert.strictEqual(sepP.km, 300);                // unchanged
assert.strictEqual(sepP.pending, 1);             // petrol is not a pending cycle
assert.strictEqual(sepP.groups.get('Car|Petrol').support, true);
assert.strictEqual(sepP.groups.get('Car|CNG').support, false);

console.log('monthly summary: all assertions passed');
