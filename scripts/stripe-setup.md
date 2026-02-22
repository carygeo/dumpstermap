# Stripe Product ID Setup

The webhook can detect credit packs via multiple methods (in order of reliability):
1. **Stripe price IDs in STRIPE_PRODUCT_MAP** (most reliable)
2. Session metadata (`pack_type` or `credits` field)
3. Line item product names
4. Original amount before discounts
5. Final amount with tolerance

## Getting Your Price IDs

### Option 1: Stripe Dashboard
1. Go to [Stripe Dashboard](https://dashboard.stripe.com) → Products
2. Click on each product
3. Find the "API ID" or "Price ID" (starts with `price_`)
4. Copy the ID

### Option 2: Stripe CLI
```bash
# List all products with prices
stripe products list --expand data.default_price

# Or just prices
stripe prices list --limit 10
```

### Option 3: From Payment Links
If you created products via Payment Links:
```bash
# Get the payment link details
stripe payment_links retrieve plink_xxx
```

## Adding to Server

Edit `server.js` and add to `STRIPE_PRODUCT_MAP`:

```javascript
const STRIPE_PRODUCT_MAP = {
  // Add your actual price_xxx IDs here:
  'price_1ABC123': { credits: 5, name: 'Starter Pack' },
  'price_1DEF456': { credits: 20, name: 'Pro Pack', perks: true },
  'price_1GHI789': { credits: 60, name: 'Premium Pack', perks: true },
  'price_1JKL012': { credits: 3, name: 'Featured Partner', perks: ['verified', 'priority'] },
};
```

## Your Payment Links

| Product | Link | Expected Credits |
|---------|------|------------------|
| Single Lead ($40) | `cNidR9aQ76T46IF78j5Rm04` | 1 lead |
| Starter ($200) | `00w14n5vNa5g5EB2S35Rm00` | 5 credits |
| Pro ($700) | `fZu6oH7DVgtE7MJdwH5Rm02` | 20 credits |
| Premium ($1500) | `bJefZh0btcdod73eAL5Rm03` | 60 credits |
| Featured ($99/mo) | `28EdR9e2jelwgjfgIT5Rm01` | 3 credits/mo |

## Testing

After adding price IDs, test with:
```bash
curl -X POST "https://dumpstermap.fly.dev/api/admin/test-webhook?key=dumpstermap2026" \
  -H "Content-Type: application/json" \
  -d '{"amount": 200, "email": "test@example.com"}'
```

Expected response should show `detected: "credit_pack"` with correct credits.

## Current Status

Check configuration at: `/api/admin/stripe-status?key=YOUR_KEY`
