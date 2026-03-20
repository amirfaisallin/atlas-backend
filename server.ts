import './loadEnv';
import http from 'http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import * as oanda from './modules/oanda';
import * as adminUsers from './modules/admin-users';
import * as userTrades from './modules/user-trades';
import * as depositRequests from './modules/deposit-requests';
import * as withdrawalRequests from './modules/withdrawal-requests';
import * as gatewayConfig from './modules/gateway-config';
import * as userVerification from './modules/user-verification';
import * as landingContent from './modules/landing-content';
import * as marketVisibility from './modules/market-visibility';
import * as leaderboard from './modules/leaderboard';
import * as notifications from './modules/notifications';
import * as promoCodes from './modules/promo-codes';
import * as menuLinks from './modules/menu-links';
import * as supportConfig from './modules/support-config';
import { connectDb } from './modules/db';
import { setAdminSocket } from './modules/admin-socket';
import { isOTCSymbol } from './otc-market-algorithm/constants.js';
import * as otcHandlers from './otc-market-algorithm/handlers.js';
import * as otcAdminHandlers from './otc-market-algorithm/admin-handlers.js';
import { startOTCEngine } from './otc-market-algorithm/engine.js';

const PORT = Number(process.env.API_PORT || process.env.PORT) || 3001;

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});
setAdminSocket(io);
app.use(express.json({ limit: '10mb' }));

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Health check – dev:all waits for this before starting frontend (avoids ECONNREFUSED)
app.get('/api/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/api/instruments/:pair/candles', (req, res, next) => {
  if (isOTCSymbol(req.params.pair)) return otcHandlers.handleCandles(req, res).catch(next);
  return oanda.handleCandles(req, res).catch(next);
});
app.get('/api/instruments/:pair/price', (req, res, next) => {
  if (isOTCSymbol(req.params.pair)) return otcHandlers.handlePrice(req, res).catch(next);
  return oanda.handlePrice(req, res).catch(next);
});

// OTC pending trade registration (main site when user places OTC trade)
app.post('/api/otc/pending-trade', (req, res, next) => otcHandlers.handlePendingTrade(req, res).catch(next));

// ওয়েবসাইট রেজিস্ট্রেশন – MongoDB তে ইউজার সেভ হয়, এডমিন প্যানেলে দেখাবে
app.post('/api/register', adminUsers.handleRegister);

// Login – only registered users with correct email + password can sign in
app.post('/api/login', adminUsers.handleLogin);

// Forgot password – send code + reset
app.post('/api/forgot-password/send-code', adminUsers.handleForgotPasswordSendCode);
app.post('/api/forgot-password/reset', adminUsers.handleForgotPasswordReset);

// Admin panel simple password login (no user account) – front-end admin app uses this
app.post('/api/admin-panel/login', adminUsers.handleAdminPanelLogin);

// ইউজার স্ট্যাটাস – ব্যান/ব্লক চেক (লগইন ও অ্যাপ লোডে)
app.get('/api/user-status', adminUsers.handleUserStatus);
// রিয়েল ব্যালেন্স ডাটাবেজ থেকে (localStorage না)
app.get('/api/me/balance', adminUsers.handleGetMyBalance);
// রিয়েল অ্যাকাউন্ট ট্রেড হিস্টোরি ডাটাবেজ থেকে (Analytics – same as admin)
app.get('/api/me/trades', userTrades.handleGetMyTrades);
// প্রোফাইল – নাম লোড/আপডেট (লিডারবোর্ডে ওই নাম দেখায়)
app.get('/api/me/profile', adminUsers.handleGetProfile);
app.patch('/api/me/profile', adminUsers.handleUpdateProfile);
// প্রোফাইল ফটো – Cloudinary URL ডাটাবেজ থেকে / আপলোড
app.get('/api/me/profile-photo', adminUsers.handleGetProfilePhoto);
app.post('/api/me/profile-photo', adminUsers.handleUploadProfilePhoto);

// User trade recording (main site when real trade settles)
app.post('/api/user-trade', userTrades.handleRecordTrade);

