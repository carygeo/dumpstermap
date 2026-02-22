// DumpsterMap.io - Main Application JavaScript

// Provider data (loaded from JSON + API)
let providers = [];
let filteredProviders = [];

// Load provider data from both static JSON and registered providers API
async function loadProviders() {
    try {
        // Fetch both sources in parallel
        const [staticResponse, registeredResponse] = await Promise.all([
            fetch('data/providers.json'),
            fetch('/api/providers/directory?limit=50').catch(() => null)
        ]);
        
        const staticData = await staticResponse.json();
        const staticProviders = staticData.providers || [];
        
        // Transform registered providers to match static format
        let registeredProviders = [];
        if (registeredResponse && registeredResponse.ok) {
            const regData = await registeredResponse.json();
            registeredProviders = (regData.providers || []).map(p => ({
                id: `reg-${p.id}`,
                name: p.companyName,
                address: p.address,
                city: p.location?.split(',')[0]?.trim() || '',
                state: p.location?.split(',')[1]?.trim() || '',
                zip: p.address?.match(/\d{5}/)?.[0] || '',
                phone: p.phone,
                website: p.website,
                photo: p.photo,  // Provider photo from API
                verified: p.verified,
                featured: p.featured,
                priority: p.featured ? 1 : 0,  // For card styling
                isRegistered: true,
                // Registered providers show at top with high rating
                rating: p.featured ? 5.0 : (p.verified ? 4.8 : 4.5),
                reviewCount: 0,
                category: 'Dumpster rental service',
                // Use geocoded coordinates from API
                lat: p.lat || null,
                lng: p.lng || null
            }));
        }
        
        // Merge: registered providers first, then static
        providers = [...registeredProviders, ...staticProviders];
        console.log(`Loaded ${registeredProviders.length} registered + ${staticProviders.length} static providers`);
        return providers;
    } catch (error) {
        console.error('Error loading providers:', error);
        return [];
    }
}

// Search providers by location
function searchProviders(query) {
    if (!query) return providers;
    
    const q = query.toLowerCase();
    return providers.filter(p => 
        (p.city && p.city.toLowerCase().includes(q)) ||
        (p.state && p.state.toLowerCase().includes(q)) ||
        (p.zip && p.zip.includes(q)) ||
        (p.name && p.name.toLowerCase().includes(q))
    );
}

// Sort providers
function sortProviders(providerList, sortBy) {
    const sorted = [...providerList];
    
    switch(sortBy) {
        case 'rating':
            return sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
        case 'reviews':
            return sorted.sort((a, b) => (b.reviewCount || 0) - (a.reviewCount || 0));
        case 'name':
            return sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        default:
            return sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    }
}

// Filter by minimum rating
function filterByRating(providerList, minRating) {
    if (!minRating || minRating === 'all') return providerList;
    return providerList.filter(p => (p.rating || 0) >= parseFloat(minRating));
}

