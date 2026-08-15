#!/usr/bin/env node
// generate-slides.mjs — Builder Carousel Slide Generator
// Usage: node generate-slides.mjs <post-pack.md> [output-dir]
// Exports: parsePostPack, generateSlide, saveSlides

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCALE = 2;
const W = 1080 * SCALE;   // 2160
const H = 1350 * SCALE;   // 2700
const S = x => Math.round(x * SCALE);

const C = {
  bg:          '#111009',
  card:        '#2D2A27',
  border:      '#4A4540',
  accent:      '#F97316',
  accentRed:   '#C53030',
  accentGreen: '#276749',
  text:        '#F5F0EB',
  textMuted:   '#9A9088',
  textDim:     '#6B6358',
  boxBefore:   '#2A1A1A',
  boxAfter:    '#172217',
};

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";

// ─── Utilities ──────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (test.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function watermark() {
  return `<text x="${W / 2}" y="${H - S(30)}" font-family="${FONT}" font-size="${S(20)}" fill="${C.textDim}" text-anchor="middle" letter-spacing="${S(2)}">@miracwhey.md</text>`;
}

function topAccent() {
  return `<rect x="0" y="0" width="${W}" height="${S(5)}" fill="${C.accent}" opacity="0.75"/>`;
}

// Subtle radial gradient glow in corner — increases visual depth and file size
function backgroundGlow(cx = W * 0.15, cy = H * 0.25, r = W * 0.65) {
  return `
  <defs>
    <radialGradient id="bgGlow" cx="${Math.round(cx)}" cy="${Math.round(cy)}" r="${Math.round(r)}" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${C.accent}" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="${C.bg}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bgGlow)"/>`;
}

function badge(label, x = S(80), y = S(88)) {
  const pill_h = S(40);
  const pill_w = label.length * S(14) + S(52);
  return `
  <rect x="${x}" y="${y}" width="${pill_w}" height="${pill_h}" rx="${S(6)}" fill="${C.accent}" opacity="0.12"/>
  <rect x="${x}" y="${y}" width="${S(4)}" height="${pill_h}" rx="${S(2)}" fill="${C.accent}"/>
  <text x="${x + S(20)}" y="${y + pill_h * 0.67}" font-family="${FONT}" font-size="${S(18)}" font-weight="700" fill="${C.accent}" letter-spacing="${S(3)}">${esc(label)}</text>`;
}

// ─── HERO layout ────────────────────────────────────────────────────────────

