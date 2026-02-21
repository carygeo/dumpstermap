// RollOffCompare - Main Application JavaScript

// Provider data (loaded from JSON)
let providers = [];
let filteredProviders = [];

// Load provider data
async function loadProviders() {
    try {
        const response = await fetch('data/providers.json');
        const data = await response.json();
        providers = data.providers;
        return providers;
    } catch (error) {
        console.error('Error loading providers:', error);
        return [];
    }
}

// ZIP code validation (Florida ZIP codes)
function isValidZip(zip) {
    const zipRegex = /^\d{5}$/;
    if (!zipRegex.test(zip)) return false;
    
    // Florida ZIP codes range (approximate)
    const zipNum = parseInt(zip);
    return (zipNum >= 32003 && zipNum <= 34997);
}

// Get providers by service area
function getProvidersByZip(zip) {
    // For demo, match based on nearby cities
    const zipToCities = {
        '34102': ['Naples', 'Marco Island', 'Bonita Springs'],
        '34103': ['Naples', 'Marco Island', 'Bonita Springs'],
        '34104': ['Naples', 'Golden Gate', 'Estero'],
        '34108': ['Naples', 'Bonita Springs', 'Estero'],
        '34110': ['Naples', 'Bonita Springs'],
        '33901': ['Fort Myers', 'Cape Coral', 'Lehigh Acres'],
        '33907': ['Fort Myers', 'Cape Coral', 'Estero'],
        '33904': ['Cape Coral', 'Fort Myers', 'Pine Island'],
        '33991': ['Cape Coral', 'Fort Myers', 'North Fort Myers'],
        '33936': ['Lehigh Acres', 'Fort Myers', 'Alva'],
        '34135': ['Bonita Springs', 'Naples', 'Estero'],
        '33957': ['Sanibel', 'Captiva', 'Fort Myers Beach']
    };
    
    const cities = zipToCities[zip] || ['Naples', 'Fort Myers', 'Cape Coral'];
    
    return providers.filter(p => 
        p.serviceAreas.some(area => 
            cities.some(city => area.toLowerCase().includes(city.toLowerCase()))
        )
    );
}

// Sort providers
function sortProviders(providers, sortBy) {
    const sorted = [...providers];
    
    switch(sortBy) {
        case 'price-low':
            return sorted.sort((a, b) => a.sizes[0].price - b.sizes[0].price);
        case 'price-high':
            return sorted.sort((a, b) => b.sizes[0].price - a.sizes[0].price);
        case 'rating':
            return sorted.sort((a, b) => b.rating - a.rating);
        case 'reviews':
            return sorted.sort((a, b) => b.reviewCount - a.reviewCount);
        default:
            return sorted.sort((a, b) => b.rating - a.rating);
    }
}

// Filter providers by size
function filterBySize(providers, size) {
    if (!size || size === 'all') return providers;
    
    const sizeNum = parseInt(size);
    return providers.filter(p => 
        p.sizes.some(s => s.size === sizeNum)
    );
}

// Generate star rating HTML
function getStarsHtml(rating) {
    const fullStars = Math.floor(rating);
    const hasHalf = rating % 1 >= 0.5;
    let html = '';
    
    for (let i = 0; i < fullStars; i++) {
        html += '★';
    }
    if (hasHalf) html += '½';
    for (let i = fullStars + (hasHalf ? 1 : 0); i < 5; i++) {
        html += '☆';
    }
    
    return html;
}

// Get price for specific size
function getPriceForSize(provider, size) {
    const sizeData = provider.sizes.find(s => s.size === parseInt(size));
    return sizeData ? sizeData.price : provider.sizes[0].price;
}

// Render provider card
function renderProviderCard(provider, selectedSize) {
    const price = selectedSize ? getPriceForSize(provider, selectedSize) : provider.sizes[0].price;
    const sizeLabel = selectedSize || provider.sizes[0].size;
    
    const sizeTags = provider.sizes.map(s => 
        `<span class="size-tag${s.size === parseInt(selectedSize) ? ' active' : ''}">${s.size} yd</span>`
    ).join('');
    
    const features = provider.features.slice(0, 2).map(f => 
        `<span class="feature"><span class="feature-icon">✓</span> ${f}</span>`
    ).join('');
    
    return `
        <div class="provider-card" data-id="${provider.id}">
            <div class="provider-header">
                <div class="provider-logo">${provider.name.charAt(0)}</div>
                <div class="provider-info">
                    <h3>${provider.name}</h3>
                    <div class="provider-location">📍 ${provider.city}, ${provider.state}</div>
                    <div class="provider-rating">
                        <span class="stars">${getStarsHtml(provider.rating)}</span>
                        <span class="rating-count">(${provider.reviewCount} reviews)</span>
                    </div>
                </div>
            </div>
            <div class="provider-body">
                <div class="provider-sizes">${sizeTags}</div>
                <div class="provider-price">
                    <span class="price-label">Starting at</span>
                    <span class="price-value">$${price}</span>
                </div>
                <div class="provider-features">${features}</div>
                <div class="provider-actions">
                    <a href="provider.html?id=${provider.id}" class="btn btn-primary">Get Quote</a>
                    <a href="provider.html?id=${provider.id}" class="btn btn-secondary">View Profile</a>
                </div>
            </div>
        </div>
    `;
}

