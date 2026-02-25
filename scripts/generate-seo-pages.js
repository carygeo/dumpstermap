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
    
    // Inject config at the start of the first script
    const configScript = `<script>window.CITY_CONFIG = ${JSON.stringify(cityConfig)};</script>`;
    
    // Modify template for this city
    let html = template
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
    const slug = stateAbbr.toLowerCase();
    const stateName = stateNames[stateAbbr.toUpperCase()] || stateAbbr;
    const stateProviders = providers.filter(p => 
        p.state && (p.state.toUpperCase() === stateAbbr.toUpperCase() || p.state.toLowerCase() === stateName.toLowerCase())
    );
    const stats = getCityStats(stateProviders);
    
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
    
    const configScript = `<script>window.CITY_CONFIG = ${JSON.stringify(stateConfig)};</script>`;
    
    let html = template
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
        
        const cityKey = `${p.city}|${p.state}`;
        if (!cityGroups[cityKey]) {
            cityGroups[cityKey] = [];
        }
        cityGroups[cityKey].push(p);
        
        const stateKey = p.state.toUpperCase();
        if (!stateGroups[stateKey]) {
            stateGroups[stateKey] = [];
        }
        stateGroups[stateKey].push(p);
    });
    
    console.log(`🏙️  Found ${Object.keys(cityGroups).length} unique cities`);
    console.log(`🗺️  Found ${Object.keys(stateGroups).length} states\n`);
    
    // Filter cities with minimum providers (for SEO value)
    const minProviders = 3;
    const validCities = Object.entries(cityGroups)
        .filter(([, list]) => list.length >= minProviders)
        .sort((a, b) => b[1].length - a[1].length);
    
    console.log(`✅ ${validCities.length} cities have ${minProviders}+ providers\n`);
    
    // Generate top 100 city pages (can increase later)
    const maxCities = 100;
    const citiesToGenerate = validCities.slice(0, maxCities);
    
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
        
        const cities = Object.entries(cityGroups)
            .filter(([key]) => key.endsWith(`|${stateAbbr}`))
            .map(([key]) => key.split('|')[0]);
        
        const html = generateStatePage(stateAbbr, cities, providers, template);
        const filePath = path.join(outputDir, `${stateAbbr.toLowerCase()}.html`);
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
            sitemapEntries.push({ 
                loc: `${baseUrl}/dumpster-rental/${stateAbbr.toLowerCase()}.html`, 
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
