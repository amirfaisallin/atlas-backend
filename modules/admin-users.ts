import type { Request, Response } from 'express';
import { usersCollection, toAdminUser, type UserDoc, depositRequestsCollection, withdrawalRequestsCollection, verificationCodesCollection } from './db';
import { emitAdminNotification } from './admin-socket';
import { uploadBase64ToCloudinary, isCloudinaryConfigured } from './cloudinary';

export type UserStatus = 'active' | 'blocked' | 'banned' | 'deleted';

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  password?: string;
  registrationDate: string; // ISO
  status: UserStatus;
  role?: string;
  lastLoginAt?: string;
  /** Real account balance – আপডেট হওয়ার সাথে সাথে ডাটাবেজে সেভ হয় */
  realBalance?: number;
  balanceUpdatedAt?: string;
  /** Admin-only promo account flag – main site never sees this */
  promoAccount?: boolean;
  /** Admin-set promo balance (virtual balance for admin view only) */
  promoBalance?: number;
  /** Identity verification approved by admin */
  verified?: boolean;
  verifiedAt?: string;
  /** Profile photo URL (Cloudinary) */
  profilePhoto?: string;
}

async function listUsers(): Promise<AdminUser[]> {
  const cursor = usersCollection()
    .find({ status: { $ne: 'deleted' } })
    .sort({ registrationDate: -1 });
  const docs = await cursor.toArray();
  return docs.map(toAdminUser);
}

