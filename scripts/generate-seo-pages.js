#!/usr/bin/env node
/**
 * DumpsterMap SEO City Page Generator
 * 
 * Generates static city landing pages for SEO
 * Run: node scripts/generate-seo-pages.js
 */

const fs = require('fs');
const path = require('path');

// Read provider data
const dataPath = path.join(__dirname, '../data/providers.json');
const templatePath = path.join(__dirname, '../city.html');
const outputDir = path.join(__dirname, '../dumpster-rental');

// State abbreviation to full name mapping
const stateNames = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
    'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
    'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
    'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
    'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
    'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
    'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
    'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
    'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
    'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
    'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah',
    'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
    'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District Of Columbia'
};

// Reverse lookup: full state name -> abbreviation
const stateAbbreviations = Object.fromEntries(
    Object.entries(stateNames).map(([abbr, name]) => [name.toLowerCase(), abbr])
);

// Normalize state to abbreviation (handles both "NY" and "New York")
function normalizeState(state) {
    if (!state) return null;
    const upper = state.toUpperCase();
    if (stateNames[upper]) return upper;  // Already an abbreviation
    const lower = state.toLowerCase();
    return stateAbbreviations[lower] || null;
}

function createSlug(city, state) {
    const stateAbbr = normalizeState(state) || state;
    return `${city.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${stateAbbr.toLowerCase()}`;
}

function getCityStats(providers) {
    const count = providers.length;
    const withRating = providers.filter(p => p.rating && p.reviewCount > 0);
    const avgRating = withRating.length > 0 
        ? (withRating.reduce((sum, p) => sum + p.rating, 0) / withRating.length).toFixed(1)
        : null;
    const totalReviews = providers.reduce((sum, p) => sum + (p.reviewCount || 0), 0);
    
    // Get average lat/lng for centering map
    const withCoords = providers.filter(p => p.lat && p.lng);
    const avgLat = withCoords.length > 0
        ? withCoords.reduce((sum, p) => sum + p.lat, 0) / withCoords.length
        : null;
    const avgLng = withCoords.length > 0
        ? withCoords.reduce((sum, p) => sum + p.lng, 0) / withCoords.length
        : null;
    
    return { count, avgRating, totalReviews, avgLat, avgLng };
}

