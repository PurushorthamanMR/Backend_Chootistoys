const express = require('express');
const {
  getSettings,
  updateSettings,
  getEmailSettings,
  getDriveSettings,
  startDriveOAuth,
  driveOAuthCallback,
  getSetupStatus,
  getWholesaleToken,
  regenerateWholesaleToken,
} = require('../controllers/settingsController');
const { exportStructure, exportData } = require('../controllers/exportController');
const { authenticateOptional, authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateOptional, getSettings);
router.put('/', authenticate, requireAdmin, updateSettings);
router.get('/email', authenticate, requireAdmin, getEmailSettings);
router.get('/drive', authenticate, requireAdmin, getDriveSettings);
router.get('/drive/oauth/start', authenticate, requireAdmin, startDriveOAuth);
// Google redirects the browser here — no JWT; state is a short-lived signed token.
router.get('/drive/oauth/callback', driveOAuthCallback);
router.get('/setup-status', authenticate, requireAdmin, getSetupStatus);
router.get('/export/structure', authenticate, requireSuperAdmin, exportStructure);
router.get('/export/data', authenticate, requireSuperAdmin, exportData);
router.get('/wholesale-token', authenticate, requireAdmin, getWholesaleToken);
router.post('/wholesale-token/regenerate', authenticate, requireAdmin, regenerateWholesaleToken);

module.exports = router;
