/**
 * fingerprint.js — Machine Fingerprint Generator
 * 
 * Creates a unique, stable hardware fingerprint for license binding.
 * Combines: CPU ID, primary MAC address, disk serial, OS UUID, hostname.
 * The fingerprint survives reboots and minor software changes.
 */

const { machineIdSync } = require('node-machine-id');
const si = require('systeminformation');
const crypto = require('crypto');
const os = require('os');

class MachineFingerprint {
  constructor() {
    this._fingerprint = null;
    this._details = null;
  }

  /**
   * Generate a SHA-256 fingerprint from hardware identifiers.
   * Returns { fingerprint: string, details: object }
   */
  async generate() {
    if (this._fingerprint) {
      return { fingerprint: this._fingerprint, details: this._details };
    }

    const parts = {};

    // 1. OS-level machine ID (most stable identifier)
    try {
      parts.machineId = machineIdSync({ original: true });
    } catch (e) {
      parts.machineId = 'unknown';
    }

    // 2. CPU information
    try {
      const cpu = await si.cpu();
      parts.cpuId = `${cpu.manufacturer}-${cpu.brand}-${cpu.cores}-${cpu.physicalCores}`;
    } catch (e) {
      parts.cpuId = os.cpus()[0]?.model || 'unknown';
    }

    // 3. Primary MAC address (skip virtual interfaces)
    try {
      const nets = os.networkInterfaces();
      const realMac = Object.values(nets)
        .flat()
        .find(n => !n.internal && n.mac && n.mac !== '00:00:00:00:00:00');
      parts.mac = realMac?.mac || 'unknown';
    } catch (e) {
      parts.mac = 'unknown';
    }

    // 4. Disk serial (primary disk)
    try {
      const disks = await si.diskLayout();
      if (disks.length > 0) {
        parts.diskSerial = disks[0].serialNum || disks[0].name || 'unknown';
      }
    } catch (e) {
      parts.diskSerial = 'unknown';
    }

    // 5. Hostname hash (adds uniqueness for identical hardware)
    parts.hostname = os.hostname();

    // 6. OS platform + arch
    parts.platform = `${os.platform()}-${os.arch()}`;

    // Combine all parts into a single fingerprint
    const raw = Object.values(parts).join('|');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    // Shorten to 32 chars for readability (still 128 bits of entropy)
    this._fingerprint = hash.substring(0, 32).toUpperCase();
    this._details = {
      ...parts,
      raw: raw,
      algorithm: 'SHA-256/128'
    };

    return { fingerprint: this._fingerprint, details: this._details };
  }

  /**
   * Get a display-friendly version: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
   */
  async getDisplayFingerprint() {
    const { fingerprint } = await this.generate();
    return fingerprint.match(/.{1,4}/g).join('-');
  }
}

module.exports = new MachineFingerprint();
