#!/usr/bin/env node
// auto-publish.mjs — Builder Instagram Auto-Publisher
// Usage: node auto-publish.mjs <post-pack.md>
// Pipeline: parse → generate slides → upload Supabase → publish IG carousel

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { parsePostPack, saveSlides } from './generate-slides.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Env loading ─────────────────────────────────────────────────────────────

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

const envBuilder = loadEnvFile(join(__dirname, '.env.builder'));
const envLocal   = loadEnvFile(join(__dirname, '../../.env.local'));

const IG_TOKEN    = envBuilder.IG_ACCESS_TOKEN;
const IG_USER_ID  = envBuilder.IG_USER_ID;
const IG_EXPECTED = envBuilder.IG_EXPECTED_USERNAME;
const SUPABASE_URL = envLocal.VITE_SUPABASE_URL;
const SUPABASE_KEY = envLocal.VITE_SUPABASE_ANON_KEY;

const IG_BASE = 'https://graph.facebook.com/v21.0';

// ─── Instagram API ───────────────────────────────────────────────────────────

async function igGet(path, extra = {}) {
  const url = new URL(`${IG_BASE}/${path}`);
  url.searchParams.set('access_token', IG_TOKEN);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
  const r = await fetch(url.toString());
  return r.json();
}

async function igPost(path, params = {}) {
  const body = new URLSearchParams({ ...params, access_token: IG_TOKEN });
  const r = await fetch(`${IG_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return r.json();
}

async function igPostRetry(path, params, retries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await igPost(path, params);
    if (res.id) return res;
    console.warn(`  IG attempt ${attempt}/${retries} failed:`, res.error?.message ?? JSON.stringify(res));
    if (attempt < retries) await sleep(delayMs);
  }
  throw new Error(`IG API failed after ${retries} attempts on /${path}`);
}

// ─── Supabase storage ────────────────────────────────────────────────────────

async function uploadToSupabase(localPath, storagePath) {
  const data = readFileSync(localPath);
  const url = `${SUPABASE_URL}/storage/v1/object/media/${storagePath}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
    },
    body: data,
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase upload failed (${r.status}): ${err}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/media/${storagePath}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function enrichCaption(caption, kennung) {
  // Add relevant hashtags based on content keywords
  const tagMap = {
    automation: '#automation #buildinpublic #softwareentwicklung #coding #appentwicklung',
    payment:    '#payments #fintech #buildinpublic #softwareentwicklung #coding',
    auth:       '#auth #security #buildinpublic #softwareentwicklung #coding',
    state:      '#reactnative #statemanagement #buildinpublic #softwareentwicklung #coding',
    default:    '#buildinpublic #softwareentwicklung #coding #appentwicklung #indiedev',
  };
  const key = Object.keys(tagMap).find(k => kennung.includes(k)) ?? 'default';
  const hashtags = tagMap[key];
  return caption.includes('#') ? caption : `${caption}\n\n${hashtags}`;
}

// ─── Preflight ────────────────────────────────────────────────────────────────

async function preflight() {
  const me = await igGet('me', { fields: 'id,username' });
  if (me.error) {
    const code = me.error.code;
    if (code === 190) throw new Error('TOKEN_EXPIRED');
    throw new Error(`IG preflight error (${code}): ${me.error.message}`);
  }
  console.log(`Preflight OK: @${me.username} (${me.id})`);
  if (IG_EXPECTED && me.username !== IG_EXPECTED) {
    throw new Error(`Wrong account: @${me.username} — expected @${IG_EXPECTED}. Aborting.`);
  }
  return me;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function main() {
  const rawArg = process.argv[2];
  if (!rawArg) {
    console.error('Usage: node auto-publish.mjs <post-pack.md>');
    process.exit(1);
  }
  const packPath = resolve(rawArg);
  if (!existsSync(packPath)) {
    console.error('Usage: node auto-publish.mjs <post-pack.md>');
    process.exit(1);
  }

  const content = readFileSync(packPath, 'utf8');
  const { kennung, caption, slides } = parsePostPack(content);
  console.log(`\n=== Builder Auto-Publish: ${kennung} ===\n`);

  if (!IG_TOKEN || !IG_USER_ID) {
    console.error('Missing IG credentials in .env.builder');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL/SUPABASE_ANON_KEY in .env.local');
    process.exit(1);
  }

  // Preflight
  try {
    await preflight();
  } catch (e) {
    if (e.message === 'TOKEN_EXPIRED') {
      console.error('IG Token abgelaufen — manuelles Renewal nötig');
      process.exit(2);
    }
    console.error(e.message);
    process.exit(1);
  }

  // Generate slides
  console.log('\n[1/4] Generating slides...');
  const timestamp = Date.now();
  const assetsDir = join(__dirname, 'assets', `${kennung}-${timestamp}`);
  const slidePaths = await saveSlides(slides, assetsDir);

  // Upload to Supabase
  console.log('\n[2/4] Uploading to Supabase...');
  const folder = basename(assetsDir);
  const slideUrls = [];
  for (let i = 0; i < slidePaths.length; i++) {
    const storagePath = `builder/${folder}/slide-${i + 1}.png`;
    const url = await uploadToSupabase(slidePaths[i], storagePath);
    slideUrls.push(url);
    console.log(`  Uploaded slide-${i + 1}: OK`);
  }

  // Create individual media containers
  console.log('\n[3/4] Creating media containers...');
  const containerIds = [];
  for (const url of slideUrls) {
    const res = await igPostRetry(`${IG_USER_ID}/media`, {
      image_url: url,
      is_carousel_item: 'true',
    });
    containerIds.push(res.id);
    console.log(`  Container: ${res.id}`);
    await sleep(1500);
  }

  // Create carousel container
  const fullCaption = enrichCaption(caption, kennung);
  const carousel = await igPostRetry(`${IG_USER_ID}/media`, {
    media_type: 'CAROUSEL',
    children: containerIds.join(','),
    caption: fullCaption,
  });
  console.log(`  Carousel container: ${carousel.id}`);

  // Wait for IG processing
  await sleep(6000);

  // Publish
  console.log('\n[4/4] Publishing...');
  const published = await igPostRetry(`${IG_USER_ID}/media_publish`, {
    creation_id: carousel.id,
  });

  console.log(`\n✓ Published! Media ID: ${published.id}`);
  console.log(`  Account: @${IG_EXPECTED}`);
  console.log(`  Kennung: ${kennung}`);

  // Save carousel.json locally
  const carouselData = {
    kennung,
    mediaId: published.id,
    slides: slideUrls,
    carouselContainerId: carousel.id,
    publishedAt: new Date().toISOString(),
  };
  writeFileSync(join(assetsDir, 'carousel.json'), JSON.stringify(carouselData, null, 2));

  return published.id;
}

main().catch(err => {
  const msg = err.message ?? String(err);
  if (/quota/i.test(msg)) {
    console.error('Publishing-Quota erschöpft');
    process.exit(3);
  }
  console.error('\nPublish fehlgeschlagen:', msg);
  process.exit(1);
});
