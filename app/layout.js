import "./globals.css";

export const metadata = {
  title: "AOV Deeper — Shopify Metrics",
  description: "Configurable Shopify metric dashboard (read-only).",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