function generateCityPage(city, stateAbbr, providers, template) {
    const slug = createSlug(city, stateAbbr);
    const stateName = stateNames[stateAbbr.toUpperCase()] || stateAbbr;
    const stats = getCityStats(providers);
    const baseUrl = 'https://dumpstermap.io';
    const pageUrl = `${baseUrl}/dumpster-rental/${slug}.html`;
    
    // SEO-optimized title and description
    const pageTitle = `Dumpster Rental ${city}, ${stateAbbr} - Compare ${stats.count} Local Providers | DumpsterMap`;
    const metaDesc = `Compare ${stats.count} dumpster rental companies in ${city}, ${stateAbbr}. ${stats.avgRating ? `Avg rating: ${stats.avgRating}★.` : ''} Get instant quotes for roll-off dumpsters. No phone calls needed.`;
    
    // Create CITY_CONFIG injection
    const cityConfig = {
        city: city,
        state: stateAbbr,
        stateAbbr: stateAbbr,
        stateName: stateName,
        lat: stats.avgLat || 39.8283,
        lng: stats.avgLng || -98.5795,
        zoom: 11,
        providerCount: stats.count,
        avgRating: stats.avgRating,
        totalReviews: stats.totalReviews
    };
    
    // Pre-rendered Schema.org JSON-LD
    const schemaJson = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": pageUrl,
                "name": pageTitle,
                "description": metaDesc,
                "url": pageUrl,
                "breadcrumb": { "@id": `${pageUrl}#breadcrumb` }
            },
            {
                "@type": "BreadcrumbList",
                "@id": `${pageUrl}#breadcrumb`,
                "itemListElement": [
                    { "@type": "ListItem", "position": 1, "name": "Home", "item": baseUrl },
                    { "@type": "ListItem", "position": 2, "name": stateName, "item": `${baseUrl}/dumpster-rental/${stateAbbr.toLowerCase()}.html` },
                    { "@type": "ListItem", "position": 3, "name": `${city}, ${stateAbbr}`, "item": pageUrl }
                ]
            },
            {
                "@type": "Service",
                "name": `Dumpster Rental in ${city}, ${stateAbbr}`,
                "serviceType": "Dumpster Rental",
                "provider": {
                    "@type": "Organization",
                    "name": "DumpsterMap",
                    "url": baseUrl
                },
                "areaServed": {
                    "@type": "City",
                    "name": city,
                    "containedInPlace": { "@type": "State", "name": stateName }
                }
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": `How much does a dumpster rental cost in ${city}, ${stateAbbr}?`,
                        "acceptedAnswer": {
                            "@type": "Answer",
                            "text": `Dumpster rental prices in ${city} typically range from $250-$600 depending on size. 10-yard dumpsters start around $250-350, 20-yard at $300-450, and 30-40 yard at $400-600. Prices vary by provider and rental duration.`
                        }
                    },
                    {
                        "@type": "Question",
                        "name": `How many dumpster rental companies are in ${city}?`,
                        "acceptedAnswer": {
                            "@type": "Answer",
                            "text": `DumpsterMap lists ${stats.count} dumpster rental providers serving ${city}, ${stateAbbr}. ${stats.avgRating ? `These providers have an average rating of ${stats.avgRating} stars from ${stats.totalReviews} reviews.` : ''}`
                        }
                    }
                ]
            }
        ]
    };
    
    // Inject config at the start of the first script
    const configScript = `<script>window.CITY_CONFIG = ${JSON.stringify(cityConfig)};</script>`;
    
    // Modify template for this city with pre-rendered SEO content
    let html = template
        // Pre-render title tag
        .replace(/<title[^>]*>.*?<\/title>/i, `<title>${pageTitle}</title>`)
        // Pre-render meta description
        .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${metaDesc}">`)
        // Pre-render canonical URL
        .replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${pageUrl}">`)
        // Pre-render OG tags
        .replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${pageUrl}">`)
        .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${pageTitle}">`)
        .replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${metaDesc}">`)
        // Pre-render Schema.org JSON-LD
        .replace(/<script type="application\/ld\+json" id="schema-json">[\s\S]*?<\/script>/i, 
            `<script type="application/ld+json" id="schema-json">\n${JSON.stringify(schemaJson, null, 2)}\n    </script>`)
        // Insert config before first script
        .replace('<script src="https://unpkg.com/leaflet', `${configScript}\n    <script src="https://unpkg.com/leaflet`)
        // Update paths for subdirectory
        .replace(/href="index\.html"/g, 'href="../index.html"')
        .replace(/href="results\.html"/g, 'href="../results.html"')
        .replace(/src="app\.js"/g, 'src="../app.js"')
        .replace(/'data\/providers\.json'/g, "'../data/providers.json'")
        .replace(/"data\/providers\.json"/g, '"../data/providers.json"');
    
    return html;
}

