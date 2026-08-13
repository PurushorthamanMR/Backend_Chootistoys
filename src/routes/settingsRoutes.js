const express = require('express');
const multer = require('multer');
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
const { importSettingsData } = require('../controllers/importController');
const { authenticateOptional, authenticate, requireAdmin, requireSuperAdmin, requireAdminOrPosSettings } = require('../middleware/auth');

const router = express.Router();

// Buffered in memory - the file is just a small SQL text dump, validated and
// piped to the `mysql` CLI in importController, never written to disk.
const sqlUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter(req, file, cb) {
    if (!file.originalname.toLowerCase().endsWith('.sql')) {
      return cb(new Error('Only .sql files are allowed'));
    }
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 },
});

router.get('/', authenticateOptional, getSettings);
router.put('/', authenticate, requireAdminOrPosSettings, updateSettings);
router.get('/email', authenticate, requireAdmin, getEmailSettings);
router.get('/drive', authenticate, requireAdmin, getDriveSettings);
router.get('/drive/oauth/start', authenticate, requireAdmin, startDriveOAuth);
// Google redirects the browser here — no JWT; state is a short-lived signed token.
router.get('/drive/oauth/callback', driveOAuthCallback);
router.get('/setup-status', authenticate, requireAdmin, getSetupStatus);
router.get('/export/structure', authenticate, requireSuperAdmin, exportStructure);
router.get('/export/data', authenticate, requireSuperAdmin, exportData);
router.post('/import/data', authenticate, requireSuperAdmin, sqlUpload.single('file'), importSettingsData);
router.get('/wholesale-token', authenticate, requireAdmin, getWholesaleToken);
router.post('/wholesale-token/regenerate', authenticate, requireAdmin, regenerateWholesaleToken);

router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'File is too large. Maximum allowed size is 2MB.' });
  }
  if (err instanceof multer.MulterError || err.message === 'Only .sql files are allowed') {
    return res.status(400).json({ message: err.message || 'Upload failed' });
  }
  next(err);
});

module.exports = router;
