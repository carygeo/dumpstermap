# DumpsterMap.io 🗺️

**Find and compare dumpster rental prices from 13,000+ providers nationwide.**

🌐 **Live:** [dumpstermap.fly.dev](https://dumpstermap.fly.dev) | [dumpstermap.io](https://dumpstermap.io)  
🔧 **Admin:** [/admin](https://dumpstermap.fly.dev/admin?key=dumpstermap2026)

## Features

- 🗺️ **Interactive Map** - Browse 8,000+ providers on a dark-themed map with clustering
- 🔍 **Search** - Find providers by ZIP code or city
- ⭐ **Filters** - Filter by rating, review count, sort by relevance
- 📞 **Direct Contact** - Call or visit provider websites instantly
- 📱 **Mobile Responsive** - Works on desktop and mobile
- 💰 **Lead Generation** - Customers submit quotes, providers pay for leads

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DumpsterMap.io                               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   Customer                Provider                  Admin           │
│      │                       │                        │             │
│      ▼                       ▼                        ▼             │
│   [Quote Form]         [Buy Credits]           [Admin Panel]        │
│      │                       │                        │             │
│      ▼                       ▼                        ▼             │
│   POST /api/lead      Stripe Checkout         /admin?key=xxx        │
│      │                       │                        │             │
│      └───────────┬───────────┘                        │             │
│                  ▼                                    │             │
│         ┌────────────────┐                            │             │
│         │   server.js    │◄───────────────────────────┘             │
│         │  (Express.js)  │                                          │
│         └───────┬────────┘                                          │
│                 │                                                   │
│                 ▼                                                   │
│         ┌────────────────┐     ┌─────────────────┐                  │
│         │    SQLite      │     │  Email (Resend  │                  │
│         │  (Fly Volume)  │     │  or Gmail SMTP) │                  │
│         └────────────────┘     └─────────────────┘                  │
│                                                                     │
│  Tables:                        Email Templates:                    │
│  - leads                        - Full lead (paid)                  │
│  - providers                    - Teaser (unpaid)                   │
│  - purchase_log                 - Credit confirmation               │
│  - outreach                     - Admin notifications               │
│  - error_log                                                        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Lead Flow

1. **Customer submits quote** → POST /api/lead → Creates lead in SQLite
2. **Match providers** → Find active providers covering that ZIP
3. **If provider has credits** → Auto-send full contact info, deduct 1 credit
4. **If no credits** → Send teaser email with payment link
5. **Provider pays** → Stripe webhook → Deliver full lead details

## Pricing

| Product | Price | Credits |
|---------|-------|---------|
| Single Lead | $40 | 1 |
| Starter Pack | $200 | 5 |
| Pro Pack | $700 | 20 |
| Premium Pack | $1,500 | 60 |

## Tech Stack

- **Backend:** Node.js + Express.js
- **Database:** SQLite (better-sqlite3) on Fly.io volume
- **Email:** Resend API (primary) or Gmail SMTP (fallback)
- **Payments:** Stripe Checkout + Webhooks
- **Frontend:** Vanilla HTML/CSS/JS
- **Maps:** Leaflet + MarkerCluster + CARTO Dark tiles
- **Hosting:** Fly.io

## Local Development

```bash
# Install dependencies
npm install

# Run server (requires Node 18+)
node server.js

# Or with auto-reload
npx nodemon server.js

# Visit http://localhost:8080
```

## Environment Variables

```bash
# Email (choose one)
RESEND_API_KEY=re_xxx        # Preferred
SMTP_USER=admin@dumpstermap.io
SMTP_PASS=your-app-password

# Optional
ADMIN_PASSWORD=dumpstermap2026
DATA_DIR=/data  # For Fly.io volume
EMAIL_FROM="DumpsterMap <leads@dumpstermap.io>"
```

## Deploy

```bash
# Deploy to Fly.io
fly deploy

# View logs
fly logs

# SSH into instance
fly ssh console

# Check database
fly ssh console -C "sqlite3 /data/dumpstermap.db '.tables'"
```

## Stripe Webhook Setup

1. Create webhook endpoint in Stripe Dashboard → Developers → Webhooks
2. URL: `https://dumpstermap.fly.dev/api/stripe-webhook`
3. Events: `checkout.session.completed`
4. Copy signing secret and set as `STRIPE_WEBHOOK_SECRET` env var
5. Test with Stripe CLI: `stripe trigger checkout.session.completed`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/lead` | POST | Submit new lead |
| `/api/stripe-webhook` | POST | Stripe payment webhook (idempotent) |
| `/api/balance` | GET | Check provider credit balance |
| `/api/provider` | GET | Provider profile lookup |
| `/api/provider/zips` | POST | Provider self-service zip update |
| `/api/stats` | GET | Public stats (leads, providers) |
| `/api/admin/stats` | GET | Admin stats (revenue, errors) - requires key |
| `/api/admin/daily-summary` | GET | Daily metrics summary for monitoring - requires key |
| `/api/admin/zip-coverage` | GET | ZIP coverage analysis (providers per zip, gaps) - requires key |
| `/api/admin/send-test-lead` | POST | Send test lead to provider for verification - requires key |
| `/api/admin/test-webhook` | POST | Test webhook detection (dev only) - requires key |
| `/api/health` | GET | Health check |
| `/admin` | GET | Admin dashboard |
| `/admin/outreach` | GET | Provider outreach tracking |
| `/admin/logs` | GET | System & error logs with revenue breakdown |
| `/admin/export/:type` | GET | Export CSV (leads/providers/purchases/outreach) |

## Project Structure

```
dumpstermap/
├── server.js           # Express backend (leads, payments, admin)
├── index.html          # Main map interface
├── calculator.html     # Size/price calculator
├── results.html        # Search results page
├── quote-form.html     # Lead capture form
├── for-providers.html  # Provider signup page
├── balance.html        # Credit balance checker
├── app.js              # Shared frontend JavaScript
├── data/
│   └── providers.json  # Static provider data for map
├── Dockerfile
├── fly.toml
└── package.json
```

## Admin Features

- **Dashboard** - Stats, leads, providers overview
- **Provider Management** - Add/edit/delete providers, set service zips
- **Credit Management** - Manual credit additions with audit log
- **Outreach Tracking** - Track email campaigns to recruit providers
- **System Logs** - Purchase history and error logs
- **CSV Export** - Export all data types

## License

MIT