// Generate star rating HTML
function getStarsHtml(rating) {
    if (!rating) return '<span class="no-rating">No rating</span>';
    
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

// Get provider image (photo, logo, or fallback)
function getProviderImage(provider) {
    if (provider.photo) return provider.photo;
    if (provider.logo) return provider.logo;
    // Fallback to colored initial
    return null;
}

// Render provider card - Clickable to provider detail page
function renderProviderCard(provider) {
    const image = getProviderImage(provider);
    const reviewCount = provider.reviewCount || 0;
    // Only show rating if there are actual reviews
    const hasValidRating = reviewCount > 0 && provider.rating;
    const rating = hasValidRating ? provider.rating : 0;
    
    const imageHtml = image 
        ? `<img src="${image}" alt="${provider.name}" class="provider-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="provider-logo-fallback" style="display:none;">${(provider.name || '?').charAt(0)}</div>`
        : `<div class="provider-logo-fallback">${(provider.name || '?').charAt(0)}</div>`;
    
    const ratingHtml = hasValidRating 
        ? `<div class="provider-rating">
               <span class="stars">${getStarsHtml(rating)}</span>
               <span class="rating-value">${rating.toFixed(1)}</span>
               <span class="rating-count">(${reviewCount.toLocaleString()} reviews)</span>
           </div>`
        : `<div class="provider-rating"><span class="no-rating">New provider</span></div>`;
    
    // Badges based on rating/reviews (only if they have real reviews)
    const badges = [];
    
    // Premium badges (from DumpsterMap partnership)
    if (provider.verified) badges.push('<span class="badge badge-verified">✅ Verified</span>');
    if (provider.priority) badges.push('<span class="badge badge-priority">🔝 Featured</span>');
    
    // Organic badges based on performance
    if (hasValidRating && rating >= 4.8 && reviewCount >= 50) badges.push('<span class="badge badge-top">⭐ Top Rated</span>');
    if (reviewCount >= 100) badges.push('<span class="badge badge-popular">🔥 Popular</span>');
    
    // Store provider data for quote form (JSON escaped)
    const providerData = JSON.stringify(provider).replace(/'/g, "\\'").replace(/"/g, '&quot;');
    
    // Format category for display
    const categoryDisplay = provider.category ? provider.category.replace(' service', '').replace(' contractor', '') : '';
    
    // Provider detail page URL
    const providerUrl = `provider.html?id=${encodeURIComponent(provider.id)}&slug=${encodeURIComponent(provider.slug || '')}`;
    const priorityClass = provider.priority ? ' priority-card' : '';
    
    return `
        <div class="provider-card${priorityClass}" data-id="${provider.id}" data-category="${provider.category || ''}">
            <a href="${providerUrl}" class="provider-header provider-link">
                <div class="provider-image-container">
                    ${imageHtml}
                </div>
                <div class="provider-info">
                    <h3>${provider.name || 'Local Provider'}</h3>
                    <div class="provider-location">📍 ${provider.city || ''}${provider.city && provider.state ? ', ' : ''}${provider.state || ''}</div>
                    ${categoryDisplay ? `<div class="provider-category-tag">${categoryDisplay}</div>` : ''}
                    ${ratingHtml}
                    ${badges.length ? `<div class="provider-badges">${badges.join('')}</div>` : ''}
                </div>
            </a>
            <div class="provider-body">
                <div class="provider-actions">
                    <a href="${providerUrl}" class="btn btn-secondary" style="flex:1;text-align:center;">
                        View Details
                    </a>
                    <button class="btn btn-primary btn-quote" onclick='event.stopPropagation();openQuoteModal(${providerData})' style="flex:1;">
                        Get Quote →
                    </button>
                </div>
            </div>
        </div>
    `;
}

// Render results grid
function renderResults(providerList) {
    const container = document.getElementById('results-container');
    if (!container) return;
    
    if (providerList.length === 0) {
        container.innerHTML = `
            <div class="no-results">
                <h3>No providers found</h3>
                <p>Try a different location or adjust your filters.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = providerList.map(p => renderProviderCard(p)).join('');
}

// Update results count
function updateResultsCount(count, location) {
    const countEl = document.getElementById('results-count');
    if (countEl) {
        countEl.textContent = `${count.toLocaleString()} provider${count !== 1 ? 's' : ''} found${location ? ' near ' + location : ''}`;
    }
}

// Geocode location and return coordinates
async function geocodeLocation(query) {
    try {
        const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&countrycodes=us&limit=1`);
        const data = await response.json();
        if (data.length > 0) {
            return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), name: data[0].display_name };
        }
    } catch (e) {
        console.error('Geocoding error:', e);
    }
    return null;
}

// Initialize results page - show ALL providers, search just navigates map
async function initResultsPage() {
    await loadProviders();
    
    const params = new URLSearchParams(window.location.search);
    const location = params.get('location') || params.get('zip') || '';
    const sort = params.get('sort') || 'rating';
    const minRating = params.get('rating') || 'all';
    
    // Always show ALL providers, just filter by rating if set
    let results = filterByRating(providers, minRating);
    results = sortProviders(results, sort);
    
    // Show top 200 in the list for performance
    const displayResults = results.slice(0, 200);
    
    updateResultsCount(results.length, location);
    renderResults(displayResults);
    
    // Store search location for map to use
    window.searchLocation = location;
    
    // Set up filter handlers
    const sortSelect = document.getElementById('sort-select');
    const ratingSelect = document.getElementById('rating-select');
    const searchInput = document.getElementById('search-input');
    
    if (sortSelect) {
        sortSelect.value = sort;
        sortSelect.addEventListener('change', () => {
            const url = new URL(window.location);
            url.searchParams.set('sort', sortSelect.value);
            window.location = url;
        });
    }
    
    if (ratingSelect) {
        ratingSelect.value = minRating;
        ratingSelect.addEventListener('change', () => {
            const url = new URL(window.location);
            url.searchParams.set('rating', ratingSelect.value);
            window.location = url;
        });
    }
    
    if (searchInput) {
        searchInput.value = location;
        // Allow re-searching from results page
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const newLoc = searchInput.value.trim();
                if (newLoc) {
                    window.location = `results.html?location=${encodeURIComponent(newLoc)}`;
                }
            }
        });
    }
}

// Initialize home page search
function initHomePage() {
    const searchBtn = document.querySelector('.search-btn');
    const zipInput = document.getElementById('zip-input');
    
    if (searchBtn && zipInput) {
        searchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const location = zipInput.value.trim();
            if (location) {
                window.location = `results.html?location=${encodeURIComponent(location)}`;
            } else {
                alert('Please enter a ZIP code or city');
            }
        });
        
        // Also handle Enter key
        zipInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchBtn.click();
            }
        });
    }
}

// Auto-init based on page
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('results-container')) {
        initResultsPage();
    } else {
        initHomePage();
    }
});