async function findByEmail(email: string): Promise<AdminUser | undefined> {
  const norm = email.trim().toLowerCase();
  const doc = await usersCollection().findOne({
    email: { $regex: new RegExp(`^${escapeRegex(norm)}$`, 'i') },
  });
  return doc ? toAdminUser(doc) : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function getUserById(id: string): Promise<AdminUser | undefined> {
  const doc = await usersCollection().findOne({ id });
  return doc ? toAdminUser(doc) : undefined;
}

/** রিয়েল অ্যাকাউন্ট ব্যালেন্স আপডেট – সঙ্গে সঙ্গে ডাটাবেজে সেভ হয় */
export async function setUserRealBalance(accountId: string, balance: number): Promise<void> {
  const now = new Date().toISOString();
  await usersCollection().updateOne(
    { id: accountId },
    { $set: { realBalance: balance, balanceUpdatedAt: now } }
  );
}

/** Promo balance থেকে রিয়েল ব্যালেন্সে ক্রেডিট – existing realBalance এর সাথে যোগ হয় */
export async function creditPromoToRealBalance(accountId: string, creditAmount: number): Promise<void> {
  if (!(typeof creditAmount === 'number' && Number.isFinite(creditAmount) && creditAmount > 0)) {
    throw new Error('creditAmount must be a positive number');
  }
  const user = await getUserById(accountId);
  if (!user) {
    throw new Error('User not found');
  }
  const current = typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
  const next = current + creditAmount;
  const now = new Date().toISOString();
  await usersCollection().updateOne(
    { id: accountId },
    {
      $set: {
        realBalance: next,
        balanceUpdatedAt: now,
      },
    }
  );
}

/** Promo account flag + promo balance – admin-only, does not affect real wallet */
export async function setUserPromoAccount(
  accountId: string,
  promoAccount: boolean,
  promoBalance?: number
): Promise<void> {
  const update: Record<string, unknown> = {
    promoAccount,
  };
  if (typeof promoBalance === 'number' && Number.isFinite(promoBalance) && promoBalance >= 0) {
    update.promoBalance = promoBalance;
  }
  await usersCollection().updateOne(
    { id: accountId },
    {
      $set: update,
    }
  );
}

/** User verification status (NID/Passport) – admin Verify করলে true + verifiedAt */
export async function setUserVerified(accountId: string, verified: boolean, verifiedAt?: string): Promise<void> {
  if (verified) {
    await usersCollection().updateOne(
      { id: accountId },
      { $set: { verified: true, verifiedAt: verifiedAt || new Date().toISOString() } }
    );
  } else {
    await usersCollection().updateOne(
      { id: accountId },
      { $set: { verified: false }, $unset: { verifiedAt: '' } }
    );
  }
}

/** প্রোফাইল ফটো URL (Cloudinary) সেভ – প্রোফাইল পেজ থেকে আপলোড করলে কল হয় */
export async function setUserProfilePhoto(accountId: string, profilePhotoUrl: string): Promise<void> {
  await usersCollection().updateOne(
    { id: accountId },
    { $set: { profilePhoto: profilePhotoUrl } }
  );
}

/** প্রোফাইল নাম আপডেট – প্রোফাইল থেকে সেট করলে লিডারবোর্ডেও ওই নাম দেখায় */
export async function setUserProfileName(accountId: string, name: string): Promise<void> {
  const safe = name.trim().slice(0, 100) || 'TRADERX';
  await usersCollection().updateOne(
    { id: accountId },
    { $set: { name: safe } }
  );
}

/**
 * Admin: update user's profile name (leaderboard display).
 * Body: { name: string }
 */
export async function handleAdminSetUserProfileName(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const body = (req.body || {}) as { name?: string };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!id || typeof id !== 'string') {
      res.status(400).json({ error: 'User id is required' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await setUserProfileName(id, name);
    const updated = await getUserById(id);
    res.json({ ok: true, name: updated?.name ?? name.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site থেকে রিয়েল ব্যালেন্স সিঙ্ক – লোড/আপডেটের সাথে সাথে ডাটাবেজে সেভ। শুধু রিয়েল অ্যাকাউন্ট। */
export async function handleSyncBalance(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, realBalance, accountType } = req.body as {
      accountId?: string;
      realBalance?: number;
      accountType?: string;
    };
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    if (accountType === 'demo') {
      res.json({ ok: true });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (typeof realBalance === 'number' && Number.isFinite(realBalance) && realBalance >= 0) {
      await setUserRealBalance(accountId, realBalance);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** ওয়েবসাইটে রেজিস্ট্রেশন করলে কল হয় – নতুন ইউজার MongoDB তে সেভ হয়, কম ডাটা (নাম/ইমেইল লিমিট, টাইমস্ট্যাম্প, ডিফল্ট ফিল্ড ওমিট) */
const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 254;

export async function registerUser(
  name: string,
  email: string,
  accountId: string,
  password?: string
): Promise<AdminUser | null> {
  const existing = await findByEmail(email);
  if (existing) return null;
  const id = accountId;
  const userDoc: UserDoc = {
    id,
    name: name.trim().slice(0, MAX_NAME_LEN),
    email: email.trim().toLowerCase().slice(0, MAX_EMAIL_LEN),
    ...(password != null && password !== '' && { password: String(password) }),
    registrationDate: Date.now(),
    status: 'active',
  };
  await usersCollection().insertOne(userDoc as UserDoc & { _id?: unknown });
  return toAdminUser(userDoc);
}

export async function handleRegister(req: Request, res: Response): Promise<void> {
  try {
    const { name, email, accountId, password } = req.body as {
      name?: string;
      email?: string;
      accountId?: string;
      password?: string;
    };
    if (
      !name ||
      typeof name !== 'string' ||
      !email ||
      typeof email !== 'string' ||
      !accountId ||
      typeof accountId !== 'string'
    ) {
      res.status(400).json({ error: 'Name, email and accountId are required' });
      return;
    }
    const user = await registerUser(name, email, accountId, password);
    if (!user) {
      res.status(409).json({ error: 'This email is already registered' });
      return;
    }
    emitAdminNotification({ type: 'new_user', id: user.id, name: user.name, email: user.email });
    res.status(201).json(user);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site: ইউজারের রিয়েল ব্যালেন্স ডাটাবেজ থেকে রিটার্ন (localStorage না, DB source of truth) */
export async function handleGetMyBalance(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const realBalance =
      typeof user.realBalance === 'number' && Number.isFinite(user.realBalance) ? user.realBalance : 0;
    res.json({ realBalance });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

const PROFILE_PHOTO_FOLDER = 'altrix-profile';

/** Main site: ইউজারের প্রোফাইল ডেটা (নাম ইত্যাদি) – লোডে সিঙ্ক, লিডারবোর্ডে ওই নাম দেখায় */
export async function handleGetProfile(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ name: user.name ?? 'TRADERX', profilePhoto: user.profilePhoto ?? null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site: প্রোফাইল নাম আপডেট – সেভ করলে MongoDB তে সেভ হয়, লিডারবোর্ডে ওই নাম দেখাবে */
export async function handleUpdateProfile(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, name } = (req.body || {}) as { accountId?: string; name?: string };
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const newName = typeof name === 'string' ? name.trim() : '';
    if (!newName) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    await setUserProfileName(accountId, newName);
    res.json({ ok: true, name: newName.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site: ইউজারের প্রোফাইল ফটো (Cloudinary URL) ডাটাবেজ থেকে রিটার্ন */
export async function handleGetProfilePhoto(req: Request, res: Response): Promise<void> {
  try {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId.trim() : '';
    if (!accountId) {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json({ profilePhoto: user.profilePhoto ?? null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site: প্রোফাইল ফটো আপলোড – Cloudinary তে সেভ, MongoDB তে URL সেভ */
export async function handleUploadProfilePhoto(req: Request, res: Response): Promise<void> {
  try {
    const { accountId, image } = (req.body || {}) as { accountId?: string; image?: string };
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    if (!image || typeof image !== 'string') {
      res.status(400).json({ error: 'image (base64 data URL) is required' });
      return;
    }
    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (!isCloudinaryConfigured()) {
      res.status(503).json({ error: 'Profile photo upload is not configured' });
      return;
    }
    const cloudinaryUrl = await uploadBase64ToCloudinary(image, PROFILE_PHOTO_FOLDER);
    if (!cloudinaryUrl) {
      res.status(500).json({ error: 'Failed to upload image' });
      return;
    }
    await setUserProfilePhoto(accountId, cloudinaryUrl);
    res.json({ profilePhoto: cloudinaryUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Main site: login – only registered users with correct email + password can sign in. */
export async function handleLogin(req: Request, res: Response): Promise<void> {
  try {
    const { email, password } = (req.body || {}) as { email?: string; password?: string };
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }
    const user = await findByEmail(email);
    if (!user || !user.password || user.password !== password) {
      // Do not reveal whether the email exists – generic error
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    if (user.status === 'banned' || user.status === 'deleted') {
      res.json({ status: user.status });
      return;
    }
    const now = new Date().toISOString();
    await usersCollection().updateOne({ id: user.id }, { $set: { lastLoginAt: now } });
    res.json({
      status: user.status,
      accountId: user.id,
      name: user.name,
      email: user.email,
      lastLoginAt: now,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Forgot password: send 6-digit verification code to email (dev: return in response) */
export async function handleForgotPasswordSendCode(req: Request, res: Response): Promise<void> {
  try {
    const { email } = (req.body || {}) as { email?: string };
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const user = await findByEmail(email);
    if (!user || !user.email) {
      // Do not reveal whether email exists
      res.status(200).json({ ok: true });
      return;
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    await verificationCodesCollection().deleteMany({ accountId: user.id });
    await verificationCodesCollection().insertOne({
      accountId: user.id,
      code,
      email: user.email,
      createdAt: now.toISOString(),
      expiresAt,
    });
    // TODO: production: send code via email provider instead of returning it
    res.json({ ok: true, devCode: code });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Forgot password: verify code + set new password; same password used for main-site login */
export async function handleForgotPasswordReset(req: Request, res: Response): Promise<void> {
  try {
    const { email, code, newPassword } = (req.body || {}) as {
      email?: string;
      code?: string;
      newPassword?: string;
    };
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    if (!code || typeof code !== 'string' || code.trim().length !== 6) {
      res.status(400).json({ error: 'Invalid code' });
      return;
    }
    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
      return;
    }
    const user = await findByEmail(email);
    if (!user) {
      // generic
      res.status(400).json({ error: 'Invalid code or email' });
      return;
    }
    const coll = verificationCodesCollection();
    const doc = await coll.findOne({ accountId: user.id, code: code.trim() });
    if (!doc) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }
    if (new Date(doc.expiresAt).getTime() < Date.now()) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }
    await usersCollection().updateOne({ id: user.id }, { $set: { password: newPassword } });
    await coll.deleteMany({ accountId: user.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Simple admin-panel login using single password stored in .env (ADMIN_PANEL_PASSWORD) */
export async function handleAdminPanelLogin(req: Request, res: Response): Promise<void> {
  try {
    const { password } = (req.body || {}) as { password?: string };
    const expected = process.env.ADMIN_PANEL_PASSWORD || 'altrixofficial007';
    if (!password || typeof password !== 'string') {
      res.status(400).json({ ok: false, error: 'Password is required' });
      return;
    }
    if (password !== expected) {
      res.status(401).json({ ok: false, error: 'Invalid password' });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}

/** লগইন/অ্যাপ লোডে কল – ব্যান বা ব্লক থাকলে ফ্রন্টেন্ড লগআউট বা লগইন ব্লক করবে */
export async function handleUserStatus(req: Request, res: Response): Promise<void> {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const user = await findByEmail(email);
    if (!user) {
      res.json({ status: 'active' as const });
      return;
    }
    res.json({ status: user.status });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function handleListUsers(_req: Request, res: Response): Promise<void> {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function handleGetUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
}

/** Admin: সরাসরি রিয়েল ব্যালেন্স সেট – amount একদম নতুন ভ্যালু হবে */
export async function handleAdminSetRealBalance(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const body = (req.body || {}) as { balance?: number };
    const balance = body.balance;
    if (!(typeof balance === 'number' && Number.isFinite(balance) && balance >= 0)) {
      res.status(400).json({ error: 'balance must be a non-negative number' });
      return;
    }
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    await setUserRealBalance(id, balance);
    const updated = await getUserById(id);
    res.json(updated ?? user);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: promo amount থেকে রিয়েল ব্যালেন্সে ক্রেডিট – একবারের জন্য ম্যানুয়াল টপআপ */
export async function handleCreditPromoToReal(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const body = (req.body || {}) as { amount?: number };
    const amount = body.amount;
    if (!(typeof amount === 'number' && Number.isFinite(amount) && amount > 0)) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    await creditPromoToRealBalance(id, amount);
    const updated = await getUserById(id);
    res.json(updated ?? user);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: set promo account flag + optional promo balance for a user */
export async function handleSetPromoAccount(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const body = (req.body || {}) as {
      promoAccount?: boolean;
      promoBalance?: number;
    };
    if (typeof body.promoAccount !== 'boolean') {
      res.status(400).json({ error: 'promoAccount (boolean) is required' });
      return;
    }
    const promoBalance =
      typeof body.promoBalance === 'number' && Number.isFinite(body.promoBalance) && body.promoBalance >= 0
        ? body.promoBalance
        : undefined;
    await setUserPromoAccount(id, body.promoAccount, promoBalance);
    const updated = await getUserById(id);
    res.json(updated ?? user);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: get user details with deposit & withdrawal history for User Details page */
export async function handleGetUserDetails(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const [deposits, withdrawals] = await Promise.all([
      depositRequestsCollection().find({ accountId: id }).sort({ createdAt: -1 }).toArray(),
      withdrawalRequestsCollection().find({ accountId: id }).sort({ createdAt: -1 }).toArray(),
    ]);
    res.json({
      user,
      deposits: deposits.map((d) => ({
        id: d.id,
        userTransactionId: d.userTransactionId,
        amount: d.amount,
        paymentMethod: d.paymentMethod,
        status: d.status,
        createdAt: d.createdAt,
      })),
      withdrawals: withdrawals.map((w) => ({
        id: w.id,
        userTransactionId: w.userTransactionId,
        amount: w.amount,
        paymentMethod: w.paymentMethod,
        status: w.status,
        createdAt: w.createdAt,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export async function handleBlockUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.status === 'banned') {
    res.status(400).json({ error: 'Cannot block a banned user' });
    return;
  }
  await usersCollection().updateOne({ id }, { $set: { status: 'blocked' } });
  res.json({ ...user, status: 'blocked' as const });
}

export async function handleUnblockUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.status === 'banned') {
    res.status(400).json({ error: 'Cannot unblock a banned user' });
    return;
  }
  await usersCollection().updateOne({ id }, { $set: { status: 'active' } });
  res.json({ ...user, status: 'active' as const });
}

export async function handleBanUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await usersCollection().updateOne({ id }, { $set: { status: 'banned' } });
  res.json({ ...user, status: 'banned' as const });
}

export async function handleUnbanUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const user = await getUserById(id);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  await usersCollection().updateOne({ id }, { $set: { status: 'active' } });
  res.json({ ...user, status: 'active' as const });
}

/** Admin: delete user – sets status to deleted; user is logged out and sees "Account deleted" on next login */
export async function handleDeleteUser(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (user.status === 'deleted') {
      res.status(400).json({ error: 'User account is already deleted' });
      return;
    }
    await usersCollection().updateOne({ id }, { $set: { status: 'deleted' } });
    res.json({ ...user, status: 'deleted' as const });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
