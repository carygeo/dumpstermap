# DumpsterMap.io 🗺️

**Find and compare dumpster rental prices from 13,000+ providers nationwide.**

🌐 **Live:** [dumpstermap.fly.dev](https://dumpstermap.fly.dev) | [dumpstermap.io](https://dumpstermap.io)

## Features

- 🗺️ **Interactive Map** - Browse 8,000+ providers on a dark-themed map with clustering
- 🔍 **Search** - Find providers by ZIP code or city
- ⭐ **Filters** - Filter by rating, review count, sort by relevance
- 📞 **Direct Contact** - Call or visit provider websites instantly
- 📱 **Mobile Responsive** - Works on desktop and mobile

## Tech Stack

- **Frontend:** Vanilla HTML/CSS/JS (no framework bloat)
- **Maps:** Leaflet + MarkerCluster
- **Tiles:** CARTO Dark
- **Hosting:** Fly.io
- **Data:** OutScraper Google Maps API

## Data

- **13,651 providers** scraped from Google Maps
- **50 states** covered
- **Fields:** name, address, phone, website, rating, reviews, lat/long
- **Source:** OutScraper API (metro-level queries for 8x better coverage)

## Local Development

```bash
# Serve locally
python -m http.server 8080
# Visit http://localhost:8080
```

## Deploy

```bash
fly deploy
```

## Project Structure

```
dumpstermap/
├── index.html          # Main map interface
├── calculator.html     # Size/price calculator
├── results.html        # Search results page
├── app.js              # Shared JavaScript
├── data/
│   ├── providers.json  # 8,127 cleaned providers (web-ready)
│   ├── raw/            # Raw OutScraper data (50 states)
│   └── cleaned/        # Cleaned/deduped data
├── scripts/
│   ├── clean_data.py   # Data cleaning pipeline
│   └── outscraper_*.py # Data acquisition scripts
├── Dockerfile
└── fly.toml
```

## SEO Strategy

- Programmatic city landing pages (500+ cities)
- Schema.org LocalBusiness markup
- Metro-focused content for high-intent searches

## License

MIT
