#!/usr/bin/env python3
"""
Yelp Scraper for DumpsterMap
Scrapes dumpster rental and related businesses from Yelp Fusion API
"""
import os
import json
import time
import requests
from datetime import datetime
from pathlib import Path

# Yelp Fusion API
YELP_API_KEY = os.environ.get('YELP_API_KEY', '')
YELP_API_URL = 'https://api.yelp.com/v3/businesses/search'
YELP_DETAIL_URL = 'https://api.yelp.com/v3/businesses/{}'

# Search terms for dumpster-related businesses
SEARCH_TERMS = [
    'dumpster rental',
    'roll off dumpster',
    'waste management',
    'junk removal',
    'debris removal',
    'garbage collection',
    'container rental',
    'construction dumpster',
]

# Major US cities to search (top 100 by population)
MAJOR_CITIES = [
    # Top 50
    ('New York', 'NY'), ('Los Angeles', 'CA'), ('Chicago', 'IL'), ('Houston', 'TX'),
    ('Phoenix', 'AZ'), ('Philadelphia', 'PA'), ('San Antonio', 'TX'), ('San Diego', 'CA'),
    ('Dallas', 'TX'), ('San Jose', 'CA'), ('Austin', 'TX'), ('Jacksonville', 'FL'),
    ('Fort Worth', 'TX'), ('Columbus', 'OH'), ('Indianapolis', 'IN'), ('Charlotte', 'NC'),
    ('San Francisco', 'CA'), ('Seattle', 'WA'), ('Denver', 'CO'), ('Washington', 'DC'),
    ('Nashville', 'TN'), ('Oklahoma City', 'OK'), ('Boston', 'MA'), ('El Paso', 'TX'),
    ('Portland', 'OR'), ('Las Vegas', 'NV'), ('Detroit', 'MI'), ('Memphis', 'TN'),
    ('Louisville', 'KY'), ('Baltimore', 'MD'), ('Milwaukee', 'WI'), ('Albuquerque', 'NM'),
    ('Tucson', 'AZ'), ('Fresno', 'CA'), ('Sacramento', 'CA'), ('Kansas City', 'MO'),
    ('Mesa', 'AZ'), ('Atlanta', 'GA'), ('Omaha', 'NE'), ('Colorado Springs', 'CO'),
    ('Raleigh', 'NC'), ('Long Beach', 'CA'), ('Virginia Beach', 'VA'), ('Miami', 'FL'),
    ('Oakland', 'CA'), ('Minneapolis', 'MN'), ('Tampa', 'FL'), ('Tulsa', 'OK'),
    ('Arlington', 'TX'), ('New Orleans', 'LA'),
    # 51-100
    ('Wichita', 'KS'), ('Cleveland', 'OH'), ('Bakersfield', 'CA'), ('Aurora', 'CO'),
    ('Anaheim', 'CA'), ('Honolulu', 'HI'), ('Santa Ana', 'CA'), ('Riverside', 'CA'),
    ('Corpus Christi', 'TX'), ('Lexington', 'KY'), ('Stockton', 'CA'), ('St. Louis', 'MO'),
    ('Pittsburgh', 'PA'), ('Saint Paul', 'MN'), ('Anchorage', 'AK'), ('Cincinnati', 'OH'),
    ('Henderson', 'NV'), ('Greensboro', 'NC'), ('Plano', 'TX'), ('Newark', 'NJ'),
    ('Lincoln', 'NE'), ('Orlando', 'FL'), ('Irvine', 'CA'), ('Toledo', 'OH'),
    ('Jersey City', 'NJ'), ('Chula Vista', 'CA'), ('Durham', 'NC'), ('Fort Wayne', 'IN'),
    ('St. Petersburg', 'FL'), ('Laredo', 'TX'), ('Buffalo', 'NY'), ('Madison', 'WI'),
    ('Lubbock', 'TX'), ('Chandler', 'AZ'), ('Scottsdale', 'AZ'), ('Reno', 'NV'),
    ('Glendale', 'AZ'), ('Norfolk', 'VA'), ('Winston-Salem', 'NC'), ('North Las Vegas', 'NV'),
    ('Gilbert', 'AZ'), ('Irving', 'TX'), ('Hialeah', 'FL'), ('Garland', 'TX'),
    ('Fremont', 'CA'), ('Boise', 'ID'), ('Richmond', 'VA'), ('Baton Rouge', 'LA'),
    ('Des Moines', 'IA'), ('San Bernardino', 'CA'),
]

