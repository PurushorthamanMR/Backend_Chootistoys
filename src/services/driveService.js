const { google } = require('googleapis');
const { Readable } = require('stream');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function buildOAuthClient(config) {
  return new google.auth.OAuth2(
    config.drive_client_id,
    config.drive_client_secret,
    config.redirectUri
  );
}

function buildDriveClient(config) {
  const oauth2 = buildOAuthClient(config);
  oauth2.setCredentials({ refresh_token: config.drive_refresh_token });
  return google.drive({ version: 'v3', auth: oauth2 });
}

function getAuthUrl(config, state) {
  const oauth2 = buildOAuthClient(config);
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: DRIVE_SCOPES,
    state,
  });
}

async function exchangeCode(config, code) {
  const oauth2 = buildOAuthClient(config);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.refresh_token) {
    const error = new Error(
      'Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions, then connect again.'
    );
    error.status = 400;
    throw error;
  }
  return tokens.refresh_token;
}

/** Accept a raw ID or a full Drive folder URL. */
function normalizeFolderId(raw) {
  const value = String(raw || '').trim();
  const fromUrl = value.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return fromUrl ? fromUrl[1] : value;
}

/** Uploads a file into the configured Drive folder and returns a publicly viewable URL. */
async function uploadFile(config, buffer, filename, mimetype) {
  const drive = buildDriveClient(config);
  const folderId = normalizeFolderId(config.drive_folder_id);

  try {
    const { data: file } = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { mimeType: mimetype, body: Readable.from(buffer) },
      fields: 'id',
      supportsAllDrives: true,
    });

    await drive.permissions.create({
      fileId: file.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });

    return `https://drive.google.com/thumbnail?id=${file.id}&sz=w2000`;
  } catch (err) {
    const detail = err?.errors?.[0]?.message || err?.message || String(err);
    let friendly;
    if (/invalid_grant|Token has been expired or revoked/i.test(detail)) {
      friendly =
        'Google Drive upload failed: the connection expired. Open Settings → Google Drive and click Connect Google Account again.';
    } else if (/File not found|insufficient permission|notFound/i.test(detail)) {
      friendly =
        'Google Drive upload failed: the folder was not found or your Google account cannot write to it. Check the Folder ID and that you own or can edit that folder.';
    } else if (/storage quota/i.test(detail)) {
      friendly =
        'Google Drive upload failed: your Google account storage is full. Free up space in Drive or use another Google account.';
    } else {
      friendly = `Google Drive upload failed: ${detail}`;
    }
    const error = new Error(friendly);
    error.status = 502;
    throw error;
  }
}

module.exports = { uploadFile, getAuthUrl, exchangeCode, DRIVE_SCOPES };
