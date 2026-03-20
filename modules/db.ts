import { MongoClient, type Collection, type Db } from 'mongodb';
import type { AdminUser } from './admin-users';

let client: MongoClient | null = null;
let db: Db | null = null;

export interface UserDoc {
  _id?: string;
  id: string;
  name: string;
  email: string;
  password?: string;
  /** Stored as number (ms) to save space; toAdminUser returns ISO string */
  registrationDate: string | number;
  status: 'active' | 'blocked' | 'banned' | 'deleted';
  role?: string;
  lastLoginAt?: string;
  /** Real account balance – শুধু রিয়েল অ্যাকাউন্টের ব্যালেন্স ডাটাবেজে সেভ হয় */
  realBalance?: number;
  /** Last time real balance was updated (ISO string) */
  balanceUpdatedAt?: string;
  /** Admin-only promo account flag – main site never reads this */
  promoAccount?: boolean;
  /** Admin-set promo balance (for reporting only; does not affect real balance) */
  promoBalance?: number;
  /** Identity verification (NID/Passport) approved by admin */
  verified?: boolean;
  /** When admin approved verification (ISO string) */
  verifiedAt?: string;
  /** Profile photo URL (Cloudinary) – প্রোফাইল থেকে সেট করলে Cloudinary তে সেভ হয় */
  profilePhoto?: string;
}

/** One document per trade – শুধু রিয়েল অ্যাকাউন্টের ট্রেড সেভ হয় */
export interface TradeDoc {
  _id?: string;
  userId: string;
  accountType: 'real';
  trade: Record<string, unknown>;
  createdAt: string;
}

/** Deposit request from user – টপ-আপ পেমেন্ট রিকোয়েস্ট */
export interface DepositRequestDoc {
  _id?: string;
  id: string;
  /** 9-digit numeric ID shown to user (no letters), unique */
  userTransactionId?: string;
  accountId: string;
  amount: number;
  paymentMethod: string;
  /** পেমেন্টের ট্রানজেকশন আইডি – user-entered payment reference */
  transactionId: string;
  /** Cloudinary URL (screenshots are stored on Cloudinary, not in MongoDB) */
  screenshot?: string;
  screenshotName?: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
  /** Admin panel only: when true, hidden from admin list but still visible to user on main site */
  adminHidden?: boolean;
}

/** Manual Gateway – ডিপোজিট ও উইথড্রল পেমেন্ট মেথড কনফিগ (লোগো, QR, লিমিট) */
export interface DepositMethodConfig {
  id: string;
  label: string;
  logoUrl?: string;
  qrCodeUrl?: string;
  paymentNumber: string;
  type: 'crypto' | 'mobile';
  minAmount: number;
  maxAmount: number;
  order: number;
  /** false = মেইন সাইটে দেখাবে না, true = দেখাবে */
  enabled?: boolean;
}

export interface WithdrawalMethodConfig {
  id: string;
  label: string;
  logoUrl: string;
  placeholder: string;
  minAmount: number;
  maxAmount: number;
  order: number;
  /** false = মেইন সাইটে দেখাবে না, true = দেখাবে */
  enabled?: boolean;
}

export interface GatewayConfigDoc {
  _id?: unknown;
  id: string;
  depositMethods: DepositMethodConfig[];
  withdrawalMethods: WithdrawalMethodConfig[];
  updatedAt: string;
}

/** ট্রানজেকশন হিস্টোরি – ডিপোজিট/উইথড্রল সব ডাটাবেজে সেভ (Pending/Successful/Failed) */
export interface TransactionDoc {
  _id?: string;
  id: string;
  /** 9-digit (deposit) or 11-digit (withdrawal) numeric ID shown to user, unique */
  userTransactionId?: string;
  accountId: string;
  type: 'deposit' | 'withdrawal';
  referenceId: string;
  amount: number;
  paymentMethod: string;
  status: 'pending' | 'successful' | 'failed';
  createdAt: string;
  updatedAt?: string;
}

/** Withdrawal request from user – ব্যালেন্স কেটে পেন্ডিং, এডমিন একসেপ্ট করলে সাকসেস */
export interface WithdrawalRequestDoc {
  _id?: string;
  id: string;
  userTransactionId?: string;
  accountId: string;
  amount: number;
  paymentMethod: string;
  /** Wallet/account address or number */
  address: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

/** Email verification code for withdrawal (expires in 10 min) */
export interface VerificationCodeDoc {
  _id?: string;
  accountId: string;
  code: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

/** User identity verification request (NID or Passport) – admin Verify/Reject */
export interface VerificationRequestDoc {
  _id?: string;
  id: string;
  accountId: string;
  type: 'passport' | 'nid';
  fullName: string;
  documentNumber: string;
  dateOfBirth: string;
  fullAddress: string;
  /** Uploaded image URLs (Cloudinary or data URLs) */
  documentImages: string[];
  status: 'pending' | 'verified' | 'rejected';
  createdAt: string;
  updatedAt?: string;
  reviewedAt?: string;
}

export async function connectDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI || '';
  const dbName = process.env.MONGODB_DB_NAME || 'altrix';
  if (!uri) {
    throw new Error('MONGODB_URI is not set in environment variables. Add it to .env or Heroku Config Vars.');
  }
  if (db) return db;
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  console.log(`MongoDB connected: database "${dbName}"`);
  return db;
}

export function getDb(): Db | null {
  return db;
}

export function usersCollection(): Collection<UserDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<UserDoc>('users');
}

export function tradesCollection(): Collection<TradeDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<TradeDoc>('trades');
}

export function depositRequestsCollection(): Collection<DepositRequestDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<DepositRequestDoc>('deposit_requests');
}

export function transactionsCollection(): Collection<TransactionDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<TransactionDoc>('transactions');
}

export function gatewayConfigCollection(): Collection<GatewayConfigDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<GatewayConfigDoc>('gateway_config');
}

export function withdrawalRequestsCollection(): Collection<WithdrawalRequestDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<WithdrawalRequestDoc>('withdrawal_requests');
}

export function verificationCodesCollection(): Collection<VerificationCodeDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<VerificationCodeDoc>('verification_codes');
}

export function verificationRequestsCollection(): Collection<VerificationRequestDoc> {
  if (!db) throw new Error('Database not connected. Call connectDb() first.');
  return db.collection<VerificationRequestDoc>('verification_requests');
}

export function toAdminUser(doc: UserDoc): AdminUser {
  const regDate = doc.registrationDate;
  return {
    id: doc.id,
    name: doc.name,
    email: doc.email,
    password: doc.password,
    registrationDate: typeof regDate === 'number' ? new Date(regDate).toISOString() : regDate,
    status: doc.status,
    role: doc.role ?? 'user',
    lastLoginAt: doc.lastLoginAt,
    realBalance: doc.realBalance ?? 0,
    balanceUpdatedAt: doc.balanceUpdatedAt,
    promoAccount: doc.promoAccount ?? false,
    promoBalance: typeof doc.promoBalance === 'number' ? doc.promoBalance : undefined,
    verified: doc.verified,
    verifiedAt: doc.verifiedAt,
    profilePhoto: doc.profilePhoto,
  };
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('MongoDB connection closed.');
  }
}