class YelpScraper:
    def __init__(self, api_key):
        self.api_key = api_key
        self.headers = {'Authorization': f'Bearer {api_key}'}
        self.providers = []
        self.seen_ids = set()
        
    def search_businesses(self, term, location, limit=50):
        """Search Yelp for businesses"""
        params = {
            'term': term,
            'location': location,
            'limit': limit,
            'sort_by': 'rating',
        }
        
        try:
            resp = requests.get(YELP_API_URL, headers=self.headers, params=params, timeout=10)
            if resp.status_code == 200:
                return resp.json().get('businesses', [])
            elif resp.status_code == 429:
                print(f"  Rate limited, waiting 60s...")
                time.sleep(60)
                return []
            else:
                print(f"  Error {resp.status_code}: {resp.text[:100]}")
                return []
        except Exception as e:
            print(f"  Request error: {e}")
            return []
    
    def get_business_details(self, business_id):
        """Get detailed info for a business"""
        try:
            resp = requests.get(
                YELP_DETAIL_URL.format(business_id), 
                headers=self.headers, 
                timeout=10
            )
            if resp.status_code == 200:
                return resp.json()
            return None
        except:
            return None
    
    def process_business(self, biz, source_term, source_city):
        """Convert Yelp business to our format"""
        if biz['id'] in self.seen_ids:
            return None
        self.seen_ids.add(biz['id'])
        
        # Extract location details
        loc = biz.get('location', {})
        coords = biz.get('coordinates', {})
        
        # Build provider record with ALL available fields
        provider = {
            # Core fields (matching Google format)
            'id': f"yelp-{biz['id']}",
            'name': biz.get('name'),
            'slug': biz.get('alias'),
            'city': loc.get('city'),
            'state': loc.get('state'),
            'zip': loc.get('zip_code'),
            'address': ', '.join(filter(None, [
                loc.get('address1'),
                loc.get('address2'),
                loc.get('address3'),
                f"{loc.get('city')}, {loc.get('state')} {loc.get('zip_code')}"
            ])),
            'phone': biz.get('display_phone') or biz.get('phone'),
            'website': biz.get('url'),  # Yelp page URL
            'lat': coords.get('latitude'),
            'lng': coords.get('longitude'),
            'rating': biz.get('rating'),
            'reviewCount': biz.get('review_count'),
            'photo': biz.get('image_url'),
            'logo': None,
            'category': ', '.join([c.get('title', '') for c in biz.get('categories', [])]),
            
            # Yelp-specific fields
            'yelp_id': biz['id'],
            'yelp_url': biz.get('url'),
            'yelp_rating': biz.get('rating'),
            'yelp_review_count': biz.get('review_count'),
            'price': biz.get('price'),  # $, $$, $$$, $$$$
            'is_closed': biz.get('is_closed', False),
            'transactions': biz.get('transactions', []),  # pickup, delivery, etc.
            'photos': biz.get('photos', []),
            
            # Metadata
            'source': 'yelp',
            'source_term': source_term,
            'source_city': source_city,
            'scraped_at': datetime.now().isoformat(),
        }
        
        return provider
    
    def scrape_city(self, city, state):
        """Scrape all dumpster businesses in a city"""
        location = f"{city}, {state}"
        city_providers = []
        
        for term in SEARCH_TERMS:
            print(f"  Searching '{term}' in {location}...")
            businesses = self.search_businesses(term, location)
            
            for biz in businesses:
                provider = self.process_business(biz, term, location)
                if provider:
                    city_providers.append(provider)
            
            time.sleep(0.5)  # Rate limiting
        
        return city_providers
    
    def scrape_all(self, output_file='data/yelp-providers.json'):
        """Scrape all cities"""
        print(f"Starting Yelp scrape of {len(MAJOR_CITIES)} cities...")
        print(f"Search terms: {len(SEARCH_TERMS)}")
        
        for i, (city, state) in enumerate(MAJOR_CITIES):
            print(f"\n[{i+1}/{len(MAJOR_CITIES)}] {city}, {state}")
            
            city_providers = self.scrape_city(city, state)
            self.providers.extend(city_providers)
            
            print(f"  Found {len(city_providers)} new providers (total: {len(self.providers)})")
            
            # Save progress every 10 cities
            if (i + 1) % 10 == 0:
                self.save(output_file)
        
        self.save(output_file)
        print(f"\nDone! Total providers: {len(self.providers)}")
        return self.providers
    
    def save(self, output_file):
        """Save providers to JSON"""
        Path(output_file).parent.mkdir(parents=True, exist_ok=True)
        
        data = {
            'source': 'yelp',
            'scraped_at': datetime.now().isoformat(),
            'total': len(self.providers),
            'providers': self.providers
        }
        
        with open(output_file, 'w') as f:
            json.dump(data, f, indent=2)
        print(f"  Saved to {output_file}")


def main():
    if not YELP_API_KEY:
        print("ERROR: YELP_API_KEY environment variable not set")
        print("\nTo get a Yelp API key:")
        print("1. Go to https://www.yelp.com/developers/v3/manage_app")
        print("2. Create an app (free)")
        print("3. Copy the API Key")
        print("4. Run: export YELP_API_KEY='your-key-here'")
        return
    
    scraper = YelpScraper(YELP_API_KEY)
    scraper.scrape_all()


if __name__ == '__main__':
    main()
