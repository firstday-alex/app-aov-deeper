# AOV Deeper — Configurable Shopify Metric Dashboard

A Vercel-ready Next.js app that pulls order data from your Shopify store
(**read-only**) and graphs configurable metrics. The first metric is
**Units per Transaction (UPT)**, which you can slice by:

- a variable **time period** (date range) bucketed by **day / week / month**,
- **excluded line items** matched by name (default: `rapid hydration`),
- an optional **order landing-page path** (e.g. `/pages/offer-a`).

You can edit every parameter in the UI and **save it as the default** so the
dashboard loads your preferred slice next time.

> This app only issues GraphQL **queries** against the Shopify Admin API. It
> never creates, updates, or deletes store data. The custom-app token only needs
> `read_orders` and `read_products`.

---

## 1. Create a read-only Shopify custom app

1. Shopify admin → **Settings → Apps and sales channels → Develop apps**.
2. **Create an app** (e.g. "AOV Deeper").
3. **Configure Admin API scopes** → enable **`read_orders`** and **`read_products`**.
4. **Install app**, then reveal the **Admin API access token** (`shpat_...`).

## 2. Local development

```bash
cp .env.example .env.local      # fill in the values below
npm install
npm run dev                     # http://localhost:3000
```

`.env.local`:

```
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
SHOPIFY_API_VERSION=2025-01
```

Without KV vars set, config is stored **in-memory** (resets on restart) — fine
for local dev. The UI shows an "in-memory" badge in that mode.

## 3. Deploy to Vercel

1. Push this repo to GitHub and **Import** it in Vercel (framework auto-detected
   as Next.js).
2. Add the Shopify env vars (Project → **Settings → Environment Variables**).
3. **Storage → Create → KV** (Upstash). Vercel injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically — this is what persists your saved defaults
   across devices and deploys. (`UPSTASH_REDIS_REST_URL`/`_TOKEN` also work.)
4. Deploy.

---

## How it works

Order volume at scale makes cursor pagination impractical (it caps out and hits
GraphQL cost throttling). Instead this app uses **Shopify Bulk Operations**: it
submits one query that Shopify runs server-side across *all* matching orders and
returns as a JSONL file, which the server streams and aggregates line-by-line
(constant memory regardless of order count).

```
components/Dashboard.jsx   UI: parameter panel + chart; submit→poll→render flow
app/api/config             GET loads defaults, POST saves them to KV
app/api/metric/start       POST starts (or reuses) a bulk export for the window
app/api/metric/poll        GET  reports export status + objectCount
app/api/metric/result      POST streams the JSONL export and aggregates the metric
lib/shopify.js             read-only Admin GraphQL client + bulk op helpers
lib/bulkAggregate.js       streaming JSONL parser -> metric accumulator
lib/metrics.js             filtering pipeline + extensible metric accumulator
lib/bulkHelpers.js         window resolution + export cache keys
lib/config.js              defaults + normalization/validation
lib/store.js               KV (Upstash) for config + export reuse cache
```

### Request flow

1. **start** — submits `bulkOperationRunQuery` for the date window. If a
   completed export for the same window already exists (cached up to 6 days), it
   is reused and no new query runs. Shopify allows only one bulk query per shop
   at a time; if one is already running, the in-flight op is attached to.
2. **poll** — the client polls `node(id:)` every ~1.5s for `status` /
   `objectCount` and shows progress.
3. **result** — once `COMPLETED`, the server streams the JSONL file and
   aggregates. Because the export depends only on the date window + test flag,
   changing the exclude-names or landing-path filter **re-aggregates the same
   export** without re-querying Shopify.

The `customerJourneySummary` (landing-page) fields are only requested when a
landing-page filter is set — they're expensive and usually null otherwise.

### Metrics

| Metric | Definition |
| --- | --- |
| **Units per Transaction (UPT)** | included units ÷ transactions |
| **Average Order Value (AOV)** | net sales ÷ transactions |
| **Net Sales per Item Sold** | net sales ÷ included units |

All three share one aggregation pass and the same item-exclusion filter, so
`net-sales-per-item × UPT = AOV` holds exactly.

**Sales basis** (configurable; applies to AOV & net-sales-per-item, computed per
line item so exclusions apply):

- `net` *(default)* — `originalTotal − all discount allocations` (line + order
  level), excluding tax & shipping. This is Shopify's net-sales basis.
- `gross` — `originalTotal`, before discounts.
- `netWithTax` — net + per-line tax (shipping is never included; it isn't a line item).

> **Returns/refunds are intentionally not subtracted** — net sales here reflects
> sales at time of order (net of discounts), which is the preferred basis for
> this dashboard. (This also sidesteps a bulk-query constraint: per-line refund
> data can't be fetched in bulk, since connection nesting is capped at 2 levels.)

### UPT definition used

- **units** = sum of line-item quantities, excluding items whose name/title/
  product title contains any configured exclude string (case-insensitive).
- **transactions** = orders that contributed ≥ 1 included unit. Orders whose
  every line item was excluded are dropped by default (toggle:
  *"Count orders with 0 included units"*).
- **UPT** = units ÷ transactions, computed per time bucket and for the period.

### Landing-page path filter

Shopify can't filter orders by landing page server-side, so this is applied
after fetching, using `customerJourneySummary.lastVisit.landingPage` (falling
back to `firstVisit`). Orders with no attribution are excluded when a path
filter is set. Match modes: starts-with (default), exact, contains.
Note: customer-journey attribution is only populated for online-store orders
within Shopify's attribution window.

### Adding another metric

The accumulator already tracks `units`, `transactions`, and `sales` per bucket.
If your metric is a ratio of those, just register it in the `METRICS` map in
`lib/metrics.js` with a `value(agg)` function — it instantly appears in the UI
dropdown and reuses the filtering/bucketing pipeline. If it needs a new raw
input, add the field to the bulk query in `lib/shopify.js` and accumulate it in
`createAccumulator` (and `finalize`'s `totals`/bucket objects).

### Notes / limits

- No order cap — bulk operations process the entire window server-side. Large
  windows simply take longer to come back (the UI shows live object counts).
- Only one bulk query runs per shop at a time (Shopify limit); a concurrent
  "Run" attaches to the in-flight export rather than failing.
- Bucketing uses the configurable IANA timezone (default `UTC`).
