import Dashboard from "@/components/Dashboard";

export default function Page() {
  return (
    <main className="app">
      <h1>AOV Deeper</h1>
      <p className="subtitle">
        Configurable, read-only Shopify metrics. Slice units-per-transaction by
        time, excluded products, and order landing-page path.
      </p>
      <Dashboard />
    </main>
  );
}