function heroSlide(text, iconVariant = 'loop') {
  const len = text.length;
  let fontSize, maxChars, lineH;
  if (len < 50)      { fontSize = S(72); maxChars = 22; lineH = S(94); }
  else if (len < 90) { fontSize = S(56); maxChars = 27; lineH = S(76); }
  else               { fontSize = S(44); maxChars = 34; lineH = S(62); }

  const lines = wrapText(text, maxChars);
  const blockH = lines.length * lineH;
  const startY = Math.round((H - blockH) / 2) + S(40);

  const textEls = lines.map((l, i) =>
    `<text x="${W / 2}" y="${startY + i * lineH}" font-family="${FONT}" font-size="${fontSize}" font-weight="600" fill="${C.text}" text-anchor="middle">${esc(l)}</text>`
  ).join('\n  ');

  // Subtle thematic icon top-right
  const iconX = W - S(130);
  const iconY = S(130);
  const iconR = S(60);
  let icon = '';
  if (iconVariant === 'loop') {
    icon = `
  <circle cx="${iconX}" cy="${iconY}" r="${iconR}" fill="none" stroke="${C.accent}" stroke-width="${S(5)}" stroke-dasharray="${S(170)} ${S(80)}" opacity="0.28"/>
  <circle cx="${iconX}" cy="${iconY}" r="${S(35)}" fill="none" stroke="${C.accent}" stroke-width="${S(4)}" stroke-dasharray="${S(110)} ${S(60)}" opacity="0.18"/>`;
  } else if (iconVariant === 'check') {
    icon = `
  <circle cx="${iconX}" cy="${iconY}" r="${iconR}" fill="none" stroke="${C.accent}" stroke-width="${S(5)}" opacity="0.28"/>
  <text x="${iconX}" y="${iconY + S(22)}" font-family="${FONT}" font-size="${S(60)}" fill="${C.accent}" text-anchor="middle" opacity="0.28">✓</text>`;
  }

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  ${backgroundGlow(W * 0.75, H * 0.2)}
  ${topAccent()}
  <rect x="0" y="0" width="${S(4)}" height="${H}" fill="${C.accent}" opacity="0.12"/>
  ${icon}
  ${textEls}
  ${watermark()}
</svg>`;
}

// ─── CARDS layout ───────────────────────────────────────────────────────────

function cardsSlide(badgeLabel, paragraphs) {
  const cards = paragraphs.slice(0, 3);
  const cardX = S(80);
  const cardW = W - S(160);
  const cardH = S(268);
  const gap   = S(28);
  const startY = S(185);
  const stripeW = S(5);
  const padL  = S(36);
  const padT  = S(30);
  const numFS = S(22);
  const bodyFS = S(27);
  const bodyLH = S(39);
  const maxChars = Math.floor((cardW - stripeW - padL - S(36)) / (bodyFS * 0.56));

  const cardEls = cards.map((text, idx) => {
    const cy = startY + idx * (cardH + gap);
    const lines = wrapText(text.replace(/\n/g, ' '), maxChars).slice(0, 4);
    const num = String(idx + 1).padStart(2, '0');

    const textEls = lines.map((l, i) =>
      `<text x="${cardX + stripeW + padL}" y="${cy + padT + numFS + S(14) + i * bodyLH}" font-family="${FONT}" font-size="${bodyFS}" fill="${C.text}">${esc(l)}</text>`
    ).join('\n    ');

    return `
  <rect x="${cardX}" y="${cy}" width="${cardW}" height="${cardH}" rx="${S(10)}" fill="${C.card}"/>
  <rect x="${cardX}" y="${cy}" width="${stripeW}" height="${cardH}" rx="${S(2)}" fill="${C.accent}" opacity="0.7"/>
  <text x="${cardX + stripeW + padL}" y="${cy + padT}" font-family="${FONT}" font-size="${numFS}" font-weight="700" fill="${C.accent}" opacity="0.7">${num}</text>
    ${textEls}`;
  }).join('');

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  ${backgroundGlow(W * 0.85, H * 0.1)}
  ${topAccent()}
  ${badge(badgeLabel)}
  ${cardEls}
  ${watermark()}
</svg>`;
}

// ─── STORY layout ───────────────────────────────────────────────────────────

