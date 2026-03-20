import type { Request, Response } from 'express';
import { gatewayConfigCollection } from './db';
import type { DepositMethodConfig, WithdrawalMethodConfig } from './db';

const CONFIG_ID = 'default';

const DEFAULT_DEPOSIT_METHODS: DepositMethodConfig[] = [
  { id: 'trc20', label: 'TRX Tron TRC20', logoUrl: 'https://i.postimg.cc/rmfhxvRz/images-(1).jpg', qrCodeUrl: 'https://i.postimg.cc/85ZF8Grs/Screenshot-20260308-170621.jpg', paymentNumber: 'TUojmYtNFvoJPb4TRD2JUz9mN7q39by16X', type: 'crypto', minAmount: 10, maxAmount: 10000, order: 0, enabled: true },
  { id: 'binance_trc20', label: 'Binance', logoUrl: 'https://i.postimg.cc/2jXv1q6H/Binance-Coin-Twitter.jpg', qrCodeUrl: 'https://i.postimg.cc/P5CSLsTf/photo-2026-03-14-05-52-53.jpg', paymentNumber: 'Your Binance address', type: 'crypto', minAmount: 10, maxAmount: 10000, order: 1, enabled: true },
  { id: 'nagad', label: 'Nagad', logoUrl: 'https://i.postimg.cc/GhdFdMBh/unnamed.jpg', paymentNumber: '01613870127', type: 'mobile', minAmount: 10, maxAmount: 180, order: 2, enabled: true },
  { id: 'bkash', label: 'Bkash', logoUrl: 'https://i.postimg.cc/Qxwy6G4m/images-(2).jpg', paymentNumber: '01613870127', type: 'mobile', minAmount: 10, maxAmount: 180, order: 3, enabled: true },
];

const DEFAULT_WITHDRAWAL_METHODS: WithdrawalMethodConfig[] = [
  { id: 'bkash', label: 'Bkash', logoUrl: 'https://i.postimg.cc/Qxwy6G4m/images-(2).jpg', placeholder: 'Enter Bkash number', minAmount: 10, maxAmount: 180, order: 0, enabled: true },
  { id: 'nagad', label: 'Nagad', logoUrl: 'https://i.postimg.cc/GhdFdMBh/unnamed.jpg', placeholder: 'Enter Nagad number', minAmount: 10, maxAmount: 180, order: 1, enabled: true },
  { id: 'trc20', label: 'TRX Tron TRC20', logoUrl: 'https://i.postimg.cc/rmfhxvRz/images-(1).jpg', placeholder: 'Enter TRX Tron TRC20 address', minAmount: 10, maxAmount: 10000, order: 2, enabled: true },
  { id: 'binance_trc20', label: 'Binance', logoUrl: 'https://i.postimg.cc/2jXv1q6H/Binance-Coin-Twitter.jpg', placeholder: 'Enter Binance address', minAmount: 10, maxAmount: 10000, order: 3, enabled: true },
];

function sortByOrder<T extends { order: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.order - b.order);
}

/** DB থেকে লোড করা মেথডে enabled সবসময় boolean রাখা – পুরনো ডাটায় enabled নেই তাই ডিফল্ট true */
function normalizeEnabled<T extends { enabled?: boolean }>(m: T): T & { enabled: boolean } {
  return { ...m, enabled: m.enabled !== false };
}

/** Public (মেইন সাইট): শুধু enabled পেমেন্ট মেথড রিটার্ন। Off থাকলে দেখাবে না। */
export async function handleGetGatewayConfigPublic(_req: Request, res: Response): Promise<void> {
  try {
    const doc = await gatewayConfigCollection().findOne({ id: CONFIG_ID });
    const allDeposit = sortByOrder(doc?.depositMethods?.length ? doc.depositMethods : DEFAULT_DEPOSIT_METHODS);
    const allWithdrawal = sortByOrder(doc?.withdrawalMethods?.length ? doc.withdrawalMethods : DEFAULT_WITHDRAWAL_METHODS);
    const depositMethods = allDeposit.filter((m) => m.enabled !== false);
    const withdrawalMethods = allWithdrawal.filter((m) => m.enabled !== false);
    res.json({ depositMethods, withdrawalMethods });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: সব মেথড রিটার্ন (enabled/disabled সহ), এডিটের জন্য। DB-এর মানই রিটার্ন – অফ থাকলে অফই থাকবে। */
export async function handleGetGatewayConfig(_req: Request, res: Response): Promise<void> {
  try {
    const doc = await gatewayConfigCollection().findOne({ id: CONFIG_ID });
    const rawDeposit = sortByOrder(doc?.depositMethods?.length ? doc.depositMethods : DEFAULT_DEPOSIT_METHODS);
    const rawWithdrawal = sortByOrder(doc?.withdrawalMethods?.length ? doc.withdrawalMethods : DEFAULT_WITHDRAWAL_METHODS);
    const depositMethods = rawDeposit.map(normalizeEnabled);
    const withdrawalMethods = rawWithdrawal.map(normalizeEnabled);
    res.json({ depositMethods, withdrawalMethods });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: save gateway config – enabled সঠিকভাবে সেভ হয় যাতে রিফ্রেশ/পুনরায় খোলার পর অটো অন না হয় */
export async function handlePutGatewayConfig(req: Request, res: Response): Promise<void> {
  try {
    const { depositMethods, withdrawalMethods } = req.body as {
      depositMethods?: (DepositMethodConfig & { enabled?: boolean })[];
      withdrawalMethods?: (WithdrawalMethodConfig & { enabled?: boolean })[];
    };
    if (!Array.isArray(depositMethods) || !Array.isArray(withdrawalMethods)) {
      res.status(400).json({ error: 'depositMethods and withdrawalMethods arrays are required' });
      return;
    }
    const now = new Date().toISOString();
    const normalizedDeposit = sortByOrder(depositMethods.map((m) => ({ ...m, enabled: m.enabled !== false })));
    const normalizedWithdrawal = sortByOrder(withdrawalMethods.map((m) => ({ ...m, enabled: m.enabled !== false })));
    const doc = {
      id: CONFIG_ID,
      depositMethods: normalizedDeposit,
      withdrawalMethods: normalizedWithdrawal,
      updatedAt: now,
    };
    await gatewayConfigCollection().updateOne(
      { id: CONFIG_ID },
      { $set: doc },
      { upsert: true }
    );
    res.json({ depositMethods: doc.depositMethods, withdrawalMethods: doc.withdrawalMethods });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