// Render results
function renderResults(providers, selectedSize) {
    const container = document.getElementById('results-container');
    if (!container) return;
    
    if (providers.length === 0) {
        container.innerHTML = `
            <div class="no-results">
                <h3>No providers found in your area</h3>
                <p>Try a different ZIP code or expand your search radius.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = providers.map(p => renderProviderCard(p, selectedSize)).join('');
}

// Update results count
function updateResultsCount(count, zip) {
    const countEl = document.getElementById('results-count');
    if (countEl) {
        countEl.textContent = `${count} hauler${count !== 1 ? 's' : ''} found near ${zip}`;
    }
}

// Handle search form submission
function handleSearch(event) {
    if (event) event.preventDefault();
    
    const zipInput = document.getElementById('zip-input') || document.querySelector('input[type="text"]');
    const projectSelect = document.getElementById('project-type') || document.querySelector('select');
    
    const zip = zipInput?.value?.trim();
    const project = projectSelect?.value;
    
    if (!zip) {
        alert('Please enter a ZIP code');
        return;
    }
    
    if (!isValidZip(zip)) {
        alert('Please enter a valid Florida ZIP code');
        return;
    }
    
    // Store search params and redirect to results
    sessionStorage.setItem('searchZip', zip);
    sessionStorage.setItem('searchProject', project || '');
    
    window.location.href = `map.html?zip=${zip}&project=${encodeURIComponent(project || '')}`;
}

// Initialize results page
async function initResultsPage() {
    await loadProviders();
    
    const params = new URLSearchParams(window.location.search);
    const zip = params.get('zip') || sessionStorage.getItem('searchZip') || '34102';
    const project = params.get('project') || sessionStorage.getItem('searchProject') || '';
    const size = params.get('size') || 'all';
    const sort = params.get('sort') || 'rating';
    
    // Update form values
    const zipDisplay = document.getElementById('zip-display');
    if (zipDisplay) zipDisplay.textContent = zip;
    
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) sortSelect.value = sort;
    
    const sizeFilter = document.getElementById('size-filter');
    if (sizeFilter) sizeFilter.value = size;
    
    // Get and filter providers
    let results = getProvidersByZip(zip);
    results = filterBySize(results, size);
    results = sortProviders(results, sort);
    
    filteredProviders = results;
    
    updateResultsCount(results.length, zip);
    renderResults(results, size !== 'all' ? size : null);
}

// Handle filter changes
function handleFilterChange() {
    const params = new URLSearchParams(window.location.search);
    const zip = params.get('zip') || '34102';
    
    const sortSelect = document.getElementById('sort-select');
    const sizeFilter = document.getElementById('size-filter');
    
    const sort = sortSelect?.value || 'rating';
    const size = sizeFilter?.value || 'all';
    
    let results = getProvidersByZip(zip);
    results = filterBySize(results, size);
    results = sortProviders(results, sort);
    
    filteredProviders = results;
    
    updateResultsCount(results.length, zip);
    renderResults(results, size !== 'all' ? size : null);
    
    // Update URL without reload
    const newUrl = `results.html?zip=${zip}&sort=${sort}&size=${size}`;
    window.history.replaceState({}, '', newUrl);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    // Check if we're on results page
    if (document.getElementById('results-container')) {
        initResultsPage();
    }
    
    // Attach search handler
    const searchForm = document.getElementById('search-form');
    if (searchForm) {
        searchForm.addEventListener('submit', handleSearch);
    }
    
    const searchBtn = document.querySelector('.search-btn');
    if (searchBtn) {
        searchBtn.addEventListener('click', handleSearch);
    }
    
    // Attach filter handlers
    const sortSelect = document.getElementById('sort-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', handleFilterChange);
    }
    
    const sizeFilter = document.getElementById('size-filter');
    if (sizeFilter) {
        sizeFilter.addEventListener('change', handleFilterChange);
    }
});

// Export for testing
if (typeof module !== 'undefined') {
    module.exports = { loadProviders, getProvidersByZip, sortProviders, filterBySize };
}
