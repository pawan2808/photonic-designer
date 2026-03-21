/**
 * license.js — License Manager with Google Drive Backend
 * 
 * Validates licenses against a Google Sheet you control.
 * Supports: activation, heartbeat, revocation, expiry, fingerprint binding.
 * 
 * Google Sheet layout (Sheet1):
 *   A: LicenseKey | B: Fingerprint | C: Status | D: ExpiryDate | E: LastSeen | F: Version | G: Email | H: Notes
 * 
 * Status values: ACTIVE, REVOKED, EXPIRED, UNUSED
 */

const { google } = require('googleapis');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const Store = require('electron-store');
const fingerprint = require('./fingerprint');

const store = new Store({ name: 'license', encryptionKey: 'phd-enc-2026' });

// How often to re-validate (ms)
const HEARTBEAT_INTERVAL = 30 * 60 * 1000; // 30 minutes
const GRACE_PERIOD = 2 * 60 * 60 * 1000;   // 2 hours offline grace

class LicenseManager {
  constructor() {
    this.sheets = null;
    this.config = null;
    this.heartbeatTimer = null;
    this.isValid = false;
    this.licenseInfo = null;
  }

  /**
   * Initialize with Google service account credentials.
   * Config file: config/license_config.json
   * Credentials: config/google_credentials.json
   */
  async init(resourcesPath) {
    try {
      const configPath = path.join(resourcesPath, 'config', 'license_config.json');
      const credsPath = path.join(resourcesPath, 'config', 'google_credentials.json');

      if (!fs.existsSync(configPath)) {
        log.warn('License config not found — running in DEMO mode');
        this.config = { mode: 'demo' };
        this.isValid = true;
        return { valid: true, mode: 'demo' };
      }

      this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      // Demo mode — skip all license checks
      if (this.config.mode === 'demo') {
        log.info('Running in DEMO mode — no license required');
        this.isValid = true;
        return { valid: true, mode: 'demo' };
      }

      if (fs.existsSync(credsPath)) {
        const auth = new google.auth.GoogleAuth({
          keyFile: credsPath,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });
        this.sheets = google.sheets({ version: 'v4', auth });
      }

      // Check if we have a stored license
      const stored = store.get('license');
      if (stored?.key && stored?.validated) {
        // ALWAYS verify online on startup — no grace period for launch
        if (this.sheets) {
          try {
            log.info('Verifying license online...');
            const isValid = await this._verifyOnline(stored.key);
            if (isValid) {
              this.isValid = true;
              this.licenseInfo = stored;
              this._startHeartbeat();
              return { valid: true, info: stored };
            } else {
              // License revoked or expired
              return { valid: false, needsActivation: true };
            }
          } catch (e) {
            log.warn('Online verification failed:', e.message);
            // Only allow grace period if we can't reach Google (offline)
            const elapsed = Date.now() - (stored.lastCheck || 0);
            if (elapsed < GRACE_PERIOD) {
              log.info('Offline — using cached license (grace period)');
              this.isValid = true;
              this.licenseInfo = stored;
              this._startHeartbeat();
              return { valid: true, info: stored };
            }
          }
        }
      }

      return { valid: false, needsActivation: true };
    } catch (err) {
      log.error('License init error:', err);
      return { valid: false, error: err.message };
    }
  }

  /**
   * Activate a license key. Binds to this machine's fingerprint.
   */
  async activate(licenseKey) {
    try {
      if (this.config?.mode === 'demo') {
        return { success: true, mode: 'demo' };
      }

      if (!this.sheets) {
        throw new Error('Google Sheets not configured. Place google_credentials.json in config/');
      }

      const key = licenseKey.trim().toUpperCase();
      const fp = await fingerprint.generate();

      // Read all license rows from the sheet
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.config.sheetId,
        range: 'Sheet1!A:H'
      });

      const rows = response.data.values || [];
      const headerRow = rows[0] || [];
      let rowIndex = -1;
      let row = null;