function generateStatePage(stateAbbr, cities, providers, template) {
    const stateName = stateNames[stateAbbr.toUpperCase()] || stateAbbr;
    const slug = stateName.toLowerCase().replace(/\s+/g, '-');
    const stateProviders = providers.filter(p => 
        p.state && (p.state.toUpperCase() === stateAbbr.toUpperCase() || p.state.toLowerCase() === stateName.toLowerCase())
    );
    const stats = getCityStats(stateProviders);
    const baseUrl = 'https://dumpstermap.io';
    const pageUrl = `${baseUrl}/dumpster-rental/${slug}.html`;
    
    // SEO-optimized title and description for state pages
    const pageTitle = `Dumpster Rental in ${stateName} - Compare ${stats.count} Providers Statewide | DumpsterMap`;
    const metaDesc = `Find dumpster rental companies across ${stateName}. Compare ${stats.count} providers statewide. ${stats.avgRating ? `Avg rating: ${stats.avgRating}★.` : ''} Get instant quotes for any city in ${stateName}.`;
    
    const stateConfig = {
        city: '',
        state: stateAbbr,
        stateAbbr: stateAbbr,
        stateName: stateName,
        lat: stats.avgLat || 39.8283,
        lng: stats.avgLng || -98.5795,
        zoom: 6,
        providerCount: stats.count,
        avgRating: stats.avgRating,
        totalReviews: stats.totalReviews
    };
    
    // Pre-rendered Schema.org JSON-LD for state pages
    const schemaJson = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "WebPage",
                "@id": pageUrl,
                "name": pageTitle,
                "description": metaDesc,
                "url": pageUrl,
                "breadcrumb": { "@id": `${pageUrl}#breadcrumb` }
            },
            {
                "@type": "BreadcrumbList",
                "@id": `${pageUrl}#breadcrumb`,
                "itemListElement": [
                    { "@type": "ListItem", "position": 1, "name": "Home", "item": baseUrl },
                    { "@type": "ListItem", "position": 2, "name": stateName, "item": pageUrl }
                ]
            },
            {
                "@type": "Service",
                "name": `Dumpster Rental in ${stateName}`,
                "serviceType": "Dumpster Rental",
                "provider": {
                    "@type": "Organization",
                    "name": "DumpsterMap",
                    "url": baseUrl
                },
                "areaServed": {
                    "@type": "State",
                    "name": stateName
                }
            }
        ]
    };
    
    const configScript = `<script>window.CITY_CONFIG = ${JSON.stringify(stateConfig)};</script>`;
    
    let html = template
        // Pre-render title tag
        .replace(/<title[^>]*>.*?<\/title>/i, `<title>${pageTitle}</title>`)
        // Pre-render meta description  
        .replace(/<meta name="description"[^>]*>/i, `<meta name="description" content="${metaDesc}">`)
        // Pre-render canonical URL
        .replace(/<link rel="canonical"[^>]*>/i, `<link rel="canonical" href="${pageUrl}">`)
        // Pre-render OG tags
        .replace(/<meta property="og:url"[^>]*>/i, `<meta property="og:url" content="${pageUrl}">`)
        .replace(/<meta property="og:title"[^>]*>/i, `<meta property="og:title" content="${pageTitle}">`)
        .replace(/<meta property="og:description"[^>]*>/i, `<meta property="og:description" content="${metaDesc}">`)
        // Pre-render Schema.org JSON-LD
        .replace(/<script type="application\/ld\+json" id="schema-json">[\s\S]*?<\/script>/i,
            `<script type="application/ld+json" id="schema-json">\n${JSON.stringify(schemaJson, null, 2)}\n    </script>`)
        .replace('<script src="https://unpkg.com/leaflet', `${configScript}\n    <script src="https://unpkg.com/leaflet`)
        .replace(/href="index\.html"/g, 'href="../index.html"')
        .replace(/href="results\.html"/g, 'href="../results.html"')
        .replace(/src="app\.js"/g, 'src="../app.js"')
        .replace(/'data\/providers\.json'/g, "'../data/providers.json'")
        .replace(/"data\/providers\.json"/g, '"../data/providers.json"');
    
    return html;
}

