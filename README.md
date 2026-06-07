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

```
components/Dashboard.jsx   UI: parameter panel + chart (recharts)
app/api/config             GET loads defaults, POST saves them to KV
app/api/metric             POST fetches orders + computes the metric
lib/shopify.js             read-only Admin GraphQL client w/ pagination
lib/metrics.js             filtering pipeline + extensible metric registry
lib/config.js              defaults + normalization/validation
lib/store.js               KV (Upstash) with in-memory dev fallback
```

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

### Adding another metric (e.g. AOV)

1. Add the field you need (e.g. order total price) to the query in
   `lib/shopify.js` and accumulate it in `computeMetric` (`lib/metrics.js`).
2. Register the metric in the `METRICS` map with a `value(agg)` function.
   It instantly appears in the UI's metric dropdown and reuses the same
   filtering/bucketing pipeline. (An `aov` stub is included, commented out.)

### Notes / limits

- Order fetch is capped at 5,000 orders per run (safety bound for serverless);
  the UI flags when a result is capped. Narrow the date range for busy stores.
- Bucketing uses the configurable IANA timezone (default `UTC`).
