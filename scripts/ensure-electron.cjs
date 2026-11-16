const fs = require('node:fs');

// Electron's package may defer downloading its runtime until first use.
// Requiring it uses the official installer and checksum verification when needed.
const binary = require('electron');
if (!fs.existsSync(binary)) throw new Error('Electron runtime is unavailable. Reinstall dependencies and retry.');
console.log('Electron runtime ready.');
