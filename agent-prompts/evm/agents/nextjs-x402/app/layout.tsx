import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "x402 USDC-Gated APIs",
  description: "EVM USDC cross-chain payment demo using the pump.fun agent payments SDK",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
