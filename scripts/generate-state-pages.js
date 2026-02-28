#!/usr/bin/env node
/**
 * DumpsterMap State Landing Page Generator
 * 
 * Creates state-level landing pages (e.g., /dumpster-rental/tx.html)
 * that list all cities with providers in that state
 */

const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '../data/providers.json');
const outputDir = path.join(__dirname, '../dumpster-rental');

const stateNames = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
    'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
    'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii',
    'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
    'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine',
    'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
    'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska',
    'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico',
    'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
    'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island',
    'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
    'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
    'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'
};

// Reverse lookup: full name -> abbreviation
const nameToAbbr = Object.fromEntries(
    Object.entries(stateNames).map(([abbr, name]) => [name.toLowerCase(), abbr])
);

function normalizeState(state) {
    if (!state) return null;
    const upper = state.toUpperCase();
    if (stateNames[upper]) return upper; // Already abbreviation
    const lower = state.toLowerCase();
    return nameToAbbr[lower] || null;
}

function createCitySlug(city, state) {
    return `${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${state.toLowerCase()}`;
}

function generateStatePage(stateAbbr, stateName, cities) {
    const sortedCities = Object.entries(cities)
        .map(([city, data]) => ({ city, ...data }))
        .sort((a, b) => b.providers - a.providers);
    
    const totalProviders = sortedCities.reduce((sum, c) => sum + c.providers, 0);
    const topCities = sortedCities.slice(0, 10);
    
    const pageTitle = `Dumpster Rental ${stateName} - Compare ${totalProviders} Local Providers | DumpsterMap`;
    const metaDesc = `Find dumpster rental companies across ${stateName}. Compare ${totalProviders} providers in ${sortedCities.length} cities. Get instant quotes for roll-off dumpsters.`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageTitle}</title>
    <meta name="description" content="${metaDesc}">
    <link rel="canonical" href="https://dumpstermap.io/dumpster-rental/${stateAbbr.toLowerCase()}.html">
    
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://dumpstermap.io/dumpster-rental/${stateAbbr.toLowerCase()}.html">
    <meta property="og:title" content="${pageTitle}">
    <meta property="og:description" content="${metaDesc}">
    <meta property="og:image" content="https://dumpstermap.io/og-image.png">
    
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${pageTitle}">
    <meta name="twitter:description" content="${metaDesc}">
    
    <script type="application/ld+json">
    {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "Dumpster Rental in ${stateName}",
        "description": "${metaDesc}",
        "url": "https://dumpstermap.io/dumpster-rental/${stateAbbr.toLowerCase()}.html",
        "mainEntity": {
            "@type": "ItemList",
            "numberOfItems": ${sortedCities.length},
            "itemListElement": [
                ${topCities.map((city, i) => `{
                    "@type": "ListItem",
                    "position": ${i + 1},
                    "item": {
                        "@type": "City",
                        "name": "${city.city}",
                        "url": "https://dumpstermap.io/dumpster-rental/${createCitySlug(city.city, stateAbbr)}.html"
                    }
                }`).join(',\n                ')}
            ]
        },
        "breadcrumb": {
            "@type": "BreadcrumbList",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://dumpstermap.io/" },
                { "@type": "ListItem", "position": 2, "name": "${stateName}", "item": "https://dumpstermap.io/dumpster-rental/${stateAbbr.toLowerCase()}.html" }
            ]
        }
    }
    </script>
    
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        :root {
            --primary: #2563eb;
            --primary-dark: #1d4ed8;
            --secondary: #059669;
            --text: #1f2937;
            --text-light: #6b7280;
            --bg: #ffffff;
            --bg-light: #f9fafb;
            --border: #e5e7eb;
        }
        body {
            font-family: 'Inter', -apple-system, sans-serif;
            color: var(--text);
            line-height: 1.6;
            background: var(--bg-light);
        }
        header {
            background: var(--bg);
            border-bottom: 1px solid var(--border);
            padding: 1rem 2rem;
            position: sticky;
            top: 0;
            z-index: 100;
        }
        .header-content {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .logo {
            font-size: 1.5rem;
            font-weight: 800;
            color: var(--primary);
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .logo-icon {
            width: 40px;
            height: 40px;
            background: var(--primary);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 1.2rem;
        }
        .breadcrumbs {
            max-width: 1200px;
            margin: 1rem auto;
            padding: 0 2rem;
            font-size: 0.875rem;
            color: var(--text-light);
        }
        .breadcrumbs a {
            color: var(--primary);
            text-decoration: none;
        }
        .breadcrumbs a:hover {
            text-decoration: underline;
        }
        .hero {
            background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
            color: white;
            padding: 3rem 2rem;
            text-align: center;
        }
        .hero h1 {
            font-size: 2.5rem;
            margin-bottom: 1rem;
        }
        .hero p {
            font-size: 1.25rem;
            opacity: 0.9;
            max-width: 600px;
            margin: 0 auto;
        }
        .stats {
            display: flex;
            justify-content: center;
            gap: 3rem;
            margin-top: 2rem;
        }
        .stat {
            text-align: center;
        }
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
        }
        .stat-label {
            font-size: 0.875rem;
            opacity: 0.8;
        }
        main {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }
        .section-title {
            font-size: 1.5rem;
            font-weight: 700;
            margin-bottom: 1.5rem;
            color: var(--text);
        }
        .cities-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 1rem;
            margin-bottom: 3rem;
        }
        .city-card {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.25rem;
            text-decoration: none;
            color: var(--text);
            transition: all 0.2s;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .city-card:hover {
            border-color: var(--primary);
            box-shadow: 0 4px 12px rgba(37, 99, 235, 0.1);
            transform: translateY(-2px);
        }
        .city-name {
            font-weight: 600;
            font-size: 1.1rem;
        }
        .city-count {
            background: var(--bg-light);
            color: var(--text-light);
            padding: 0.25rem 0.75rem;
            border-radius: 20px;
            font-size: 0.875rem;
        }
        .cta-box {
            background: var(--bg);
            border: 2px solid var(--primary);
            border-radius: 16px;
            padding: 2rem;
            text-align: center;
            margin: 3rem 0;
        }
        .cta-box h2 {
            font-size: 1.5rem;
            margin-bottom: 0.5rem;
        }
        .cta-box p {
            color: var(--text-light);
            margin-bottom: 1.5rem;
        }
        .btn {
            display: inline-block;
            padding: 0.875rem 2rem;
            border-radius: 8px;
            font-weight: 600;
            text-decoration: none;
            transition: all 0.2s;
        }
        .btn-primary {
            background: var(--primary);
            color: white;
        }
        .btn-primary:hover {
            background: var(--primary-dark);
        }
        footer {
            background: var(--text);
            color: white;
            padding: 3rem 2rem;
            margin-top: 4rem;
        }
        .footer-content {
            max-width: 1200px;
            margin: 0 auto;
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 2rem;
        }
        .footer-section h3 {
            font-size: 1rem;
            margin-bottom: 1rem;
            color: white;
        }
        .footer-section a {
            display: block;
            color: rgba(255,255,255,0.7);
            text-decoration: none;
            margin-bottom: 0.5rem;
            font-size: 0.875rem;
        }
        .footer-section a:hover {
            color: white;
        }
        .footer-bottom {
            max-width: 1200px;
            margin: 2rem auto 0;
            padding-top: 2rem;
            border-top: 1px solid rgba(255,255,255,0.1);
            text-align: center;
            font-size: 0.875rem;
            color: rgba(255,255,255,0.5);
        }
        @media (max-width: 768px) {
            .hero h1 { font-size: 1.75rem; }
            .stats { flex-direction: column; gap: 1rem; }
            .cities-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <header>
        <div class="header-content">
            <a href="/" class="logo">
                <span class="logo-icon">🗑️</span>
                DumpsterMap
            </a>
            <a href="/" class="btn btn-primary">Find Dumpsters</a>
        </div>
    </header>
    
    <nav class="breadcrumbs">
        <a href="/">Home</a> › ${stateName}
    </nav>
    
    <section class="hero">
        <h1>Dumpster Rental in ${stateName}</h1>
        <p>Compare prices from local dumpster rental companies across ${stateName}. No phone calls needed.</p>
        <div class="stats">
            <div class="stat">
                <div class="stat-value">${totalProviders.toLocaleString()}</div>
                <div class="stat-label">Providers</div>
            </div>
            <div class="stat">
                <div class="stat-value">${sortedCities.length}</div>
                <div class="stat-label">Cities</div>
            </div>
        </div>
    </section>
    
    <main>
        <h2 class="section-title">Cities with Dumpster Rentals in ${stateName}</h2>
        <div class="cities-grid">
            ${sortedCities.map(city => `
            <a href="/dumpster-rental/${createCitySlug(city.city, stateAbbr)}.html" class="city-card">
                <span class="city-name">${city.city}</span>
                <span class="city-count">${city.providers} provider${city.providers === 1 ? '' : 's'}</span>
            </a>`).join('')}
        </div>
        
        <div class="cta-box">
            <h2>Need a Dumpster in ${stateName}?</h2>
            <p>Enter your zip code to see all available providers in your area with real-time pricing.</p>
            <a href="/" class="btn btn-primary">Get Free Quotes →</a>
        </div>
    </main>
    
    <footer>
        <div class="footer-content">
            <div class="footer-section">
                <h3>DumpsterMap</h3>
                <a href="/">Home</a>
                <a href="/sizes.html">Size Guide</a>
                <a href="/calculator.html">Price Calculator</a>
            </div>
            <div class="footer-section">
                <h3>Popular States</h3>
                <a href="/dumpster-rental/tx.html">Texas</a>
                <a href="/dumpster-rental/fl.html">Florida</a>
                <a href="/dumpster-rental/ca.html">California</a>
                <a href="/dumpster-rental/ny.html">New York</a>
            </div>
            <div class="footer-section">
                <h3>Resources</h3>
                <a href="/for-providers.html">For Providers</a>
                <a href="/contact.html">Contact Us</a>
            </div>
        </div>
        <div class="footer-bottom">
            © ${new Date().getFullYear()} DumpsterMap. All rights reserved.
        </div>
    </footer>
</body>
</html>`;
}

// Main execution
console.log('Generating state landing pages...\n');

const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Group providers by state and city
const states = {};
data.providers.forEach(p => {
    if (!p.state || !p.city) return;
    const stateAbbr = normalizeState(p.state);
    if (!stateAbbr) return; // Skip invalid states
    
    if (!states[stateAbbr]) states[stateAbbr] = {};
    if (!states[stateAbbr][p.city]) {
        states[stateAbbr][p.city] = { providers: 0 };
    }
    states[stateAbbr][p.city].providers++;
});

// Generate pages
let generated = 0;
for (const [stateAbbr, cities] of Object.entries(states)) {
    const stateName = stateNames[stateAbbr];
    if (!stateName) continue;
    
    const html = generateStatePage(stateAbbr, stateName, cities);
    const filename = `${stateAbbr.toLowerCase()}.html`;
    const filepath = path.join(outputDir, filename);
    
    fs.writeFileSync(filepath, html);
    console.log(`✓ ${filename} - ${stateName} (${Object.keys(cities).length} cities)`);
    generated++;
}

console.log(`\nGenerated ${generated} state pages.`);
