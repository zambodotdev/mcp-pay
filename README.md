# mcp-pay

> x402 micropayment billing for MCP tools. One wrapper. Any tool charges USDC per call. No Stripe. No signups. Agent-native.

[![npm version](https://img.shields.io/npm/v/mcp-pay.svg)](https://npmjs.com/package/mcp-pay)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Built by [Brennan Zambo](https://zambo.dev) — extracted from the [zambo.dev](https://zambo.dev) production MCP server running 28 tools with live x402 billing.

---

## What it does

`mcp-pay` wraps any MCP tool handler with on-chain USDC payment verification. Before your tool runs, it verifies that the calling agent paid the required amount on Base mainnet — no Stripe account, no pricing page, no auth system.

An AI agent decides it needs your tool → pays $0.005 USDC on Base → includes the tx hash in the request header → your tool runs. The whole flow is autonomous. No human required.

This is the business model for the open source AI agent economy.

---

## Install

```bash
npm install mcp-pay
```

Zero dependencies. Node.js 18+. Base mainnet only (currently).

---

## Quick start

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { payable } from 'mcp-pay';
import { z } from 'zod';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

// Wrap any tool handler with payable()
server.tool(
  'analyze_code',
  {
    description: 'AI code security audit',
    inputSchema: z.object({ code: z.string() }),
  },
  payable(
    { usdc: 0.005, wallet: '0xYOUR_WALLET_ADDRESS' },
    async ({ code }) => {
      const result = await runAudit(code);
      return { content: [{ type: 'text', text: result }] };
    }
  )
);
```

The agent calls the tool like this:

```json
{
  "tool": "analyze_code",
  "arguments": {
    "code": "...",
    "_payment": "0xABC123...TX_HASH"
  }
}
```

Or via HTTP header: `x-payment-hash: 0xABC123...TX_HASH`

---

## How payment verification works

1. Agent sends USDC to your wallet on Base mainnet
2. Agent includes the tx hash in `_payment` arg or `x-payment-hash` header
3. `mcp-pay` calls Base RPC nodes (no API key) to fetch the tx receipt
4. Finds the USDC Transfer log, checks `to` address and amount
5. ✅ Passes → runs your handler. ❌ Fails → throws 402 error with payment instructions

Verified tx hashes are cached in-process to allow retry calls without re-verifying.

---

## API

### `payable(options, handler)`

Wraps an MCP tool handler with payment verification.

```typescript
payable(options: PayableOptions, handler: AsyncFunction): AsyncFunction
```

**Options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `usdc` | `number` | required | Amount in USDC (e.g. `0.005`) |
| `wallet` | `string` | required | Your Base mainnet wallet address |
| `network` | `'base'` | `'base'` | Network (Base mainnet only currently) |
| `headerName` | `string` | `'x-payment-hash'` | Header carrying the tx hash |
| `cache` | `boolean` | `true` | Cache verified hashes to allow retries |
| `rpcEndpoints` | `string[]` | public endpoints | Override Base RPC nodes |

---

### `verifyPayment(txHash, options)`

Standalone payment verification. Use when you want to verify outside of an MCP handler.

```typescript
const result = await verifyPayment('0xabc...', {
  usdc: 1.49,
  wallet: '0xYOUR_WALLET',
});

if (result.verified) {
  console.log(`Received $${result.amount} USDC`);
  console.log(`Block: ${result.blockNumber}`);
}
```

---

### `requirePayment(options)`

Express/Fastify middleware for HTTP-level MCP servers.

```typescript
app.post('/tools/analyze_code',
  requirePayment({ usdc: 0.005, wallet: '0xYOUR_WALLET' }),
  analyzeCodeHandler
);
```

Returns `402 Payment Required` with payment instructions if no valid hash is present.

---

### `createPaymentRequest(options)`

Generate a payment request object to return to clients.

```typescript
const req = createPaymentRequest({ usdc: 0.005, wallet: '0x...' });
// {
//   protocol: 'x402',
//   network: 'base',
//   wallet: '0x...',
//   amount: 0.005,
//   currency: 'USDC',
//   headerName: 'x-payment-hash',
//   instructions: '...'
// }
```

---

## Pricing ideas

| Use case | Suggested price |
|----------|----------------|
| Code audit | $0.005–$0.01 |
| Web search | $0.001–$0.002 |
| Data enrichment | $0.002–$0.005 |
| Image generation | $0.01–$0.05 |
| Complex analysis | $0.01–$0.10 |

---

## USDC on Base

- USDC contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- 6 decimal places (1 USDC = `1000000`)
- Bridge USDC: [bridge.base.org](https://bridge.base.org)
- Buy on Base: [app.uniswap.org](https://app.uniswap.org)

---

## The x402 protocol

`mcp-pay` implements [x402](https://x402.org) — the HTTP 402 Payment Required standard for machine-to-machine micropayments. An AI agent can autonomously decide to pay for a tool, execute the payment, and retry — no human in the loop.

---

## Related

- [x402-base-verify](https://github.com/zambodotdev/x402-base-verify) — standalone USDC verification
- [mcp-shield](https://github.com/zambodotdev/mcp-shield) — security middleware for MCP servers
- [agent-ledger](https://github.com/zambodotdev/agent-ledger) — track every agent call and cost
- [zambo.dev MCP server](https://zambo.dev) — 28 live tools using mcp-pay in production

---

## License

MIT © [Brennan Zambo](https://zambo.dev)
