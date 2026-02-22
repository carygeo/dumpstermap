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

![System Flow Diagram](docs/system-flow-diagram.jpg)

<details>
<summary>ASCII Diagram (text version)</summary>

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
</details>

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

## Testing

```bash
# Run all tests
npm test

# Watch mode (re-run on changes)
npm run test:watch

# With coverage report
npm run test:coverage
```

### Test Results

```
PASS ./server.test.js
  Lead ID Generation
    ✓ generates 6-character IDs
    ✓ uses only allowed characters (no ambiguous chars)
    ✓ does not contain ambiguous characters (0, O, 1, I)
  Provider ID List Format
    parseProviderIds
      ✓ parses single ID
      ✓ parses multiple IDs
      ✓ handles no spaces
      ✓ handles extra spaces
      ✓ returns empty array for null/undefined
      ✓ returns empty array for empty brackets
      ✓ returns empty array for legacy format (no brackets)
    formatProviderIds
      ✓ formats single ID
      ✓ formats multiple IDs
      ✓ formats empty array
    ID merging (resend logic)
      ✓ merges new IDs with existing
      ✓ deduplicates IDs
  ZIP Code Matching
    ✓ finds providers serving a ZIP
    ✓ excludes inactive providers
    ✓ returns empty array for unserved ZIP
  Credit Balance Logic
    ✓ identifies providers with sufficient credits
    ✓ handles zero credit cost
  Lead Data Validation
    ✓ validates correct data
    ✓ rejects invalid ZIP
    ✓ rejects short phone
    ✓ rejects invalid email format
    ✓ allows missing email
  Admin Display Helpers
    ✓ displays new format correctly
    ✓ handles unknown IDs
    ✓ handles legacy format
    ✓ handles empty/null

Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total
```

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

## Stripe Webhook Flow

```
1. WEBHOOK RECEIVED
   ↓
2. VERIFY SIGNATURE (using STRIPE_WEBHOOK_SECRET)
   ↓ (reject if invalid)
3. CHECK EVENT TYPE = 'checkout.session.completed'
   ↓
4. CHECK PAYMENT STATUS = 'paid'
   ↓ (reject if not paid)
5. IDEMPOTENCY CHECK (prevent duplicate processing)
   ↓
6. LOG TO purchase_log (status: 'Processing')
   ↓
7. DETERMINE PURCHASE TYPE:
   ├─ $200 → 5 credits (Starter Pack)
   ├─ $700 → 20 credits (Pro Pack)
   ├─ $1500 → 60 credits (Premium Pack)
   └─ $40 with leadId → Single lead purchase
   ↓
8. UPDATE PROVIDER:
   - credit_balance += credits
   - last_purchase_at = now()
   ↓
9. UPDATE purchase_log (status: 'Credits Added')
   ↓
10. SEND CONFIRMATION EMAIL
   ↓
11. NOTIFY ADMIN
```

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
| `/api/admin/pricing` | GET | View credit pack pricing config and Stripe product mappings - requires key |
| `/api/admin/errors` | GET | View recent errors (?hours=24&limit=50) - requires key |
| `/api/admin/errors/cleanup` | POST | Delete errors older than 7 days - requires key |
| `/api/admin/provider/:id` | GET | Get detailed provider info by ID - requires key |
| `/api/admin/premium-status` | GET | View premium/verified providers - requires key |
| `/api/admin/test-webhook` | POST | Test webhook detection (dev only) - requires key |
| `/api/admin/webhook-log` | GET | View recent webhook events - requires key |
| `/api/admin/registration-funnel` | GET | Registration-to-purchase funnel stats - requires key |
| `/api/admin/bulk-add-credits` | POST | Add credits to multiple providers at once - requires key |
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
