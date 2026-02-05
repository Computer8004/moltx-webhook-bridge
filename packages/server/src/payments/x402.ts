import type { X402Payment } from '@moltx/bridge-types';

const X402_RECIPIENT = process.env.X402_RECIPIENT;
const X402_AMOUNT = process.env.X402_AMOUNT ?? '0.01';
const X402_NETWORK = process.env.X402_NETWORK ?? 'base';
const X402_INTERVAL = process.env.X402_INTERVAL ?? '30days'; // Subscription interval

interface VerificationResult {
  valid: boolean;
  walletAddress?: string;
  error?: string;
}

/**
 * Verify x402 payment payload
 * 
 * For now, this validates the structure. In production,
 * you'd verify the signature on-chain.
 */
export async function verifyX402Payment(payment: X402Payment): Promise<VerificationResult> {
  if (!X402_RECIPIENT) {
    return { valid: false, error: 'X402_RECIPIENT not configured' };
  }

  // Validate schema
  if (payment.schemaId !== 'x402@1.0') {
    return { valid: false, error: 'Invalid schema version' };
  }

  // Validate network
  if (payment.network !== X402_NETWORK) {
    return { valid: false, error: `Invalid network. Expected: ${X402_NETWORK}` };
  }

  const { payload } = payment;

  // Validate required fields
  if (!payload.signature || !payload.timestamp || !payload.address) {
    return { valid: false, error: 'Missing required payment fields' };
  }

  // Check timestamp (must be within last 5 minutes)
  const now = Date.now();
  const paymentTime = payload.timestamp * 1000;
  if (now - paymentTime > 5 * 60 * 1000) {
    return { valid: false, error: 'Payment expired' };
  }

  // Validate signature format (64-byte hex for ECDSA)
  if (!/^[0-9a-fA-F]{128,132}$/.test(payload.signature)) {
    return { valid: false, error: 'Invalid signature format' };
  }

  // Validate Ethereum address format
  if (!/^0x[0-9a-fA-F]{40}$/.test(payload.address)) {
    return { valid: false, error: 'Invalid wallet address' };
  }

  // TODO: In production, verify signature cryptographically
  // This would call a smart contract or use viem/ethers to verify
  // the payment was actually made to X402_RECIPIENT for X402_AMOUNT

  return {
    valid: true,
    walletAddress: payload.address.toLowerCase()
  };
}

export function getPaymentRequirements(): {
  recipient: string;
  amount: string;
  network: string;
  interval: string;
  description: string;
} {
  return {
    recipient: X402_RECIPIENT ?? '',
    amount: X402_AMOUNT,
    network: X402_NETWORK,
    interval: X402_INTERVAL,
    description: `$${X402_AMOUNT} per month subscription to Moltx Webhook Bridge`
  };
}