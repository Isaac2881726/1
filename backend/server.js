// src/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const staffRoutes = require('./routes/staff');
const { startOrderTimeoutCron } = require('./utils/cron');

const app = express();

app.use(cors());
app.use(express.json());

// Basic abuse protection on auth endpoints (login/register brute-forcing).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth', authLimiter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/staff', staffRoutes);

// Centralized 404
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Centralized error handler (catches anything thrown outside route try/catch)
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Campus Eats API listening on port ${PORT}`);
  startOrderTimeoutCron();
});
