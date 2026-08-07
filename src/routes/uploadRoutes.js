const express = require('express');
const multer = require('multer');
const { authenticateOptional } = require('../middleware/auth');
const { uploadImage } = require('../controllers/uploadController');

// Buffered in memory (not written to disk here) - uploadController decides per-request
// whether to send it to Google Drive or fall back to writing it into backend/uploads.
const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (!file.mimetype.startsWith('image/')) {
    return cb(new Error('Only image files are allowed'));
  }
  cb(null, true);
}

const MAX_FILE_SIZE_MB = 10;

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
});

const router = express.Router();

router.post('/', authenticateOptional, upload.single('image'), uploadImage);

router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: `Image is too large. Maximum allowed size is ${MAX_FILE_SIZE_MB}MB.` });
  }
  res.status(400).json({ message: err.message || 'Upload failed' });
});

module.exports = router;
