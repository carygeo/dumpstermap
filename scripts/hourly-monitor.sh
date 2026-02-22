#!/bin/bash
# DumpsterMap Hourly Monitor
# Checks: Email activity, Web traffic, Database transactions
# Run via cron: 0 * * * * /path/to/hourly-monitor.sh

set -e

BASE_URL="${DUMPSTERMAP_URL:-https://dumpstermap.fly.dev}"
ADMIN_KEY="${DUMPSTERMAP_KEY:-dumpstermap2026}"
GOATCOUNTER_TOKEN="${GOATCOUNTER_TOKEN:-}"

echo "=============================================="
echo "🗺️ DumpsterMap Hourly Monitor"
echo "Time: $(date '+%Y-%m-%d %H:%M %Z')"
echo "=============================================="
echo ""

# --- 1. API Health Check ---
echo ">>> 🏥 Health Check"
HEALTH=$(curl -s "$BASE_URL/api/health" 2>/dev/null || echo '{"status":"error"}')
STATUS=$(echo "$HEALTH" | jq -r '.status // "error"')
EMAIL_PROVIDER=$(echo "$HEALTH" | jq -r '.emailProvider // "unknown"')
WEBHOOK=$(echo "$HEALTH" | jq -r '.webhook.status // "unknown"')

if [ "$STATUS" = "healthy" ] || [ "$STATUS" = "ok" ]; then
    echo "✅ API: $STATUS"
else
    echo "❌ API: $STATUS"
fi
echo "   Email: $EMAIL_PROVIDER | Webhook: $WEBHOOK"
echo ""

# --- 2. Stats & Transactions ---
echo ">>> 📊 Activity Summary"
STATS=$(curl -s "$BASE_URL/api/admin/stats?key=$ADMIN_KEY" 2>/dev/null || echo '{}')

LEADS_TOTAL=$(echo "$STATS" | jq -r '.leads.total // 0')
LEADS_TODAY=$(echo "$STATS" | jq -r '.leads.today // 0')
LEADS_PURCHASED=$(echo "$STATS" | jq -r '.leads.purchased // 0')

PROVIDERS_ACTIVE=$(echo "$STATS" | jq -r '.providers.active // 0')
PROVIDERS_TOTAL=$(echo "$STATS" | jq -r '.providers.total // 0')
PROVIDERS_PREMIUM=$(echo "$STATS" | jq -r '.providers.premium // 0')

REVENUE_TOTAL=$(echo "$STATS" | jq -r '.revenue.total // 0' | xargs printf "%.2f")
REVENUE_TODAY=$(echo "$STATS" | jq -r '.revenue.today // 0' | xargs printf "%.2f")

CREDITS=$(echo "$STATS" | jq -r '.credits.outstanding // 0')
ERRORS=$(echo "$STATS" | jq -r '.errors.last24h // 0')

echo "📈 Leads: $LEADS_TODAY today / $LEADS_TOTAL total ($LEADS_PURCHASED purchased)"
echo "🏢 Providers: $PROVIDERS_ACTIVE active / $PROVIDERS_TOTAL total ($PROVIDERS_PREMIUM premium)"
echo "💰 Revenue: \$$REVENUE_TODAY today / \$$REVENUE_TOTAL total"
echo "🎫 Credits outstanding: $CREDITS"
if [ "$ERRORS" != "0" ]; then
    echo "⚠️  Errors (24h): $ERRORS"
fi
echo ""

# --- 3. Recent Transactions (from webhook logs) ---
echo ">>> 💳 Recent Transactions"
RECENT=$(curl -s "$BASE_URL/api/admin/webhook-log?key=$ADMIN_KEY&limit=5" 2>/dev/null || echo '{"events":[]}')
WEBHOOK_COUNT=$(echo "$RECENT" | jq -r '.count // 0')

if [ "$WEBHOOK_COUNT" = "0" ]; then
    echo "   No recent webhook events"
else
    echo "   $WEBHOOK_COUNT total events"
    echo "$RECENT" | jq -r '.events[:5][] | "   \(.created_at | split("T")[1] | split(".")[0]) - \(.event_type) - \(.status)"' 2>/dev/null || echo "   (parsing error)"
fi
echo ""

# --- 4. Web Traffic (GoatCounter) ---
echo ">>> 🌐 Web Traffic"
if [ -n "$GOATCOUNTER_TOKEN" ]; then
    # If we have API token, use it
    TRAFFIC=$(curl -s -H "Authorization: Bearer $GOATCOUNTER_TOKEN" \
        "https://dumpstermap.goatcounter.com/api/v0/stats/total?period=day" 2>/dev/null || echo '{}')
    VISITS=$(echo "$TRAFFIC" | jq -r '.total // "N/A"')
    echo "   Today's visits: $VISITS"