// Sync real balance on load so admin can see current balance
app.post('/api/user-balance', adminUsers.handleSyncBalance);

// Deposit request – ইউজার টপ-আপ করে ট্রানজেকশন আইডি + স্ক্রিনশট দিলে রিকোয়েস্ট তৈরি হয়
app.post('/api/deposit-request', depositRequests.handleCreateDepositRequest);
// ইউজার নিজের ডিপোজিট রিকোয়েস্ট লিস্ট (ট্রানজেকশন হিস্টোরিতে Pending/Successful/Failed দেখানোর জন্য)
app.get('/api/my-deposits', depositRequests.handleMyDepositRequests);

// Withdrawal – send code (step 1), then create request with code (step 2)
app.post('/api/withdrawal/send-code', withdrawalRequests.handleSendWithdrawalCode);
app.post('/api/withdrawal-request', withdrawalRequests.handleCreateWithdrawalRequest);
app.get('/api/my-withdrawals', withdrawalRequests.handleMyWithdrawalRequests);

// User verification (NID / Passport) – status + submit from main site
app.get('/api/me/verification-status', userVerification.handleGetMyVerificationStatus);
app.post('/api/verification-request', userVerification.handleSubmitVerificationRequest);

// Landing page content (public – main site fetches this)
app.get('/api/landing-content', landingContent.handleGetLandingContent);

// Market visibility: which names show in main site "Select an asset" only (no other API change)
app.get('/api/markets/enabled', marketVisibility.handleGetEnabled);

// Leaderboard – top 10 + optional viewing user's rank and positions to top 10
app.get('/api/leaderboard', leaderboard.handleGetLeaderboard);

// Notifications – public list for main site
app.get('/api/notifications', notifications.handleGet);

// Promo codes – public list for deposit (code + bonus %)
app.get('/api/promo-codes', promoCodes.handleGet);

// Menu links – public (Join Telegram, Affiliate Program URLs for main site menu)
app.get('/api/menu-links', menuLinks.handleGet);

// Support config – public (support email used on login banners)
app.get('/api/support-config', supportConfig.handleGet);

// Admin API – user management
app.get('/api/admin/users', adminUsers.handleListUsers);
app.get('/api/admin/users/:id/trades', userTrades.handleGetUserTrades);
app.get('/api/admin/users/:id/details', adminUsers.handleGetUserDetails);
app.get('/api/admin/users/:id', adminUsers.handleGetUser);
app.patch('/api/admin/users/:id/promo', adminUsers.handleSetPromoAccount);
app.patch('/api/admin/users/:id/promo-credit', adminUsers.handleCreditPromoToReal);
app.patch('/api/admin/users/:id/real-balance', adminUsers.handleAdminSetRealBalance);
app.patch('/api/admin/users/:id/block', adminUsers.handleBlockUser);
app.patch('/api/admin/users/:id/unblock', adminUsers.handleUnblockUser);
app.patch('/api/admin/users/:id/ban', adminUsers.handleBanUser);
app.patch('/api/admin/users/:id/unban', adminUsers.handleUnbanUser);
app.patch('/api/admin/users/:id/delete', adminUsers.handleDeleteUser);

// Admin – deposit manage (accept, reject, edit amount)
app.get('/api/admin/deposit-requests', depositRequests.handleListDepositRequests);
app.post('/api/admin/deposit-requests/hide-rejected', depositRequests.handleHideRejectedDepositRequests);
app.get('/api/admin/deposit-requests/:id', depositRequests.handleGetDepositRequest);
app.patch('/api/admin/deposit-requests/:id/amount', depositRequests.handleUpdateDepositAmount);
app.patch('/api/admin/deposit-requests/:id/accept', depositRequests.handleAcceptDepositRequest);
app.patch('/api/admin/deposit-requests/:id/reject', depositRequests.handleRejectDepositRequest);
app.delete('/api/admin/deposit-requests/:id', depositRequests.handleDeleteDepositRequest);
app.delete('/api/admin/deposit-requests', depositRequests.handleDeleteAllDepositRequests);

