#!/usr/bin/env node
// Increments the patch version in package.json and syncs js/build-version.js.
// Run via: npm run bump
// Always run this before committing — never edit version files by hand.

const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const pkgPath = path.join(ROOT, 'package.json');
const bvPath  = path.join(ROOT, 'js/build-version.js');

const pkg    = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const parts  = pkg.version.split('.').map(Number);
parts[2]    += 1;
pkg.version  = parts.join('.');

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(bvPath,  `window.__BUILD_VERSION__ = "v${pkg.version}";\n`);

console.log(`version → v${pkg.version}`);
