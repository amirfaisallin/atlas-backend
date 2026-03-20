import type { Request, Response } from 'express';
import { verificationRequestsCollection, type VerificationRequestDoc } from './db';
import { getUserById, setUserVerified } from './admin-users';
import { uploadBase64ToCloudinary, isCloudinaryConfigured } from './cloudinary';

const VERIFICATION_FOLDER = 'altrix-verification';

/** User: get own verification status (verified flag + whether a request is pending) */
export async function handleGetMyVerificationStatus(req: Request, res: Response): Promise<void> {
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
    const verified = !!user.verified;
    const verifiedAt = user.verifiedAt;
    const pending = await verificationRequestsCollection().findOne({
      accountId,
      status: 'pending',
    });
    res.json({ verified, hasPendingRequest: !!pending, verifiedAt: verifiedAt || undefined });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** User: submit NID or Passport verification request (info + document images) */
export async function handleSubmitVerificationRequest(req: Request, res: Response): Promise<void> {
  try {
    const {
      accountId,
      type,
      fullName,
      documentNumber,
      dateOfBirth,
      fullAddress,
      documentImages,
    } = req.body as {
      accountId?: string;
      type?: 'passport' | 'nid';
      fullName?: string;
      documentNumber?: string;
      dateOfBirth?: string;
      fullAddress?: string;
      documentImages?: string[];
    };

    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'accountId is required' });
      return;
    }
    if (type !== 'passport' && type !== 'nid') {
      res.status(400).json({ error: 'type must be passport or nid' });
      return;
    }
    if (!fullName || typeof fullName !== 'string' || fullName.trim() === '') {
      res.status(400).json({ error: 'fullName is required' });
      return;
    }
    if (!documentNumber || typeof documentNumber !== 'string' || documentNumber.trim() === '') {
      res.status(400).json({ error: 'documentNumber is required' });
      return;
    }
    if (!dateOfBirth || typeof dateOfBirth !== 'string') {
      res.status(400).json({ error: 'dateOfBirth is required' });
      return;
    }
    if (!fullAddress || typeof fullAddress !== 'string') {
      res.status(400).json({ error: 'fullAddress is required' });
      return;
    }
    if (!Array.isArray(documentImages) || documentImages.length === 0) {
      res.status(400).json({ error: 'At least one document image is required' });
      return;
    }

    const user = await getUserById(accountId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (!isCloudinaryConfigured()) {
      res.status(503).json({ error: 'Image upload is not configured. Please try again later.' });
      return;
    }

    const uploadedUrls: string[] = [];
    for (let i = 0; i < documentImages.length; i++) {
      const img = documentImages[i];
      if (typeof img !== 'string') continue;
      const url = await uploadBase64ToCloudinary(img, VERIFICATION_FOLDER);
      if (url) uploadedUrls.push(url);
    }
    if (uploadedUrls.length === 0) {
      res.status(503).json({ error: 'Document image upload failed. Please try again.' });
      return;
    }

    const id = `VR-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const now = new Date().toISOString();
    const doc: VerificationRequestDoc = {
      id,
      accountId,
      type,
      fullName: fullName.trim(),
      documentNumber: documentNumber.trim(),
      dateOfBirth: dateOfBirth.trim(),
      fullAddress: fullAddress.trim(),
      documentImages: uploadedUrls,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await verificationRequestsCollection().insertOne(doc as VerificationRequestDoc & { _id?: unknown });
    res.status(201).json({ id, message: 'Verification request submitted' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: list all verification requests */
export async function handleListVerificationRequests(_req: Request, res: Response): Promise<void> {
  try {
    const docs = await verificationRequestsCollection()
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ requests: docs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: approve verification – set user as verified */
export async function handleVerifyVerificationRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const vr = await verificationRequestsCollection().findOne({ id });
    if (!vr) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }
    if (vr.status !== 'pending') {
      res.status(400).json({ error: 'Request is not pending' });
      return;
    }
    const now = new Date().toISOString();
    await verificationRequestsCollection().updateOne(
      { id },
      { $set: { status: 'verified', updatedAt: now, reviewedAt: now } }
    );
    await setUserVerified(vr.accountId, true, now);
    res.json({ ok: true, status: 'verified' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: reject verification – user remains unverified */
export async function handleRejectVerificationRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const vr = await verificationRequestsCollection().findOne({ id });
    if (!vr) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }
    if (vr.status !== 'pending') {
      res.status(400).json({ error: 'Request is not pending' });
      return;
    }
    const now = new Date().toISOString();
    await verificationRequestsCollection().updateOne(
      { id },
      { $set: { status: 'rejected', updatedAt: now, reviewedAt: now } }
    );
    await setUserVerified(vr.accountId, false);
    res.json({ ok: true, status: 'rejected' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: delete one verification request. If it was verified, user is set unverified. */
export async function handleDeleteVerificationRequest(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const vr = await verificationRequestsCollection().findOne({ id });
    if (!vr) {
      res.status(404).json({ error: 'Verification request not found' });
      return;
    }
    if (vr.status === 'verified') {
      await setUserVerified(vr.accountId, false);
    }
    await verificationRequestsCollection().deleteOne({ id });
    res.json({ deleted: true, id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

/** Admin: delete all verification requests. Verified users are set unverified. */
export async function handleDeleteAllVerificationRequests(_req: Request, res: Response): Promise<void> {
  try {
    const all = await verificationRequestsCollection().find({}).toArray();
    const verifiedAccountIds = all.filter((r) => r.status === 'verified').map((r) => r.accountId);
    for (const accountId of verifiedAccountIds) {
      await setUserVerified(accountId, false);
    }
    await verificationRequestsCollection().deleteMany({});
    res.json({ deleted: true, count: all.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
