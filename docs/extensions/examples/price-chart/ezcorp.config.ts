import { defineExtension } from "../../../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "price-chart",
  version: "0.1.0",
  description:
    "Renders interactive stock and crypto price charts inline in chat. " +
    "Stocks come from Yahoo Finance with logos from Clearbit; crypto comes " +
    "from CoinGecko with its native coin icons. The tool returns a JSON " +
    "payload of 1Y daily closes; the host's PriceChartCard component " +
    "renders the chart as inline SVG and provides 1W/1M/3M/1Y range " +
    "switching purely client-side. No filesystem permission needed.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: false,
  category: "Markets",
  tags: ["finance", "stocks", "crypto", "charts", "demo"],

  tools: [
    {
      name: "get_stock_chart",
      description:
        "Render an interactive stock price chart inline in the chat (last ~1 year " +
        "of daily closes, Yahoo Finance) with the company logo, current price, and " +
        "% change. Call ONCE per ticker. The card has built-in 1W/1M/3M/1Y range " +
        "buttons the user toggles client-side — do NOT call this tool again to " +
        "switch ranges or 'refresh'. After this returns, write ONE short sentence " +
        "summarizing the price move; do NOT keep calling tools. Use when the user " +
        "asks about a stock's price / performance / chart (e.g. 'how is AAPL doing', " +
        "'show me MSFT', 'chart Tesla').",
      inputSchema: {
        type: "object",
        properties: {
          ticker: {
            type: "string",
            description:
              "Stock ticker symbol, e.g. 'AAPL', 'MSFT', 'TSLA'. " +
              "Case-insensitive. Yahoo Finance ticker conventions apply (BRK-B, etc.).",
          },
        },
        required: ["ticker"],
      },
      cardType: "price-chart",
    },
    {
      name: "get_crypto_chart",
      description:
        "Render an interactive crypto price chart inline in the chat (last ~1 year " +
        "of daily USD prices, CoinGecko) with the coin's icon, current price, and " +
        "% change. Accepts either a ticker symbol (BTC, ETH, SOL) or a CoinGecko " +
        "id (bitcoin, ethereum). Call ONCE per asset. The card has built-in " +
        "1W/1M/3M/1Y range buttons the user toggles client-side — do NOT call this " +
        "tool again to switch ranges or 'refresh'. After this returns, write ONE " +
        "short sentence summarizing the move; do NOT keep calling tools. Use when " +
        "the user asks about a coin's price or chart.",
      inputSchema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description:
              "Crypto symbol or CoinGecko id, e.g. 'BTC' or 'bitcoin'. " +
              "Common symbols are auto-mapped to ids (BTC → bitcoin, ETH → ethereum, " +
              "SOL → solana, etc.). Unknown symbols are passed through to CoinGecko verbatim.",
          },
        },
        required: ["symbol"],
      },
      cardType: "price-chart",
    },
  ],

  agent: {
    prompt: [
      "You can render live stock and crypto charts inline in the conversation by",
      "calling `get_stock_chart` (Yahoo Finance) or `get_crypto_chart` (CoinGecko).",
      "Each card shows the asset's logo, current price, % change, and a 1Y daily",
      "series with 1W / 1M / 3M / 1Y buttons the user can switch client-side.",
      "",
      "When the user asks about a single stock or coin's price/performance/chart,",
      "call the matching tool ONCE — do not loop over multiple ranges. The card's",
      "built-in buttons handle range switching without another tool call.",
      "",
      "After the tool returns, briefly summarize the headline numbers (last price",
      "and % change) in one sentence. Don't re-describe the chart; the user can",
      "see it.",
    ].join("\n"),
    category: "Markets",
    capabilities: ["chart-rendering", "market-data"],
  },

  permissions: {
    shell: false,
    eventSubscriptions: [],
    network: [
      "query1.finance.yahoo.com",
      "api.coingecko.com",
    ],
  },

  resources: {
    memory: "256MB",
    callTimeoutMs: 30_000,
  },
});
