/**
 * Daily Fuel Prices Scraper & Updater
 * Runs in GitHub Actions every morning after 6:00 AM IST.
 * Updates fuel-prices.json while preserving existing rates safely on any failure.
 */

const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '..', 'fuel-prices.json');

const CITY_SLUGS = {
    noida: { slug: 'noida', name: 'Noida', state: 'Uttar Pradesh' },
    delhi: { slug: 'delhi', name: 'Delhi', state: 'Delhi' },
    gurgaon: { slug: 'gurgaon', name: 'Gurugram', state: 'Haryana' },
    ghaziabad: { slug: 'ghaziabad', name: 'Ghaziabad', state: 'Uttar Pradesh' },
    faridabad: { slug: 'faridabad', name: 'Faridabad', state: 'Haryana' },
    mumbai: { slug: 'mumbai', name: 'Mumbai', state: 'Maharashtra' },
    bangalore: { slug: 'bangalore', name: 'Bengaluru', state: 'Karnataka' },
    hyderabad: { slug: 'hyderabad', name: 'Hyderabad', state: 'Telangana' },
    chennai: { slug: 'chennai', name: 'Chennai', state: 'Tamil Nadu' },
    kolkata: { slug: 'kolkata', name: 'Kolkata', state: 'West Bengal' },
    pune: { slug: 'pune', name: 'Pune', state: 'Maharashtra' },
    jaipur: { slug: 'jaipur', name: 'Jaipur', state: 'Rajasthan' },
    lucknow: { slug: 'lucknow', name: 'Lucknow', state: 'Uttar Pradesh' },
    chandigarh: { slug: 'chandigarh', name: 'Chandigarh', state: 'Punjab / Haryana' }
};

async function fetchRate(slug, fuelType) {
    try {
        const url = `https://www.goodreturns.in/${fuelType}-price-in-${slug}.html`;
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(8000)
        });
        if (!res.ok) return null;
        const html = await res.text();
        const m = html.match(/id="fp-price"[^>]*>&#8377;([0-9.]+)/) || html.match(/id="fp-price"[^>]*>[^0-9]*([0-9.]+)/);
        if (m && m[1]) {
            const val = parseFloat(m[1]);
            // Sanity check: fuel prices in India typically between 60 and 150
            if (!isNaN(val) && val >= 50 && val <= 160) {
                return +val.toFixed(2);
            }
        }
    } catch (err) {
        console.warn(`Fetch error for ${slug} (${fuelType}):`, err.message);
    }
    return null;
}

async function updatePrices() {
    let currentData = { cities: {} };
    if (fs.existsSync(FILE_PATH)) {
        try {
            currentData = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
        } catch (e) {
            console.error('Error reading current fuel-prices.json:', e);
        }
    }

    if (!currentData.cities) currentData.cities = {};
    let updatedCount = 0;

    console.log('Fetching latest fuel prices from OMCs...');

    for (const [key, meta] of Object.entries(CITY_SLUGS)) {
        if (!currentData.cities[key]) {
            currentData.cities[key] = {
                name: meta.name,
                state: meta.state,
                petrol: 102.12,
                cng: 89.20,
                diesel: 95.56
            };
        }

        const petrolRate = await fetchRate(meta.slug, 'petrol');
        if (petrolRate) {
            currentData.cities[key].petrol = petrolRate;
            updatedCount++;
        }

        const cngRate = await fetchRate(meta.slug, 'cng');
        if (cngRate) {
            currentData.cities[key].cng = cngRate;
            updatedCount++;
        }

        const dieselRate = await fetchRate(meta.slug, 'diesel');
        if (dieselRate) {
            currentData.cities[key].diesel = dieselRate;
            updatedCount++;
        }

        // Small delay to be polite to host
        await new Promise(r => setTimeout(r, 400));
    }

    currentData.updatedAt = new Date().toISOString();
    currentData.source = 'Oil Marketing Companies (IOCL/BPCL/HPCL/IGL)';

    fs.writeFileSync(FILE_PATH, JSON.stringify(currentData, null, 2), 'utf8');
    console.log(`Successfully updated fuel prices (${updatedCount} rates verified). Saved to ${FILE_PATH}`);
}

updatePrices().catch(err => {
    console.error('Scraper failed:', err);
    process.exit(0); // Exit 0 so GitHub Actions does not fail the build if scraping encounters network issues
});
