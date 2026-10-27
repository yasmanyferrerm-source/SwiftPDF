// Copies pdf.js runtime assets (CMaps, standard fonts, wasm decoders, ICC profiles)
// into public/pdfjs so they ship with the app and work fully offline.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'pdfjs-dist');
const dest = path.join(__dirname, '..', 'public', 'pdfjs');

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = path.join(src, dir);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
