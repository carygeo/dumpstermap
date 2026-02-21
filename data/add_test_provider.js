const fs = require('fs');

const data = JSON.parse(fs.readFileSync('providers.json', 'utf8'));

// Test provider for Naples, FL with verified and priority flags
const testProvider = {
  "id": "test-premium-provider-001",
  "name": "Naples Premium Dumpsters",
  "slug": "naples-premium-dumpsters",
  "city": "Naples",
  "state": "Florida",
  "zip": "34102",
  "address": "1234 Gulf Shore Blvd, Naples, FL 34102",
  "phone": "+1 239-555-0123",
  "website": "https://example.com/naples-dumpsters",
  "lat": 26.1420,
  "lng": -81.7948,
  "rating": 4.9,
  "reviewCount": 87,
  "photo": "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800",
  "logo": null,
  "category": "Dumpster rental service",
  "googleMapsLink": "https://www.google.com/maps/place/Naples+FL",
  "reviewsLink": null,
  "verified": true,
  "priority": true
};

// Add to beginning of providers array
data.providers.unshift(testProvider);

fs.writeFileSync('providers.json', JSON.stringify(data));
console.log('Added test provider. Total providers:', data.providers.length);
