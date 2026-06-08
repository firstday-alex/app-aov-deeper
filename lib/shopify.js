// Read-only Shopify Admin GraphQL client.
// This module ONLY issues queries (reads). It never mutates store data.
// (bulkOperationRunQuery is an async *read* export — it creates no store data.)

function endpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const version = process.env.SHOPIFY_API_VERSION || "2025-01";
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is not set");
  return `https://${domain}/admin/api/${version}/graphql.json`;
}

export async function adminGraphQL(query, variables) {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("SHOPIFY_ADMIN_TOKEN is not set");

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

// Escapes a value for embedding inside the bulk query's search-syntax string,
// which itself lives inside a GraphQL string literal.
function escapeForBulk(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Builds the orders search-syntax filter (server-side filterable parts only).
export function buildOrdersFilter({ start, end, includeTestOrders }) {
  const parts = [];
  if (start) parts.push(`created_at:>='${start}'`);
  if (end) parts.push(`created_at:<='${end}'`);
  if (!includeTestOrders) parts.push("test:false");
  return parts.join(" ");
}

// Builds the inner bulk query document. customerJourneySummary is only requested
// when a landing-page filter is active (it's expensive and usually null).
function buildBulkDocument({ start, end, includeTestOrders, needsJourney }) {
  const filter = escapeForBulk(buildOrdersFilter({ start, end, includeTestOrders }));
  const journey = needsJourney
    ? `customerJourneySummary { lastVisit { landingPage } firstVisit { landingPage } }`
    : "";
  // Note: bulk queries use edges/node form, take no pagination args, and allow
  // a nesting depth of 2 connections (orders -> lineItems).
  return `{
    orders(query: "${filter}") {
      edges {
        node {
          id
          createdAt
          ${journey}
          lineItems {
            edges {
              node {
                quantity
                name
                title
                product { title }
                originalTotalSet { shopMoney { amount currencyCode } }
                discountAllocations { allocatedAmountSet { shopMoney { amount } } }
                taxLines { priceSet { shopMoney { amount } } }
              }
            }
          }
        }
      }
    }
  }`;
}

const START_BULK = /* GraphQL */ `
  mutation StartBulk($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const POLL_BULK = /* GraphQL */ `
  query PollBulk($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        url
        partialDataUrl
      }
    }
  }
`;

// Used to recover the in-flight operation when one is already running for the shop.
const CURRENT_BULK = /* GraphQL */ `
  query CurrentBulk {
    currentBulkOperation(type: QUERY) {
      id
      status
      objectCount
      url
    }
  }
`;

// Starts a bulk export of orders for the window. Returns { id, status }.
// If a bulk query is already running for the shop, returns that operation
// instead (Shopify allows only one bulk query per shop at a time).
export async function startOrdersBulk(opts) {
  const document = buildBulkDocument(opts);
  const data = await adminGraphQL(START_BULK, { query: document });
  const payload = data.bulkOperationRunQuery;

  const errs = payload.userErrors || [];
  if (errs.length) {
    const alreadyRunning = errs.some((e) =>
      /already in progress|running/i.test(e.message || "")
    );
    if (alreadyRunning) {
      const cur = await adminGraphQL(CURRENT_BULK, {});
      const op = cur.currentBulkOperation;
      if (op) return { id: op.id, status: op.status, reused: true };
    }
    throw new Error(`Bulk start failed: ${errs.map((e) => e.message).join("; ")}`);
  }
  return { id: payload.bulkOperation.id, status: payload.bulkOperation.status };
}

// Polls a bulk operation by id.
export async function pollBulk(id) {
  const data = await adminGraphQL(POLL_BULK, { id });
  const op = data.node;
  if (!op) throw new Error("Bulk operation not found");
  return op; // { id, status, errorCode, objectCount, url, partialDataUrl }
}