      // Find the matching license key (skip header)
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0]?.trim().toUpperCase() === key) {
          rowIndex = i;
          row = rows[i];
          break;
        }
      }

      if (!row) {
        return { success: false, error: 'Invalid license key' };
      }

      const status = (row[2] || '').toUpperCase();
      const boundFingerprint = row[1] || '';
      const expiryDate = row[3] || '';

      // Check if revoked
      if (status === 'REVOKED') {
        return { success: false, error: 'This license has been revoked. Contact support.' };
      }

      // Check if expired
      if (expiryDate && new Date(expiryDate) < new Date()) {
        return { success: false, error: `License expired on ${expiryDate}` };
      }

      // Check if already bound to a different machine
      if (boundFingerprint && boundFingerprint !== fp.fingerprint) {
        return {
          success: false,
          error: 'License is already activated on another machine. Contact support to transfer.'
        };
      }

      // Activate: write fingerprint, status, and heartbeat
      const now = new Date().toISOString();
      const version = require('./package.json').version;
      const rangeStr = `Sheet1!B${rowIndex + 1}:F${rowIndex + 1}`;

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.sheetId,
        range: rangeStr,
        valueInputOption: 'USER_ENTERED',
        resource: {
          values: [[fp.fingerprint, 'ACTIVE', expiryDate || '', now, version]]
        }
      });

      // Store locally
      const info = {
        key: key,
        fingerprint: fp.fingerprint,
        status: 'ACTIVE',
        expiry: expiryDate,
        lastCheck: Date.now(),
        validated: true
      };
      store.set('license', info);
      this.isValid = true;
      this.licenseInfo = info;
      this._startHeartbeat();

      return { success: true, info };
    } catch (err) {
      log.error('Activation error:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Verify license is still valid (called periodically).
   */
  async _verifyOnline(licenseKey) {
    if (!this.sheets || this.config?.mode === 'demo') return true;

    try {
      const key = licenseKey || store.get('license.key');
      if (!key) return false;

      const fp = await fingerprint.generate();

      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.config.sheetId,
        range: 'Sheet1!A:H'
      });

      const rows = response.data.values || [];
      let rowIndex = -1;
      let row = null;

      for (let i = 1; i < rows.length; i++) {
        if (rows[i][0]?.trim().toUpperCase() === key.toUpperCase()) {
          rowIndex = i;
          row = rows[i];
          break;
        }
      }

      if (!row) {
        this._invalidate('License key not found in database');
        return false;
      }

      const status = (row[2] || '').toUpperCase();
      const boundFp = row[1] || '';
      const expiry = row[3] || '';

      // Check revocation (you changed it in Google Sheet)
      if (status === 'REVOKED') {
        this._invalidate('License has been revoked');
        return false;
      }

      // Check expiry
      if (expiry && new Date(expiry) < new Date()) {
        this._invalidate('License has expired');
        return false;
      }

      // Check fingerprint match
      if (boundFp && boundFp !== fp.fingerprint) {
        this._invalidate('License transferred to another machine');
        return false;
      }

      // Update heartbeat
      const now = new Date().toISOString();
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.sheetId,
        range: `Sheet1!E${rowIndex + 1}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[now]] }
      });

      // Update local store
      store.set('license.lastCheck', Date.now());
      store.set('license.validated', true);
      this.isValid = true;

      return true;
    } catch (err) {
      log.warn('Online verification failed (may be offline):', err.message);
      // Allow grace period for offline use
      const lastCheck = store.get('license.lastCheck', 0);
      if (Date.now() - lastCheck > GRACE_PERIOD) {
        this._invalidate('Cannot verify license — offline too long');
        return false;
      }
      return true; // Still within grace period
    }
  }

  /**
   * Invalidate the local license (revoked, expired, or tampered).
   */
  _invalidate(reason) {
    log.warn('License invalidated:', reason);
    this.isValid = false;
    store.set('license.validated', false);
    store.set('license.invalidReason', reason);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    // Emit event for main process to show dialog
    if (this.onInvalidated) {
      this.onInvalidated(reason);
    }
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this._verifyOnline().catch(e => log.warn('Heartbeat failed:', e));
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Deactivate license on this machine (e.g., user moving to new PC).
   */
  async deactivate() {
    try {
      const key = store.get('license.key');
      if (key && this.sheets && this.config?.mode !== 'demo') {
        const response = await this.sheets.spreadsheets.values.get({
          spreadsheetId: this.config.sheetId,
          range: 'Sheet1!A:H'
        });
        const rows = response.data.values || [];
        for (let i = 1; i < rows.length; i++) {
          if (rows[i][0]?.trim().toUpperCase() === key.toUpperCase()) {
            await this.sheets.spreadsheets.values.update({
              spreadsheetId: this.config.sheetId,
              range: `Sheet1!B${i + 1}:C${i + 1}`,
              valueInputOption: 'USER_ENTERED',
              resource: { values: [['', 'UNUSED']] }
            });
            break;
          }
        }
      }
    } catch (e) {
      log.warn('Remote deactivation failed:', e.message);
    }

    store.delete('license');
    this.isValid = false;
    this.licenseInfo = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  getStoredLicense() {
    return store.get('license');
  }
}

module.exports = new LicenseManager();