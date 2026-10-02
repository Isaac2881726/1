// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { verifyToken, requireStaff } = require('../middleware/auth');

const router = express.Router();
const SALT_ROUNDS = 12;

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ------------------------------------------------------------
// POST /api/auth/register  — customer self-registration
// ------------------------------------------------------------
router.post('/register', async (req, res) => {
  try {
    const { fullName, email, phone, password, buildingId, roomNumber } = req.body;

    if (!fullName || !isValidEmail(email) || !phone || !password) {
      return res.status(400).json({ error: 'fullName, valid email, phone, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await pool.query('SELECT id FROM customers WHERE email = $1', [email.toLowerCase()]);
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const result = await pool.query(
      `INSERT INTO customers (full_name, email, phone, password_hash, building_id, room_number)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, full_name, email, phone, building_id, room_number, created_at`,
      [fullName, email.toLowerCase(), phone, passwordHash, buildingId || null, roomNumber || null]
    );

    const customer = result.rows[0];
    const token = signToken({ id: customer.id, type: 'customer' });

    res.status(201).json({ token, customer });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/login  — works for BOTH customers and staff.
// Body: { email, password, as: 'customer' | 'staff' }
// Keeping the two tables separate (rather than one polymorphic
// users table) makes it easy to keep staff permissions distinct.
// ------------------------------------------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password, as } = req.body;
    const userType = as === 'staff' ? 'staff' : 'customer';

    if (!isValidEmail(email) || !password) {
      return res.status(400).json({ error: 'Valid email and password are required' });
    }

    const table = userType === 'staff' ? 'staff' : 'customers';
    const result = await pool.query(
      `SELECT * FROM ${table} WHERE email = $1`,
      [email.toLowerCase()]
    );

    const account = result.rows[0];
    // Compare against a dummy hash if not found, so response timing doesn't
    // reveal whether the email exists (basic timing-attack mitigation).
    const hashToCompare = account ? account.password_hash : '$2b$12$invalidsaltinvalidsaltinvalidsal';
    const passwordMatches = await bcrypt.compare(password, hashToCompare);

    if (!account || !passwordMatches) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (userType === 'staff' && account.is_active === false) {
      return res.status(403).json({ error: 'Staff account is deactivated' });
    }

    const tokenPayload =
      userType === 'staff'
        ? { id: account.id, type: 'staff', role: account.role }
        : { id: account.id, type: 'customer' };

    const token = signToken(tokenPayload);
    delete account.password_hash;

    res.json({ token, [userType]: account });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ------------------------------------------------------------
// POST /api/auth/staff/register — admin-only staff creation.
// (Not one of the required routes, but staff accounts have to
// come from somewhere other than public self-signup.)
// ------------------------------------------------------------
router.post('/staff/register', verifyToken, requireStaff('admin'), async (req, res) => {
  try {
    const { fullName, email, phone, password, role } = req.body;
    if (!fullName || !isValidEmail(email) || !phone || !password) {
      return res.status(400).json({ error: 'fullName, valid email, phone, and password are required' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO staff (full_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, email, phone, role, created_at`,
      [fullName, email.toLowerCase(), phone, passwordHash, role || 'runner']
    );

    res.status(201).json({ staff: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A staff account with this email already exists' });
    }
    console.error('staff register error', err);
    res.status(500).json({ error: 'Staff registration failed' });
  }
});

module.exports = router;
