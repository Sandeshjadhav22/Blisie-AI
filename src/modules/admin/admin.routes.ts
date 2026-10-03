import { Router } from 'express';
import { isValidObjectId } from 'mongoose';

import { getAuthUser, requireAdmin, requireAuth } from '../../middleware/require-auth.js';
import { UserModel } from '../../models/user.model.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { isUserAdmin, toPublicUser } from '../users/users.service.js';

export const adminRouter = Router();

adminRouter.use(requireAuth);
adminRouter.use(requireAdmin);

/**
 * List users with status filter and counts for admin dashboard.
 */
adminRouter.get('/users', async (req, res) => {
  const statusParam = typeof req.query.access === 'string' ? req.query.access.trim() : 'all';
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const skip = (page - 1) * limit;

  const filter: Record<string, unknown> = {};

  if (statusParam && statusParam !== 'all') {
    filter.access = statusParam;
  }

  if (search) {
    filter.$or = [
      { email: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } },
    ];
  }

  const [users, total, countWaitlist, countApproved, countRejected, countAll] = await Promise.all([
    UserModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('accessDecidedBy', 'name email'),
    UserModel.countDocuments(filter),
    UserModel.countDocuments({ access: 'waitlist' }),
    UserModel.countDocuments({ access: 'approved' }),
    UserModel.countDocuments({ access: 'rejected' }),
    UserModel.countDocuments({}),
  ]);

  const items = users.map((user) => {
    const adminRef = user.accessDecidedBy as unknown as { _id: unknown; name: string; email: string } | null;
    return {
      id: user.id,
      name: user.name,
      email: user.email ?? null,
      avatarUrl: user.avatarUrl ?? null,
      access: user.access,
      isAdmin: isUserAdmin(user.email),
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      accessDecidedAt: user.accessDecidedAt ? user.accessDecidedAt.toISOString() : null,
      accessDecidedBy: adminRef
        ? { id: String(adminRef._id), name: adminRef.name, email: adminRef.email }
        : null,
      channels: user.channels.map((c) => ({
        type: c.type,
        username: c.username ?? null,
        linkedAt: c.linkedAt.toISOString(),
      })),
    };
  });

  res.json({
    users: items,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    },
    counts: {
      all: countAll,
      waitlist: countWaitlist,
      approved: countApproved,
      rejected: countRejected,
    },
  });
});

/**
 * Approve a user for beta access.
 */
adminRouter.post('/users/:id/approve', async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    throw new ValidationError([{ path: ['id'], message: 'Invalid user ID' }]);
  }

  const admin = getAuthUser(req);
  const user = await UserModel.findById(id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  user.access = 'approved';
  user.accessDecidedAt = new Date();
  user.accessDecidedBy = admin._id;
  await user.save();

  res.json({
    success: true,
    user: toPublicUser(user),
    message: `${user.email || user.name} has been approved.`,
  });
});

/**
 * Reject a user's beta access request.
 */
adminRouter.post('/users/:id/reject', async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    throw new ValidationError([{ path: ['id'], message: 'Invalid user ID' }]);
  }

  const admin = getAuthUser(req);
  const user = await UserModel.findById(id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  user.access = 'rejected';
  user.accessDecidedAt = new Date();
  user.accessDecidedBy = admin._id;
  await user.save();

  res.json({
    success: true,
    user: toPublicUser(user),
    message: `${user.email || user.name} has been rejected.`,
  });
});

/**
 * Delete a user from waitlist/database.
 */
adminRouter.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) {
    throw new ValidationError([{ path: ['id'], message: 'Invalid user ID' }]);
  }

  const user = await UserModel.findByIdAndDelete(id);
  if (!user) {
    throw new NotFoundError('User not found');
  }

  res.json({
    success: true,
    message: `User ${user.email || user.name} has been removed.`,
  });
});