function storySlide(badgeLabel, beforeText, afterText) {
  const boxX = S(80);
  const boxW = W - S(160);
  const beforeH = S(360);
  const afterH  = S(250);
  const gap  = S(36);
  const startY = S(185);
  const stripeW = S(6);
  const padL = S(36);
  const padT = S(34);
  const labelFS = S(21);
  const bodyFS  = S(26);
  const bodyLH  = S(38);
  const maxChars = Math.floor((boxW - stripeW - padL - S(36)) / (bodyFS * 0.56));

  const beforeLines = wrapText(beforeText, maxChars).slice(0, 4);
  const afterLines  = wrapText(afterText,  maxChars).slice(0, 3);

  const beforeY = startY;
  const afterY  = startY + beforeH + gap;

  const beforeTextEls = beforeLines.map((l, i) =>
    `<text x="${boxX + stripeW + padL}" y="${beforeY + padT + labelFS + S(14) + i * bodyLH}" font-family="${FONT}" font-size="${bodyFS}" fill="${C.text}" opacity="0.82">${esc(l)}</text>`
  ).join('\n  ');

  const afterTextEls = afterLines.map((l, i) =>
    `<text x="${boxX + stripeW + padL}" y="${afterY + padT + labelFS + S(14) + i * bodyLH}" font-family="${FONT}" font-size="${bodyFS}" fill="${C.text}">${esc(l)}</text>`
  ).join('\n  ');

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  ${backgroundGlow(W * 0.1, H * 0.6)}
  ${topAccent()}
  ${badge(badgeLabel)}

  <!-- VORHER box -->
  <rect x="${boxX}" y="${beforeY}" width="${boxW}" height="${beforeH}" rx="${S(10)}" fill="${C.boxBefore}"/>
  <rect x="${boxX}" y="${beforeY}" width="${stripeW}" height="${beforeH}" rx="${S(2)}" fill="${C.accentRed}"/>
  <text x="${boxX + stripeW + padL}" y="${beforeY + padT}" font-family="${FONT}" font-size="${labelFS}" font-weight="700" fill="${C.accentRed}" letter-spacing="${S(2)}">VORHER</text>
  ${beforeTextEls}

  <!-- NACHHER box -->
  <rect x="${boxX}" y="${afterY}" width="${boxW}" height="${afterH}" rx="${S(10)}" fill="${C.boxAfter}"/>
  <rect x="${boxX}" y="${afterY}" width="${stripeW}" height="${afterH}" rx="${S(2)}" fill="${C.accentGreen}"/>
  <text x="${boxX + stripeW + padL}" y="${afterY + padT}" font-family="${FONT}" font-size="${labelFS}" font-weight="700" fill="${C.accentGreen}" letter-spacing="${S(2)}">NACHHER</text>
  ${afterTextEls}

  ${watermark()}
</svg>`;
}

// ─── DATA layout ────────────────────────────────────────────────────────────

function dataSlide(badgeLabel, metric, metricLabel, items, tagline) {
  const metricFS = S(128);
  const metricLabelFS = S(30);
  const metricY = S(310);
  const metricLabelY = metricY + S(28) + metricLabelFS;

  const itemsStartY = metricLabelY + S(64);
  const itemX = S(80);
  const itemW = W - S(160);
  const itemH = S(86);
  const itemGap = S(20);
  const stripeW = S(4);
  const padL = S(30);
  const itemFS = S(27);
  const numFS  = S(24);

  const itemEls = items.slice(0, 3).map((text, idx) => {
    const iy = itemsStartY + idx * (itemH + itemGap);
    const line = wrapText(text.replace(/\n/g, ' '), 52)[0] ?? text;
    return `
  <rect x="${itemX}" y="${iy}" width="${itemW}" height="${itemH}" rx="${S(8)}" fill="${C.card}"/>
  <rect x="${itemX}" y="${iy}" width="${stripeW}" height="${itemH}" rx="${S(2)}" fill="${C.accent}" opacity="0.6"/>
  <text x="${itemX + stripeW + padL}" y="${iy + Math.round(itemH / 2) + numFS * 0.38}" font-family="${FONT}" font-size="${numFS}" font-weight="700" fill="${C.accent}">${idx + 1}</text>
  <text x="${itemX + stripeW + padL + S(54)}" y="${iy + Math.round(itemH / 2) + itemFS * 0.38}" font-family="${FONT}" font-size="${itemFS}" fill="${C.text}">${esc(line)}</text>`;
  }).join('');

  const taglineY = itemsStartY + 3 * (itemH + itemGap) + S(52);

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${C.bg}"/>
  ${backgroundGlow(W * 0.5, H * 0.3, W * 0.8)}
  ${topAccent()}
  ${badge(badgeLabel)}

  <text x="${W / 2}" y="${metricY}" font-family="${FONT}" font-size="${metricFS}" font-weight="800" fill="${C.accent}" text-anchor="middle">${esc(metric)}</text>
  <text x="${W / 2}" y="${metricLabelY}" font-family="${FONT}" font-size="${metricLabelFS}" fill="${C.textMuted}" text-anchor="middle" letter-spacing="${S(4)}">${esc(metricLabel.toUpperCase())}</text>

  ${itemEls}

  ${tagline ? `<text x="${W / 2}" y="${taglineY}" font-family="${FONT}" font-size="${S(22)}" fill="${C.textMuted}" text-anchor="middle">${esc(tagline)}</text>` : ''}
  ${watermark()}
</svg>`;
}

// ─── Post-pack parser ────────────────────────────────────────────────────────

