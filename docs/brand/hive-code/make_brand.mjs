// Brand files for Hive Code: the mark and the full logo (mark + name), light and dark, SVG and PNG,
// plus the app icon tile and the GitHub avatar. The geometry comes from the app icon generator
// (packages/app/tool/make_icons.mjs), so the icon and the brand files never drift apart.
//
// Usage, from the repo root:  npm i --no-save opentype.js && node docs/brand/hive-code/make_brand.mjs
// The name is converted to paths (Heebo 700 from the app's fonts), so the SVGs need no installed font.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { markSvg, EXTENT, BLUE, BLUE_DARK } from '../../../packages/app/tool/make_icons.mjs';

const opentype = (await import('opentype.js').catch(() => {
  throw new Error('needs opentype.js: npm i --no-save opentype.js');
})).default;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.join(HERE, '../../../packages/app/assets/fonts/Heebo-700.ttf');
const font = opentype.parse(fs.readFileSync(FONT).buffer);

const MODES = {
  light: { mark: BLUE, text: '#1A1B1D' },
  dark: { mark: BLUE_DARK, text: '#ECECE8' },
};
const r2 = (n) => +n.toFixed(2);

// The mark, cropped tight to its outer edge.
const half = EXTENT.half;
const markDoc = (fill, size = 100) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${50 - half} ${50 - half} ${2 * half} ${2 * half}">${markSvg(fill)}</svg>`;

// Mark + name. Height H is the mark's height; the name's cap height is 44% of it, centered on the mark.
function lockupDoc({ mark, text }, H = 100) {
  const capRatio = font.tables.os2.sCapHeight / font.unitsPerEm;
  const cap = 0.44 * H;
  const size = cap / capRatio;
  const track = -0.01 * size;
  const glyphs = font.stringToGlyphs('Hive Code');
  let x = 0, d = '';
  glyphs.forEach((g, i) => {
    d += g.getPath(x, 0, size).toPathData(2);
    x += (g.advanceWidth / font.unitsPerEm) * size + track;
    if (i < glyphs.length - 1) x += (font.getKerningValue(g, glyphs[i + 1]) / font.unitsPerEm) * size;
  });
  const gap = 0.26 * H;
  const W = Math.ceil(H + gap + x - track + 0.04 * H); // a little air after the last letter
  const k = H / (2 * half);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<g transform="scale(${r2(k)}) translate(${r2(half - 50)} ${r2(half - 50)})">${markSvg(mark)}</g>` +
    `<path fill="${text}" transform="translate(${r2(H + gap)} ${r2(H / 2 + cap / 2)})" d="${d}"/></svg>`;
}

// The app icon tile: white mark on the blue square, the hexagon about 62% of the tile.
const BOX = 100 / 0.7;
const tileDoc = (size, rounded) => {
  const o = 50 - BOX / 2;
  const rx = rounded ? BOX * 0.22 : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${o} ${o} ${BOX} ${BOX}"><rect x="${o}" y="${o}" width="${BOX}" height="${BOX}" rx="${rx}" fill="${BLUE}"/>${markSvg('#FFFFFF')}</svg>`;
};

const png = (svg, file, width) => sharp(Buffer.from(svg), { density: 72 * 4 }).resize({ width }).png().toFile(path.join(HERE, file));
const write = (file, text) => fs.writeFileSync(path.join(HERE, file), text);

for (const [mode, colors] of Object.entries(MODES)) {
  write(`mark-${mode}.svg`, markDoc(colors.mark));
  await png(markDoc(colors.mark), `mark-${mode}.png`, 512);
  const lockup = lockupDoc(colors);
  write(`logo-${mode}.svg`, lockup);
  await png(lockup, `logo-${mode}.png`, 1200);
}
write('app-icon.svg', tileDoc(512, true));
await png(tileDoc(512, true), 'app-icon.png', 512);
// GitHub crops avatars itself (rounded square for orgs, circle for users): full bleed square.
await png(tileDoc(500, false), 'github-avatar.png', 500);
console.log('brand files written to', HERE);