function main() {
    console.log('🚀 DumpsterMap SEO Page Generator\n');
    
    // Load data
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const providers = data.providers;
    console.log(`📊 Loaded ${providers.length} providers`);
    
    // Load template
    const template = fs.readFileSync(templatePath, 'utf8');
    console.log(`📄 Loaded city template`);
    
    // Create output directory
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Group providers by city+state
    const cityGroups = {};
    const stateGroups = {};
    
    providers.forEach(p => {
        if (!p.city || !p.state) return;
        
        // Normalize state to abbreviation for consistent grouping
        const normalizedState = normalizeState(p.state);
        if (!normalizedState) return;  // Skip if we can't normalize the state
        
        const cityKey = `${p.city}|${normalizedState}`;
        if (!cityGroups[cityKey]) {
            cityGroups[cityKey] = [];
        }
        cityGroups[cityKey].push(p);
        
        if (!stateGroups[normalizedState]) {
            stateGroups[normalizedState] = [];
        }
        stateGroups[normalizedState].push(p);
    });
    
    console.log(`🏙️  Found ${Object.keys(cityGroups).length} unique cities`);
    console.log(`🗺️  Found ${Object.keys(stateGroups).length} states\n`);
    
    // Major metros that should always have pages (even with fewer providers)
    const majorMetros = new Set([
        'Pittsburgh|PA', 'Cleveland|OH', 'St. Louis|MO',
        'Baltimore|MD', 'Salt Lake City|UT', 'Hartford|CT',
        'Providence|RI', 'Buffalo|NY', 'Rochester|NY',
        'Richmond|VA', 'Norfolk|VA', 'Louisville|KY',
        'Memphis|TN', 'Nashville|TN', 'New Orleans|LA',
        'Oklahoma City|OK', 'Milwaukee|WI', 'Kansas City|MO',
        'Virginia Beach|VA', 'Raleigh|NC', 'Greensboro|NC'
    ]);
    
    // Filter cities with minimum providers (for SEO value)
    const minProviders = 3;
    const validCities = Object.entries(cityGroups)
        .filter(([key, list]) => list.length >= minProviders || majorMetros.has(key))
        .sort((a, b) => b[1].length - a[1].length);
    
    console.log(`✅ ${validCities.length} cities have ${minProviders}+ providers (or are major metros)\n`);
    
    // Generate all valid city pages (no limit - all cities with 3+ providers)
    const citiesToGenerate = validCities;
    
    let generated = 0;
    citiesToGenerate.forEach(([key, list]) => {
        const [city, state] = key.split('|');
        const slug = createSlug(city, state);
        const html = generateCityPage(city, state, list, template);
        const filePath = path.join(outputDir, `${slug}.html`);
        fs.writeFileSync(filePath, html);
        generated++;
        if (generated % 10 === 0) {
            console.log(`   Generated ${generated} city pages...`);
        }
    });
    
    console.log(`\n✅ Generated ${generated} city pages`);
    
    // Generate state pages
    let statesGenerated = 0;
    Object.entries(stateGroups).forEach(([stateAbbr, list]) => {
        if (list.length < 5) return;  // Skip states with few providers
        
        const stateName = stateNames[stateAbbr];
        if (!stateName) return;  // Skip if we can't find the state name
        
        const stateSlug = stateName.toLowerCase().replace(/\s+/g, '-');
        
        const cities = Object.entries(cityGroups)
            .filter(([key]) => key.endsWith(`|${stateAbbr}`))
            .map(([key]) => key.split('|')[0]);
        
        const html = generateStatePage(stateAbbr, cities, providers, template);
        const filePath = path.join(outputDir, `${stateSlug}.html`);
        fs.writeFileSync(filePath, html);
        statesGenerated++;
    });
    
    console.log(`✅ Generated ${statesGenerated} state pages`);
    
    // Generate sitemap
    const sitemapEntries = [];
    const baseUrl = 'https://dumpstermap.io';
    
    // Main pages
    sitemapEntries.push({ loc: baseUrl, priority: '1.0', changefreq: 'daily' });
    sitemapEntries.push({ loc: `${baseUrl}/results.html`, priority: '0.9', changefreq: 'daily' });
    
    // City pages
    citiesToGenerate.forEach(([key]) => {
        const [city, state] = key.split('|');
        const slug = createSlug(city, state);
        sitemapEntries.push({ 
            loc: `${baseUrl}/dumpster-rental/${slug}.html`, 
            priority: '0.8', 
            changefreq: 'weekly' 
        });
    });
    
    // State pages
    Object.keys(stateGroups).forEach(stateAbbr => {
        if (stateGroups[stateAbbr].length >= 5) {
            const stateName = stateNames[stateAbbr];
            if (!stateName) return;
            const stateSlug = stateName.toLowerCase().replace(/\s+/g, '-');
            sitemapEntries.push({ 
                loc: `${baseUrl}/dumpster-rental/${stateSlug}.html`, 
                priority: '0.7', 
                changefreq: 'weekly' 
            });
        }
    });
    
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.map(e => `  <url>
    <loc>${e.loc}</loc>
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
    
    fs.writeFileSync(path.join(__dirname, '../sitemap.xml'), sitemap);
    console.log(`\n✅ Generated sitemap.xml with ${sitemapEntries.length} URLs`);
    
    // Summary
    console.log(`\n📁 Output: ${outputDir}/`);
    console.log(`\n🎉 Done! Generated:`);
    console.log(`   - ${generated} city pages`);
    console.log(`   - ${statesGenerated} state pages`);
    console.log(`   - 1 sitemap.xml`);
    
    // Top cities
    console.log(`\n📈 Top 10 cities by provider count:`);
    citiesToGenerate.slice(0, 10).forEach(([key, list], i) => {
        const [city, state] = key.split('|');
        console.log(`   ${i + 1}. ${city}, ${state} (${list.length} providers)`);
    });
}

main();
