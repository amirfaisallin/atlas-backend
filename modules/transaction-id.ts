import { depositRequestsCollection, transactionsCollection } from './db';

const MIN_9 = 100_000_000;
const MAX_9 = 999_999_999;
const MIN_11 = 10_000_000_000;
const MAX_11 = 99_999_999_999;

/** Reject IDs with repeated pattern (e.g. 456456, 123123123) or all same digit */
function isTrivialPattern(s: string, len: number): boolean {
  if (len === 9) {
    const allSame = /^(\d)\1{8}$/.test(s);
    if (allSame) return true;
    const threeRepeat = s.length >= 3 && s.slice(0, 3) === s.slice(3, 6) && s.slice(0, 3) === s.slice(6, 9);
    if (threeRepeat) return true;
  }
  if (len === 11) {
    const allSame = /^(\d)\1{10}$/.test(s);
    if (allSame) return true;
  }
  return false;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Generate unique 9-digit numeric transaction ID for deposits. No letters, no duplicate, no trivial patterns. */
export async function generateDepositTransactionId(): Promise<string> {
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    const num = randomInt(MIN_9, MAX_9);
    const s = String(num);
    if (isTrivialPattern(s, 9)) continue;
    const exists =
      (await depositRequestsCollection().findOne({ userTransactionId: s })) ||
      (await transactionsCollection().findOne({ userTransactionId: s }));
    if (!exists) return s;
  }
  const fallback = String(Date.now() % 1_000_000_000).padStart(9, '0');
  if (fallback.length > 9) return fallback.slice(-9);
  return fallback;
}

/** Generate unique 11-digit numeric transaction ID for withdrawals. No letters, no duplicate. */
export async function generateWithdrawalTransactionId(): Promise<string> {
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    const num = randomInt(MIN_11, MAX_11);
    const s = String(num);
    if (isTrivialPattern(s, 11)) continue;
    const exists = await transactionsCollection().findOne({ userTransactionId: s });
    if (!exists) return s;
  }
  const fallback = String(Date.now()).padStart(11, '0').slice(-11);
  return fallback;
}
