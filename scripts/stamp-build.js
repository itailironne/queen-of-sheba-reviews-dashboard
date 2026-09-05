// Stamps the current date/time + short git SHA into reviews_dashboard.html so
// the page can show which build you're actually looking at.
//
// Why this exists: GitHub Pages' CDN serves a stale copy for a minute or two
// after a push, and a browser can hold one for longer. Without a visible build
// stamp there is no way to tell "the change didn't work" apart from "you're
// looking at yesterday's cached page" — which cost real debugging time.
//
// Run it right before committing a code change:  node scripts/stamp-build.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FILE = path.join(__dirname, '..', 'reviews_dashboard.html');

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim(); }
  catch (e) { return 'dev'; }
}

const now = new Date();
const pad = n => String(n).padStart(2, '0');
const stamp = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
const value = `${stamp} · ${gitSha()}`;

const html = fs.readFileSync(FILE, 'utf8');
const re = /const BUILD_STAMP = '[^']*';/;
if (!re.test(html)) {
  console.error('BUILD_STAMP placeholder not found in reviews_dashboard.html');
  process.exit(1);
}
fs.writeFileSync(FILE, html.replace(re, `const BUILD_STAMP = '${value}';`), 'utf8');
console.log('[stamp-build] ' + value);
