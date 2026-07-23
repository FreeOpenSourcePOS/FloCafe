// Stub for `electron` so main/db.ts can be imported in plain Node (where the
// real Electron binary is not installed, e.g. CI or fresh dev). Only the
// surface used by db.ts is provided.
const path = require('path');
const os = require('os');

const userData = path.join(os.tmpdir(), 'flo-electron-stub');

module.exports = {
  app: {
    getPath: (key) => {
      if (key === 'userData') return userData;
      if (key === 'documents') return os.tmpdir();
      return os.tmpdir();
    },
    getVersion: () => '0.0.0-stub',
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(s, 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  },
};