export function parsePostPack(content) {
  const kennung = (content.match(/##\s+Kennung\s*\n([^\n]+)/) ?? [])[1]?.trim() ?? 'unknown';
  const captionM = content.match(/##\s+Caption\s*\n([\s\S]+?)(?=\n##\s+Publish|$)/);
  const caption = captionM ? captionM[1].trim() : '';

  const slides = [];
  const slideRegex = /###\s+Slide\s+(\d+)\s*\n([\s\S]+?)(?=\n###\s+Slide|\n---\n##|\n##\s+Caption|$)/g;
  let m;
  while ((m = slideRegex.exec(content)) !== null) {
    const num = parseInt(m[1]);
    const body = m[2].trim();
    const textM   = body.match(/\*\*Text:\*\*\s*([\s\S]+?)(?=\*\*Visuell:|<!--|$)/);
    const visualM = body.match(/\*\*Visuell:\*\*\s*([^\n]+)/);
    const layoutM = body.match(/<!--\s*Layout:\s*([A-Z]+)/);
    slides.push({
      num,
      text:   textM   ? textM[1].trim()   : '',
      visual: visualM ? visualM[1].trim().toLowerCase() : 'quote-style',
      layout: layoutM ? layoutM[1].toUpperCase() : 'HERO',
    });
  }

  return { kennung, caption, slides };
}

// ─── Slide generator ─────────────────────────────────────────────────────────

export function generateSlide(slide) {
  const { layout, text, num } = slide;

  if (layout === 'HERO') {
    // Slide 1 gets loop icon (broken memory), slide 5 gets check icon (idempotency)
    const variant = num === 5 ? 'check' : 'loop';
    return heroSlide(text, variant);
  }

  if (layout === 'CARDS') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const badgeLabel = lines[0]?.startsWith('#')
      ? lines[0].replace(/^#+\s*/, '')
      : 'KONTEXT';
    const rest = text.replace(/^[^\n]*\n/, '').trim();
    const paras = rest.split(/\n\n+/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
    return cardsSlide(badgeLabel, paras);
  }

  if (layout === 'STORY') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const badgeLabel = lines[0]?.startsWith('#')
      ? lines[0].replace(/^#+\s*/, '')
      : 'STORY';
    const beforeM = text.match(/VORHER\s*\n([\s\S]+?)(?=\nNACHHER|$)/);
    const afterM  = text.match(/NACHHER\s*\n([\s\S]+?)$/);
    const beforeText = beforeM ? beforeM[1].replace(/\n/g, ' ').trim() : '';
    const afterText  = afterM  ? afterM[1].replace(/\n/g, ' ').trim()  : '';
    return storySlide(badgeLabel, beforeText, afterText);
  }

  if (layout === 'DATA') {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const badgeLabel = lines[0]?.startsWith('#')
      ? lines[0].replace(/^#+\s*/, '')
      : 'ERGEBNIS';
    const contentLines = lines.filter(l => !l.startsWith('#'));

    let metric = '';
    let metricLabel = '';
    const items = [];
    let tagline = '';

    for (let i = 0; i < contentLines.length; i++) {
      const l = contentLines[i];
      if (!metric && /^\d+/.test(l) && !/^\d+\./.test(l)) {
        const mm = l.match(/^(\d+)\s*(.*)/);
        metric = mm[1];
        metricLabel = mm[2].trim();
        if (!metricLabel && i + 1 < contentLines.length && !/^\d+\./.test(contentLines[i + 1])) {
          metricLabel = contentLines[i + 1];
        }
      } else if (/^\d+\./.test(l)) {
        items.push(l.replace(/^\d+\.\s*/, ''));
      } else if (/^(Jetzt|Das |Die |Der |Damit|So |Heute|Ergebnis)/.test(l)) {
        tagline = l;
      }
    }

    return dataSlide(badgeLabel, metric, metricLabel, items, tagline);
  }

  // Fallback
  return heroSlide(text, 'loop');
}

// ─── Save slides to PNG ───────────────────────────────────────────────────────

export async function saveSlides(slides, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const paths = [];

  for (const slide of slides) {
    const svg = generateSlide(slide);
    const outPath = join(outputDir, `slide-${slide.num}.png`);

    await sharp(Buffer.from(svg))
      .resize(1080, 1350, { kernel: sharp.kernel.lanczos3 })
      .png({ quality: 100, compressionLevel: 1 })
      .toFile(outPath);

    console.log(`  Generated slide-${slide.num}.png`);
    paths.push(outPath);
  }

  return paths;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main() {
  const packPath = process.argv[2];
  const outputDir = process.argv[3];

  if (!packPath) {
    console.error('Usage: node generate-slides.mjs <post-pack.md> [output-dir]');
    process.exit(1);
  }

  const content = readFileSync(packPath, 'utf8');
  const { kennung, slides } = parsePostPack(content);

  const dir = outputDir ?? join(__dirname, 'assets', `${kennung}-${Date.now()}`);
  console.log(`Generating ${slides.length} slides for "${kennung}" → ${dir}`);

  const paths = await saveSlides(slides, dir);
  console.log(`Done. ${paths.length} slides saved.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
