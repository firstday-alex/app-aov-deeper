// Read-only Shopify Admin GraphQL client.
// This module ONLY issues queries (reads). It never mutates store data.

const ORDERS_QUERY = /* GraphQL */ `
  query OrdersForMetric($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        createdAt
        customerJourneySummary {
          firstVisit {
            landingPage
          }
          lastVisit {
            landingPage
          }
        }
        lineItems(first: 100) {
          nodes {
            quantity
            title
            name
            product {
              title
            }
          }
        }
      }
    }
  }
`;

function endpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const version = process.env.SHOPIFY_API_VERSION || "2025-01";
  if (!domain) {
    throw new Error("SHOPIFY_STORE_DOMAIN is not set");
  }
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

async function adminGraphQL(query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) {
    throw new Error("SHOPIFY_ADMIN_TOKEN is not set");
  }

  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// Builds the Shopify search-syntax `query` string for the orders connection.
// Note: customer-journey / landing-page attribution is NOT filterable server-side,
// so that filter is applied in the metric layer after fetching.
function buildOrdersQueryString({ start, end, includeTestOrders }) {
  const parts = [];
  if (start) parts.push(`created_at:>='${start}'`);
  if (end) parts.push(`created_at:<='${end}'`);
  if (!includeTestOrders) parts.push("test:false");
  return parts.join(" ");
}

// Fetches every order in the window, following pagination. Returns an array of
// order nodes. `maxOrders` is a safety cap to avoid runaway serverless runs.
export async function fetchOrders({ start, end, includeTestOrders = false, maxOrders = 5000 }) {
  const queryString = buildOrdersQueryString({ start, end, includeTestOrders });
  const orders = [];
  let after = null;
  let pages = 0;

  do {
    const data = await adminGraphQL(ORDERS_QUERY, {
      first: 100,
      after,
      query: queryString,
    });

    const conn = data.orders;
    orders.push(...conn.nodes);
    pages += 1;

    if (orders.length >= maxOrders) break;
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);

  return { orders, pages, queryString, capped: orders.length >= maxOrders };
}
