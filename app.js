// DumpsterMap.io - Main Application JavaScript

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

// Render provider card with REAL data
function renderProviderCard(provider) {
    const image = getProviderImage(provider);
    const rating = provider.rating || 0;
    const reviewCount = provider.reviewCount || 0;
    
    const imageHtml = image 
        ? `<img src="${image}" alt="${provider.name}" class="provider-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
           <div class="provider-logo-fallback" style="display:none;">${(provider.name || '?').charAt(0)}</div>`
        : `<div class="provider-logo-fallback">${(provider.name || '?').charAt(0)}</div>`;
    
    const ratingHtml = rating > 0 
        ? `<div class="provider-rating">
               <span class="stars">${getStarsHtml(rating)}</span>
               <span class="rating-value">${rating.toFixed(1)}</span>
               <span class="rating-count">(${reviewCount.toLocaleString()} reviews)</span>
           </div>`
        : `<div class="provider-rating"><span class="no-rating">No reviews yet</span></div>`;
    
    const phoneHtml = provider.phone 
        ? `<a href="tel:${provider.phone}" class="btn btn-primary">📞 Call Now</a>`
        : '';
    
    const websiteHtml = provider.website 
        ? `<a href="${provider.website}" target="_blank" class="btn btn-secondary">🌐 Website</a>`
        : '';
    
    const reviewsLinkHtml = provider.reviewsLink
        ? `<a href="${provider.reviewsLink}" target="_blank" class="reviews-link">See all reviews →</a>`
        : '';
    
    return `
        <div class="provider-card" data-id="${provider.id}">
            <div class="provider-header">
                <div class="provider-image-container">
                    ${imageHtml}
                </div>
                <div class="provider-info">
                    <h3>${provider.name || 'Unknown Provider'}</h3>
                    <div class="provider-location">📍 ${provider.city || ''}${provider.city && provider.state ? ', ' : ''}${provider.state || ''}</div>
                    ${ratingHtml}
                    ${reviewsLinkHtml}
                </div>
            </div>
            <div class="provider-body">
                ${provider.category ? `<div class="provider-category">${provider.category}</div>` : ''}
                <div class="provider-actions">
                    ${phoneHtml}
                    ${websiteHtml}
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

// Initialize results page
async function initResultsPage() {
    await loadProviders();
    
    const params = new URLSearchParams(window.location.search);
    const location = params.get('location') || params.get('zip') || '';
    const sort = params.get('sort') || 'rating';
    const minRating = params.get('rating') || 'all';
    
    let results = location ? searchProviders(location) : providers;
    results = filterByRating(results, minRating);
    results = sortProviders(results, sort);
    
    // Limit to first 100 for performance
    const displayResults = results.slice(0, 100);
    
    updateResultsCount(results.length, location);
    renderResults(displayResults);
    
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
