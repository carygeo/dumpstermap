#!/usr/bin/env node
/**
 * DumpsterMap Sitemap Generator
 * Generates sitemap.xml including all static pages and SEO city/state pages
 */

const fs = require('fs');
const path = require('path');

const baseUrl = 'https://dumpstermap.io';
const outputPath = path.join(__dirname, '../sitemap.xml');
const dumpsterRentalDir = path.join(__dirname, '../dumpster-rental');

// Static pages with priorities
const staticPages = [
    { path: '', changefreq: 'daily', priority: '1.0' },
    { path: 'results.html', changefreq: 'daily', priority: '0.9' },
    { path: 'calculator.html', changefreq: 'weekly', priority: '0.8' },
    { path: 'sizes.html', changefreq: 'weekly', priority: '0.8' },
    { path: 'map.html', changefreq: 'daily', priority: '0.8' },
    { path: 'faq.html', changefreq: 'weekly', priority: '0.8' },
    { path: 'how-to-rent-a-dumpster.html', changefreq: 'monthly', priority: '0.8' },
    { path: 'for-providers.html', changefreq: 'weekly', priority: '0.7' },
    { path: 'contact.html', changefreq: 'monthly', priority: '0.5' },
    { path: 'privacy.html', changefreq: 'yearly', priority: '0.3' },
    { path: 'terms.html', changefreq: 'yearly', priority: '0.3' },
];

// State names (full lowercase) - pages like "texas.html", "florida.html"
const stateNames = new Set([
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
    'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
    'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
    'minnesota','mississippi','missouri','montana','nebraska','nevada',
    'new-hampshire','new-jersey','new-mexico','new-york','north-carolina',
    'north-dakota','ohio','oklahoma','oregon','pennsylvania','rhode-island',
    'south-carolina','south-dakota','tennessee','texas','utah','vermont',
    'virginia','washington','west-virginia','wisconsin','wyoming','district-of-columbia'
]);

// Top metros get highest city priority (0.9) - based on provider counts
const topMetros = new Set([
    // Tier 1: 30+ providers
    'houston-tx', 'dallas-tx', 'orlando-fl', 'austin-tx', 'tampa-fl',
    'brooklyn-ny', 'jacksonville-fl', 'phoenix-az', 'miami-fl', 'san-jose-ca',
    'new-york-ny', 'los-angeles-ca', 'chicago-il', 'san-antonio-tx', 'san-diego-ca',
    'charlotte-nc', 'fort-lauderdale-fl', 'el-paso-tx',
    // Tier 2: 20-29 providers
    'las-vegas-nv', 'fort-worth-tx', 'detroit-mi', 'portland-or', 'colorado-springs-co',
    'louisville-ky', 'denver-co', 'bakersfield-ca', 'salt-lake-city-ut', 'new-orleans-la',
    'indianapolis-in', 'grand-rapids-mi',
    // Tier 3: important metros (15-19 providers or major search volume)
    'st-petersburg-fl', 'raleigh-nc', 'greensboro-nc', 'sacramento-ca', 'reno-nv',
    'oklahoma-city-ok', 'nashville-tn', 'midland-tx', 'lubbock-tx', 'knoxville-tn',
    'seattle-wa', 'boston-ma', 'atlanta-ga', 'philadelphia-pa', 'minneapolis-mn',
    'columbus-oh', 'san-francisco-ca', 'washington-dc'
]);

function generateSitemap() {
    const today = new Date().toISOString().split('T')[0];
    
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    
    // Add static pages
    for (const page of staticPages) {
        const loc = page.path ? `${baseUrl}/${page.path}` : baseUrl;
        xml += `  <url>\n`;
        xml += `    <loc>${loc}</loc>\n`;
        xml += `    <lastmod>${today}</lastmod>\n`;
        xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
        xml += `    <priority>${page.priority}</priority>\n`;
        xml += `  </url>\n`;
    }
    
    // Get all files in dumpster-rental directory
    const files = fs.readdirSync(dumpsterRentalDir)
        .filter(f => f.endsWith('.html'))
        .sort();
    
    // Separate state pages (2-letter) from city pages
    const statePages = [];
    const cityPages = [];
    
    for (const file of files) {
        const name = file.replace('.html', '');
        if (stateNames.has(name)) {
            statePages.push(file);
        } else {
            cityPages.push(file);
        }
    }
    
    // Add state pages (higher priority)
    for (const file of statePages) {
        xml += `  <url>\n`;
        xml += `    <loc>${baseUrl}/dumpster-rental/${file}</loc>\n`;
        xml += `    <lastmod>${today}</lastmod>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>0.85</priority>\n`;
        xml += `  </url>\n`;
    }
    
    // Add city pages (top metros get higher priority)
    for (const file of cityPages) {
        const name = file.replace('.html', '');
        const priority = topMetros.has(name) ? '0.9' : '0.8';
        xml += `  <url>\n`;
        xml += `    <loc>${baseUrl}/dumpster-rental/${file}</loc>\n`;
        xml += `    <lastmod>${today}</lastmod>\n`;
        xml += `    <changefreq>weekly</changefreq>\n`;
        xml += `    <priority>${priority}</priority>\n`;
        xml += `  </url>\n`;
    }
    
    xml += '</urlset>';
    
    fs.writeFileSync(outputPath, xml);
    console.log(`Generated sitemap.xml with:`);
    console.log(`  - ${staticPages.length} static pages`);
    console.log(`  - ${statePages.length} state pages`);
    console.log(`  - ${cityPages.length} city pages`);
    console.log(`  - ${staticPages.length + statePages.length + cityPages.length} total URLs`);
}

generateSitemap();