else
    # Fall back to checking if the counter is reachable
    COUNTER_STATUS=$(curl -sI "https://dumpstermap.goatcounter.com/" 2>/dev/null | head -1 | grep -oE "[0-9]{3}" || echo "error")
    if [ "$COUNTER_STATUS" = "200" ] || [ "$COUNTER_STATUS" = "303" ] || [ "$COUNTER_STATUS" = "301" ] || [ "$COUNTER_STATUS" = "302" ]; then
        echo "   📊 GoatCounter active: https://dumpstermap.goatcounter.com/"
        echo "   (Set GOATCOUNTER_TOKEN env for API access)"
    else
        echo "   ⚠️ GoatCounter status: $COUNTER_STATUS"
    fi
fi
echo ""

# --- 5. Outreach Status ---
echo ">>> 📤 Outreach Campaign"
OUTREACH_HTML=$(curl -s "$BASE_URL/admin/outreach?key=$ADMIN_KEY" 2>/dev/null || echo "")
if [ -n "$OUTREACH_HTML" ]; then
    # Parse stats from HTML - extract value before each label
    OUTREACH_TOTAL=$(echo "$OUTREACH_HTML" | grep "Total Contacts" | grep -oE 'stat-value">[0-9]+' | grep -oE '[0-9]+' || echo "?")
    OUTREACH_PENDING=$(echo "$OUTREACH_HTML" | grep ">Pending<" | grep -oE 'stat-value">[0-9]+' | grep -oE '[0-9]+' || echo "?")
    OUTREACH_SENT=$(echo "$OUTREACH_HTML" | grep "Emails Sent" | grep -oE 'stat-value">[0-9]+' | grep -oE '[0-9]+' || echo "?")
    OUTREACH_FAILED=$(echo "$OUTREACH_HTML" | grep "Failed/Bounced" | grep -oE '>[0-9]+<' | grep -oE '[0-9]+' || echo "0")
    OUTREACH_REPLIED=$(echo "$OUTREACH_HTML" | grep ">Replied<" | grep -oE '>[0-9]+<' | grep -oE '[0-9]+' || echo "0")
    OUTREACH_CONVERTED=$(echo "$OUTREACH_HTML" | grep ">Converted<" | grep -oE '>[0-9]+<' | grep -oE '[0-9]+' || echo "0")
    echo "   📋 Total: $OUTREACH_TOTAL | Pending: $OUTREACH_PENDING"
    echo "   ✉️  Sent: $OUTREACH_SENT | ❌ Failed: $OUTREACH_FAILED"
    echo "   💬 Replied: $OUTREACH_REPLIED | ✅ Converted: $OUTREACH_CONVERTED"
else
    echo "   ⚠️ Could not fetch outreach data"
fi
echo ""

# --- 6. Email Status ---
echo ">>> 📧 Email System"
echo "   Outbound: $EMAIL_PROVIDER"
echo "   Admin inbox: admin@dumpstermap.io"
echo "   (Set up forwarding to Gmail for monitoring)"
echo ""

# --- 7. Issues Requiring Attention ---
echo ">>> ⚡ Issues"
ISSUES=0

# Check for providers needing ZIPs
MAINT=$(curl -s -X POST "$BASE_URL/api/admin/maintenance?key=$ADMIN_KEY" 2>/dev/null || echo '{}')
ZIP_ISSUES=$(echo "$MAINT" | jq -r '.tasks.providersNeedingZips.count // 0')
if [ "$ZIP_ISSUES" != "0" ]; then
    echo "   ⚠️ $ZIP_ISSUES provider(s) have credits but no service ZIPs"
    ISSUES=$((ISSUES + 1))
fi

# Check for errors
if [ "$ERRORS" != "0" ]; then
    echo "   ⚠️ $ERRORS error(s) in last 24h - check /api/admin/errors"
    ISSUES=$((ISSUES + 1))
fi

if [ "$ISSUES" = "0" ]; then
    echo "   ✅ No issues detected"
fi
echo ""

echo "=============================================="
echo "🔗 Dashboard: $BASE_URL/admin"
echo "🔗 Analytics: https://dumpstermap.goatcounter.com/"
echo "=============================================="

# Output summary for cron integration
if [ "$ISSUES" != "0" ] || [ "$LEADS_TODAY" != "0" ] || [ "$REVENUE_TODAY" != "0.00" ]; then
    echo ""
    echo "SUMMARY: leads=$LEADS_TODAY revenue=\$$REVENUE_TODAY issues=$ISSUES"
fi
