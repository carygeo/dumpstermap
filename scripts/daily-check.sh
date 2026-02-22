#!/bin/bash
# DumpsterMap Daily Health Check
# Run manually or via cron: 0 9 * * * /path/to/daily-check.sh

BASE_URL="${DUMPSTERMAP_URL:-https://dumpstermap.fly.dev}"
ADMIN_KEY="${DUMPSTERMAP_KEY:-dumpstermap2026}"

echo "=== DumpsterMap Daily Check ==="
echo "Date: $(date)"
echo "URL: $BASE_URL"
echo ""

# Health check
echo ">>> Health Check"
curl -s "$BASE_URL/api/health" | jq -r '.status, .emailProvider, .webhook.status'
echo ""

# Admin stats
echo ">>> Stats Summary"
STATS=$(curl -s "$BASE_URL/api/admin/stats?key=$ADMIN_KEY")
echo "$STATS" | jq -r '"Leads: \(.leads.total) (today: \(.leads.today))"'
echo "$STATS" | jq -r '"Providers: \(.providers.active) active"'
echo "$STATS" | jq -r '"Revenue: $\(.revenue.total | floor) ($\(.revenue.today | floor) today)"'
echo "$STATS" | jq -r '"Credits outstanding: \(.credits.outstanding)"'
echo "$STATS" | jq -r '"Errors (24h): \(.errors.last24h)"'
echo ""

# Run maintenance tasks
echo ">>> Running Maintenance Tasks..."
MAINT=$(curl -s -X POST "$BASE_URL/api/admin/maintenance?key=$ADMIN_KEY")
echo "$MAINT" | jq -r '.status'
echo "$MAINT" | jq -r '.tasks | to_entries | .[] | "\(.key): \(if .value.success then "✓" else "✗" end)"'
echo ""

# Check for providers with credits but no ZIPs (high priority issue)
echo ">>> Providers Needing Attention"
PROVIDERS_ISSUE=$(echo "$MAINT" | jq -r '.tasks.providersNeedingZips.count // 0')
if [ "$PROVIDERS_ISSUE" != "0" ]; then
    echo "⚠️  $PROVIDERS_ISSUE provider(s) have credits but no service ZIPs configured!"
    echo "$MAINT" | jq -r '.tasks.providersNeedingZips.providers | .[] | "   - \(.name) (\(.credits) credits)"'
else
    echo "✓ All providers with credits have service ZIPs configured"
fi
echo ""

# Stripe webhook status
echo ">>> Stripe Webhook Status"
STRIPE=$(curl -s "$BASE_URL/api/admin/stripe-status?key=$ADMIN_KEY")
echo "$STRIPE" | jq -r '"Webhook secret: \(if .config.webhookSecretSet then "✓ configured" else "✗ NOT SET" end)"'
echo "$STRIPE" | jq -r '"Product mappings: \(.config.productMappingsCount) (detection relies on amount if 0)"'
echo "$STRIPE" | jq -r '"Webhook events (24h): \(.webhookStats.last24h)"'
if [ "$(echo "$STRIPE" | jq -r '.tips | length')" != "0" ]; then
    echo "$STRIPE" | jq -r '.tips | .[] | "💡 \(.)"'
fi
echo ""

echo "=== Check Complete ==="
