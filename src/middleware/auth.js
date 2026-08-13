const jwt = require('jsonwebtoken');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

function authenticateOptional(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return next();
  }
  const token = header.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    // ignore invalid/expired token on optional auth routes
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !['Admin', 'SuperAdmin'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'SuperAdmin') {
    return res.status(403).json({ message: 'Super Admin access required' });
  }
  next();
}

function requirePos(req, res, next) {
  if (!req.user || !['Staff', 'Admin', 'SuperAdmin'].includes(req.user.role)) {
    return res.status(403).json({ message: 'POS access required' });
  }
  next();
}

// Scoped for the env-only PosSettings login (Backend/.env POS_USERNAME/POS_PASSWORD)
// - only used on PUT /api/settings, never on requireAdmin itself, so this role
// can't reach products/orders/users APIs.
function requireAdminOrPosSettings(req, res, next) {
  if (!req.user || !['Admin', 'SuperAdmin', 'PosSettings'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
}

module.exports = {
  authenticate,
  authenticateOptional,
  requireAdmin,
  requireSuperAdmin,
  requirePos,
  requireAdminOrPosSettings,
};
