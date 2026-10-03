import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { UserModel } from '../src/models/user.model.js';
import { useTestDatabase } from './helpers/db.js';
import { createSignedInUser } from './helpers/session.js';

useTestDatabase();

const app = createApp();

beforeEach(async () => {
  await UserModel.deleteMany({});
});

describe('Waitlist & Admin API', () => {
  it('allows visitors to join the waitlist with their email', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .send({ email: 'tester@example.com', name: 'Tester' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('waitlist');
    expect(res.body.email).toBe('tester@example.com');

    const user = await UserModel.findOne({ email: 'tester@example.com' });
    expect(user).toBeTruthy();
    expect(user?.access).toBe('waitlist');
  });

  it('auto-approves admin email on waitlist submit', async () => {
    const res = await request(app)
      .post('/api/v1/waitlist')
      .send({ email: 'sandeshjadhav2002@gmail.com' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('approved');
    expect(res.body.isAdmin).toBe(true);
  });

  it('checks waitlist status for an email', async () => {
    await UserModel.create({
      email: 'waiting@example.com',
      name: 'Waiting User',
      access: 'waitlist',
    });

    const res = await request(app)
      .get('/api/v1/waitlist/status')
      .query({ email: 'waiting@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.status).toBe('waitlist');
  });

  it('blocks non-admin users from admin routes', async () => {
    const { cookie } = await createSignedInUser({
      email: 'regular@example.com',
      access: 'approved',
    });

    const res = await request(app).get('/api/v1/admin/users').set('Cookie', cookie);

    expect(res.status).toBe(403);
  });

  it('allows admin users to view waitlisted users and approve/reject them', async () => {
    const { cookie: adminCookie, user: adminUser } = await createSignedInUser({
      email: 'sandeshjadhav2002@gmail.com',
      access: 'approved',
    });

    const waitlisted = await UserModel.create({
      email: 'candidate@example.com',
      name: 'Candidate',
      access: 'waitlist',
    });

    // 1. Admin lists users
    const listRes = await request(app).get('/api/v1/admin/users').set('Cookie', adminCookie);

    expect(listRes.status).toBe(200);
    expect(listRes.body.users.length).toBeGreaterThanOrEqual(2);
    expect(listRes.body.counts.waitlist).toBe(1);

    // 2. Admin approves candidate
    const approveRes = await request(app)
      .post(`/api/v1/admin/users/${waitlisted.id}/approve`)
      .set('Cookie', adminCookie);

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    const updated = await UserModel.findById(waitlisted.id);
    expect(updated?.access).toBe('approved');
    expect(updated?.accessDecidedBy?.toString()).toBe(adminUser.id);

    // 3. Admin rejects candidate
    const rejectRes = await request(app)
      .post(`/api/v1/admin/users/${waitlisted.id}/reject`)
      .set('Cookie', adminCookie);

    expect(rejectRes.status).toBe(200);
    const rejected = await UserModel.findById(waitlisted.id);
    expect(rejected?.access).toBe('rejected');
  });

  it('blocks waitlisted users from protected data routes', async () => {
    const { cookie } = await createSignedInUser({
      email: 'waitlisted@example.com',
      access: 'waitlist',
    });

    const res = await request(app).get('/api/v1/calendar/events').set('Cookie', cookie);

    expect(res.status).toBe(403);
  });
});
