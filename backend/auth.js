// src/middleware/auth.js
// JWT verification middleware. Two flavours: customers and staff carry a
// `type` claim in their token so routes can tell them apart and staff routes
// can additionally check `role`.

const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, type: 'customer' | 'staff', role? }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireCustomer(req, res, next) {
  if (req.user?.type !== 'customer') {
    return res.status(403).json({ error: 'Customer account required' });
  }
  next();
}

function requireStaff(...allowedRoles) {
  return (req, res, next) => {
    if (req.user?.type !== 'staff') {
      return res.status(403).json({ error: 'Staff account required' });
    }
    if (allowedRoles.length && !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient staff permissions' });
    }
    next();
  };
}

module.exports = { verifyToken, requireCustomer, requireStaff };
