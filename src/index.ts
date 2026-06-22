/**
 * mcp-pay — x402 micropayment billing for MCP tools
 * Zero dependencies. Base mainnet USDC. Works with @modelcontextprotocol/sdk and raw HTTP.
 *
 * github.com/zambodotdev/mcp-pay
 * zambo.dev/opensource
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface PayableOptions {
  /** Amount in USDC required per call (e.g. 0.005 = half a cent) */
  usdc: number;
  /** Your receiving wallet address on Base mainnet */
  wallet: `0x${string}` | string;
  /** Network — currently Base mainnet (default: 'base') */
  network?: 'base';
  /** HTTP header that carries the tx hash (default: 'x-payment-hash') */
  headerName?: string;
  /** Cache verified tx hashes so retries don't re-verify (default: true) */
  cache?: boolean;
  /** Override default Base RPC endpoints */
  rpcEndpoints?: string[];
}

export interface VerifyResult {
  verified: boolean;
  amount?: number;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

export interface PaymentRequest {
  protocol: 'x402';
  network: string;
  wallet: string;
  amount: number;
  currency: 'USDC';
  headerName: string;
  instructions: string;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

interface TxLog {
  address: string;
  topics: string[];
  data: string;
}

interface TxReceipt {
  status: string;
  blockNumber: string;
  transactionHash: string;
  logs: TxLog[];
}

type AnyFn<TArgs, TResult> = (args: TArgs, ...rest: unknown[]) => Promise<TResult>;

// ── Constants ──────────────────────────────────────────────────────────────

const BASE_RPCS = [
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://1rpc.io/base',
];

/** USDC contract address on Base mainnet */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f22c3b4c19a0a0b45f15f2a0c';

// ── Internal RPC ───────────────────────────────────────────────────────────

async function rpcCall<T>(
  method: string,
  params: unknown[],
  endpoint: string,
  timeoutMs = 9000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as RpcResponse<T>;
    if (data.error) throw new Error(data.error.message);
    if (data.result === undefined || data.result === null) throw new Error('null result');
    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

async function rpcWithFallback<T>(
  method: string,
  params: unknown[],
  endpoints: string[],
): Promise<T> {
  let lastErr: Error | undefined;
  for (const ep of endpoints) {
    try {
      return await rpcCall<T>(method, params, ep);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error('All RPC endpoints failed');
}

// ── Core Verification ──────────────────────────────────────────────────────

/**
 * Verify a USDC transfer on Base mainnet.
 * No API key needed — reads directly from public Base RPC nodes.
 *
 * @example
 * const result = await verifyPayment('0xabc...', { usdc: 0.005, wallet: '0x...' });
 * if (result.verified) grantAccess();
 */
export async function verifyPayment(
  txHash: string,
  options: Pick<PayableOptions, 'usdc' | 'wallet' | 'rpcEndpoints'>,
): Promise<VerifyResult> {
  const rpcs = options.rpcEndpoints ?? BASE_RPCS;
  const targetWallet = options.wallet.toLowerCase();

  try {
    const receipt = await rpcWithFallback<TxReceipt | null>(
      'eth_getTransactionReceipt',
      [txHash],
      rpcs,
    );

    if (!receipt) {
      return { verified: false, error: 'Transaction not found or not yet confirmed on-chain' };
    }

    if (receipt.status === '0x0') {
      return { verified: false, error: 'Transaction reverted (status 0x0)' };
    }

    // Find a USDC Transfer log where `to` matches the target wallet
    const transferLog = receipt.logs.find((log) => {
      if (log.address.toLowerCase() !== USDC_BASE.toLowerCase()) return false;
      if (log.topics[0] !== TRANSFER_TOPIC) return false;
      if (!log.topics[2] || log.topics[2].length < 26) return false;
      const toAddr = '0x' + log.topics[2].slice(26).toLowerCase();
      return toAddr === targetWallet;
    });

    if (!transferLog) {
      return {
        verified: false,
        error: `No USDC Transfer to ${options.wallet} found in tx logs`,
      };
    }

    const rawAmount = BigInt(transferLog.data);
    const amount = Number(rawAmount) / Math.pow(10, USDC_DECIMALS);

    if (amount < options.usdc) {
      return {
        verified: false,
        error: `Insufficient: received $${amount.toFixed(6)} USDC, required $${options.usdc}`,
      };
    }

    return {
      verified: true,
      amount,
      txHash,
      blockNumber: parseInt(receipt.blockNumber, 16),
    };
  } catch (e) {
    return {
      verified: false,
      error: `Verification error: ${(e as Error).message}`,
    };
  }
}

/**
 * Build a payment request object to return to clients who haven't paid yet.
 */
export function createPaymentRequest(options: PayableOptions): PaymentRequest {
  const headerName = options.headerName ?? 'x-payment-hash';
  return {
    protocol: 'x402',
    network: options.network ?? 'base',
    wallet: options.wallet,
    amount: options.usdc,
    currency: 'USDC',
    headerName,
    instructions: `Send ${options.usdc} USDC to ${options.wallet} on Base mainnet. ` +
      `Include the transaction hash in the "${headerName}" header on your next request. ` +
      `One verified hash can be reused (replay protection is tool-scoped).`,
  };
}

// ── MCP Handler Wrapper ────────────────────────────────────────────────────

// Global replay-prevention cache (shared across all payable tools in process)
const _globalVerified = new Set<string>();

/**
 * Wrap any MCP tool handler with x402 payment verification.
 * The wrapped handler throws a 402 error if no valid payment is provided.
 *
 * @example
 * // With @modelcontextprotocol/sdk:
 * server.tool(
 *   'analyze_code',
 *   { description: 'AI code audit', inputSchema: z.object({ code: z.string() }) },
 *   payable({ usdc: 0.005, wallet: '0xYOURWALLET' }, async ({ code }) => {
 *     const result = await analyzeCode(code);
 *     return { content: [{ type: 'text', text: result }] };
 *   })
 * );
 */
export function payable<TArgs extends Record<string, unknown>, TResult>(
  options: PayableOptions,
  handler: AnyFn<TArgs, TResult>,
): AnyFn<TArgs, TResult> {
  const headerName = (options.headerName ?? 'x-payment-hash').toLowerCase();
  const useCache = options.cache !== false;
  const rpcs = options.rpcEndpoints ?? BASE_RPCS;

  return async (args: TArgs, ...rest: unknown[]): Promise<TResult> => {
    // Try to extract tx hash from multiple locations:
    // 1. args._payment or args._tx (direct agent-passable fields)
    // 2. args[headerName]
    // 3. MCP RequestHandlerExtra request context headers
    let txHash: string | undefined =
      (args['_payment'] as string | undefined) ||
      (args['_tx'] as string | undefined) ||
      (args[headerName] as string | undefined) ||
      (args['x-payment-hash'] as string | undefined);

    if (!txHash && rest.length > 0) {
      const extra = rest[0] as Record<string, unknown> | undefined;
      const reqCtx = extra?.['requestContext'] as Record<string, unknown> | undefined;
      const headers = reqCtx?.['headers'] as Record<string, string> | undefined;
      if (headers) {
        txHash = headers[headerName] ?? headers['x-payment-hash'];
      }
    }

    if (!txHash) {
      const paymentReq = createPaymentRequest(options);
      const err = new Error('Payment required — send USDC to use this tool') as Error & {
        code: number;
        paymentRequired: boolean;
        paymentRequest: PaymentRequest;
      };
      err.code = 402;
      err.paymentRequired = true;
      err.paymentRequest = paymentReq;
      throw err;
    }

    // Check replay cache before hitting the RPC
    if (useCache && _globalVerified.has(txHash)) {
      return handler(args, ...rest);
    }

    const result = await verifyPayment(txHash, { usdc: options.usdc, wallet: options.wallet, rpcEndpoints: rpcs });

    if (!result.verified) {
      const err = new Error(`Payment verification failed: ${result.error}`) as Error & {
        code: number;
        paymentRequired: boolean;
        paymentRequest: PaymentRequest;
      };
      err.code = 402;
      err.paymentRequired = true;
      err.paymentRequest = createPaymentRequest(options);
      throw err;
    }

    if (useCache) _globalVerified.add(txHash);
    return handler(args, ...rest);
  };
}

/**
 * Express/Fastify-compatible middleware for x402 payment gating.
 * Use when your MCP server is exposed over HTTP directly.
 *
 * @example
 * app.post('/tools/analyze_code',
 *   requirePayment({ usdc: 0.005, wallet: '0xYOURWALLET' }),
 *   analyzeCodeHandler
 * );
 */
export function requirePayment(options: PayableOptions) {
  const headerName = (options.headerName ?? 'x-payment-hash').toLowerCase();
  const useCache = options.cache !== false;

  return async (
    req: { headers: Record<string, string | string[] | undefined> },
    res: {
      status: (code: number) => { json: (body: unknown) => void };
      json: (body: unknown) => void;
    },
    next: (err?: unknown) => void,
  ): Promise<void> => {
    const txHash = (req.headers[headerName] ?? req.headers['x-payment-hash']) as string | undefined;

    if (!txHash) {
      res.status(402).json(createPaymentRequest(options));
      return;
    }

    if (useCache && _globalVerified.has(txHash)) {
      next();
      return;
    }

    const result = await verifyPayment(txHash, options);
    if (!result.verified) {
      res.status(402).json({ error: result.error, ...createPaymentRequest(options) });
      return;
    }

    if (useCache) _globalVerified.add(txHash);
    next();
  };
}

/** Clear the in-process verified tx cache (useful for testing) */
export function clearVerifiedCache(): void {
  _globalVerified.clear();
}

/** Inspect the current verified cache size */
export function getVerifiedCacheSize(): number {
  return _globalVerified.size;
}
