// Curated lookup tables.
//
// STOCK_TO_DOMAIN: ticker → company root domain. Drives the Clearbit
// logo URL (https://logo.clearbit.com/<domain>). Unknown tickers fall
// through to a generic SVG placeholder rendered inside the iframe — the
// chart still works, just without a logo.
//
// CRYPTO_SYMBOL_TO_ID: ticker → CoinGecko coin id. CoinGecko's
// /coins/{id} accepts ids directly, so unknown symbols can still
// resolve when the LLM passes "bitcoin" / "ethereum" verbatim.
//
// Both maps are intentionally short — popular assets people actually
// ask about. Easy to extend without touching the rest of the
// extension.

const STOCK_TO_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  // Mega-cap tech
  AAPL: "apple.com",
  MSFT: "microsoft.com",
  GOOGL: "google.com",
  GOOG: "google.com",
  AMZN: "amazon.com",
  META: "meta.com",
  NVDA: "nvidia.com",
  TSLA: "tesla.com",
  AMD: "amd.com",
  INTC: "intel.com",
  CRM: "salesforce.com",
  ORCL: "oracle.com",
  ADBE: "adobe.com",
  NFLX: "netflix.com",
  IBM: "ibm.com",
  CSCO: "cisco.com",
  // Financials
  JPM: "jpmorganchase.com",
  BAC: "bankofamerica.com",
  GS: "goldmansachs.com",
  MS: "morganstanley.com",
  V: "visa.com",
  MA: "mastercard.com",
  // Consumer + industrials
  DIS: "disney.com",
  NKE: "nike.com",
  KO: "coca-cola.com",
  PEP: "pepsico.com",
  WMT: "walmart.com",
  COST: "costco.com",
  HD: "homedepot.com",
  MCD: "mcdonalds.com",
  BA: "boeing.com",
  F: "ford.com",
  GM: "gm.com",
  // Newer tech
  UBER: "uber.com",
  ABNB: "airbnb.com",
  SHOP: "shopify.com",
  SPOT: "spotify.com",
  COIN: "coinbase.com",
  PLTR: "palantir.com",
  SNOW: "snowflake.com",
  DDOG: "datadoghq.com",
  // Indexes
  SPY: "spglobal.com",
  QQQ: "invesco.com",
});

const CRYPTO_SYMBOL_TO_ID: Readonly<Record<string, string>> = Object.freeze({
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
  ADA: "cardano",
  AVAX: "avalanche-2",
  DOGE: "dogecoin",
  DOT: "polkadot",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  TRX: "tron",
  LINK: "chainlink",
  UNI: "uniswap",
  ATOM: "cosmos",
  XLM: "stellar",
  ETC: "ethereum-classic",
  XMR: "monero",
  BCH: "bitcoin-cash",
  NEAR: "near",
  APT: "aptos",
  ARB: "arbitrum",
  OP: "optimism",
  FIL: "filecoin",
  HBAR: "hedera-hashgraph",
  ICP: "internet-computer",
  VET: "vechain",
  ALGO: "algorand",
  AAVE: "aave",
  SUI: "sui",
  SHIB: "shiba-inu",
  PEPE: "pepe",
});

/** Look up the company domain for a ticker, returning undefined when
 *  unknown (HTML renderer falls back to a placeholder SVG). */
export function lookupStockDomain(ticker: string): string | undefined {
  return STOCK_TO_DOMAIN[ticker.toUpperCase()];
}

/** Resolve a user-supplied crypto symbol to a CoinGecko coin id. Falls
 *  back to the lowercased input — CoinGecko accepts ids verbatim, so
 *  passing `bitcoin` works without an entry here. */
export function resolveCryptoId(symbolOrId: string): string {
  const upper = symbolOrId.toUpperCase();
  const mapped = CRYPTO_SYMBOL_TO_ID[upper];
  if (mapped) return mapped;
  // Already an id? Lowercase + leave alone — CoinGecko's ids are
  // kebab-case ascii.
  return symbolOrId.trim().toLowerCase();
}

/** Build the Clearbit logo URL for a domain. Clearbit serves 404 for
 *  unknown domains; the HTML's `<img onerror>` handles that gracefully
 *  by swapping in the inline SVG placeholder. */
export function clearbitLogoUrl(domain: string): string {
  return `https://logo.clearbit.com/${domain}`;
}