// Admin – withdrawal manage (accept, reject)
app.get('/api/admin/withdrawal-requests', withdrawalRequests.handleListWithdrawalRequests);
app.patch('/api/admin/withdrawal-requests/:id/accept', withdrawalRequests.handleAcceptWithdrawalRequest);
app.patch('/api/admin/withdrawal-requests/:id/reject', withdrawalRequests.handleRejectWithdrawalRequest);
app.delete('/api/admin/withdrawal-requests/:id', withdrawalRequests.handleDeleteWithdrawalRequest);
app.delete('/api/admin/withdrawal-requests', withdrawalRequests.handleDeleteAllWithdrawalRequests);

// Admin – user verification (Verify / Reject)
app.get('/api/admin/verification-requests', userVerification.handleListVerificationRequests);
app.patch('/api/admin/verification-requests/:id/verify', userVerification.handleVerifyVerificationRequest);
app.patch('/api/admin/verification-requests/:id/reject', userVerification.handleRejectVerificationRequest);
app.delete('/api/admin/verification-requests/:id', userVerification.handleDeleteVerificationRequest);
app.delete('/api/admin/verification-requests', userVerification.handleDeleteAllVerificationRequests);

// Admin – landing page content (edit from admin panel)
app.get('/api/admin/landing-content', landingContent.handleAdminGetLandingContent);
app.put('/api/admin/landing-content', landingContent.handleAdminUpdateLandingContent);

// Admin – market visibility (controls names shown in main site "Select an asset")
app.get('/api/admin/markets', marketVisibility.handleAdminGet);
app.put('/api/admin/markets', marketVisibility.handleAdminPut);

// Admin – OTC market manipulation (per-symbol toggle; last 10s price override so majority loses)
app.get('/api/admin/otc-manipulation', otcAdminHandlers.handleAdminGetOtcManipulation);
app.patch('/api/admin/otc-manipulation', otcAdminHandlers.handleAdminPatchOtcManipulation);

// Admin – notifications (warning, website update, promo code)
app.get('/api/admin/notifications', notifications.handleAdminList);
app.post('/api/admin/notifications', notifications.handleAdminCreate);
app.put('/api/admin/notifications/:id', notifications.handleAdminUpdate);
app.delete('/api/admin/notifications/:id', notifications.handleAdminDelete);

// Admin – promo codes (code + bonus %)
app.get('/api/admin/promo-codes', promoCodes.handleAdminList);
app.put('/api/admin/promo-codes/config', promoCodes.handleAdminPutConfig);
app.post('/api/admin/promo-codes', promoCodes.handleAdminCreate);
app.put('/api/admin/promo-codes/:id', promoCodes.handleAdminUpdate);
app.delete('/api/admin/promo-codes/:id', promoCodes.handleAdminDelete);

// Admin – menu links (Telegram URL, Affiliate Program URL)
app.get('/api/admin/menu-links', menuLinks.handleAdminGet);
app.put('/api/admin/menu-links', menuLinks.handleAdminPut);

// Admin – support config (support email)
app.get('/api/admin/support-config', supportConfig.handleAdminGet);
app.put('/api/admin/support-config', supportConfig.handleAdminPut);

// Gateway config – মেইন সাইটে শুধু On করা মেথড, অ্যাডমিনে সব
app.get('/api/gateway/config', gatewayConfig.handleGetGatewayConfigPublic);
app.get('/api/admin/gateway/config', gatewayConfig.handleGetGatewayConfig);
app.put('/api/admin/gateway/config', gatewayConfig.handlePutGatewayConfig);

async function start() {
  try {
    await connectDb();
  } catch (err) {
    console.error('MongoDB connection failed:', err);
    console.error('Set MONGODB_URI in .env (or Heroku Config Vars) and restart.');
    process.exit(1);
  }
  await startOTCEngine(io);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`API server running on http://0.0.0.0:${PORT}`);
    console.log(`Admin real-time notifications: Socket.IO enabled`);
    console.log(`OTC market algorithm: 14 assets, 1s ticks, 60s batch persist`);
  });
}

start();
