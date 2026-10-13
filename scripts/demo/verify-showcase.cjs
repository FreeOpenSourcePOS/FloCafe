'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const DOCS_DIR = path.resolve(__dirname, '../../docs/assets/showcase');
const WEBSITE_DIR = path.resolve(__dirname, '../../../flopos.com-showcase/media/showcase');

const SCENES = [
  { id: 'pos-checkout', width: 800, height: 450 },
  { id: 'addon-modifiers', width: 800, height: 450 },
  { id: 'kds-kanban', width: 800, height: 450 },
  { id: 'floorplan-tables', width: 800, height: 450 },
  { id: 'server-app', width: 290, height: 580 },
  { id: 'split-payments', width: 800, height: 450 },
  { id: 'recipe-inventory', width: 800, height: 450 },
  { id: 'thermal-printing', width: 800, height: 450 },
];

const MAX_GIF_BYTES = 1.5 * 1024 * 1024; // 1.5 MB

function probeVideo(mp4Path) {
  const res = cp.spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,codec_name,duration',
      '-of',
      'json',
      mp4Path,
    ],
    { encoding: 'utf8' },
  );

  if (res.status !== 0) {
    throw new Error(`ffprobe failed for ${mp4Path}: ${res.stderr}`);
  }

  const data = JSON.parse(res.stdout);
  const stream = data.streams?.[0];
  if (!stream) {
    throw new Error(`No video stream found in ${mp4Path}`);
  }
  return {
    width: stream.width,
    height: stream.height,
    codec: stream.codec_name,
    duration: parseFloat(stream.duration || '0'),
  };
}

function decodeVideo(mp4Path) {
  const res = cp.spawnSync('ffmpeg', ['-v', 'error', '-i', mp4Path, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`ffmpeg decode failed for ${mp4Path}: ${res.stderr}`);
  }
}

function verifyShowcase() {
  console.log('=== Verifying FloCafe Showcase Assets ===\n');
  const results = [];
  let hasErrors = false;

  for (const scene of SCENES) {
    const sceneResult = {
      scene: scene.id,
      gifSizeKB: null,
      mp4SizeKB: null,
      posterSizeKB: null,
      resolution: null,
      status: 'PASS',
      errors: [],
    };

    const docsGif = path.join(DOCS_DIR, `${scene.id}.gif`);
    const docsMp4 = path.join(DOCS_DIR, `${scene.id}.mp4`);
    const docsPoster = path.join(DOCS_DIR, `${scene.id}.poster.jpg`);

    // 1. Existence in docs
    for (const [name, filePath] of [
      ['docs GIF', docsGif],
      ['docs MP4', docsMp4],
      ['docs Poster', docsPoster],
    ]) {
      if (!fs.existsSync(filePath)) {
        sceneResult.errors.push(`Missing ${name}: ${filePath}`);
      }
    }

    // 2. Existence in website repo (if dir exists)
    if (fs.existsSync(WEBSITE_DIR)) {
      const webGif = path.join(WEBSITE_DIR, `${scene.id}.gif`);
      const webMp4 = path.join(WEBSITE_DIR, `${scene.id}.mp4`);
      const webPoster = path.join(WEBSITE_DIR, `${scene.id}.poster.jpg`);

      for (const [name, filePath] of [
        ['web GIF', webGif],
        ['web MP4', webMp4],
        ['web Poster', webPoster],
      ]) {
        if (!fs.existsSync(filePath)) {
          sceneResult.errors.push(`Missing ${name}: ${filePath}`);
        }
      }
    }

    // 3. GIF size check (< 1.5MB)
    if (fs.existsSync(docsGif)) {
      const gifStat = fs.statSync(docsGif);
      sceneResult.gifSizeKB = (gifStat.size / 1024).toFixed(1);
      if (gifStat.size > MAX_GIF_BYTES) {
        sceneResult.errors.push(
          `GIF size ${(gifStat.size / (1024 * 1024)).toFixed(2)}MB exceeds 1.5MB limit`,
        );
      }
    }

    // 4. MP4 stream verification
    if (fs.existsSync(docsMp4)) {
      const mp4Stat = fs.statSync(docsMp4);
      sceneResult.mp4SizeKB = (mp4Stat.size / 1024).toFixed(1);
      try {
        const streamInfo = probeVideo(docsMp4);
        sceneResult.resolution = `${streamInfo.width}x${streamInfo.height}`;
        if (streamInfo.width !== scene.width || streamInfo.height !== scene.height) {
          sceneResult.errors.push(
            `Dimensions mismatch: expected ${scene.width}x${scene.height}, got ${streamInfo.width}x${streamInfo.height}`,
          );
        }
        decodeVideo(docsMp4);
      } catch (err) {
        sceneResult.errors.push(err.message);
      }
    }

    // 5. Poster check
    if (fs.existsSync(docsPoster)) {
      const posterStat = fs.statSync(docsPoster);
      sceneResult.posterSizeKB = (posterStat.size / 1024).toFixed(1);
      if (posterStat.size === 0) {
        sceneResult.errors.push('Poster file is 0 bytes');
      }
    }

    if (sceneResult.errors.length > 0) {
      sceneResult.status = 'FAIL';
      hasErrors = true;
    }

    results.push(sceneResult);
  }

  console.table(
    results.map((r) => ({
      Scene: r.scene,
      Resolution: r.resolution || 'N/A',
      'GIF (KB)': r.gifSizeKB || 'N/A',
      'MP4 (KB)': r.mp4SizeKB || 'N/A',
      'Poster (KB)': r.posterSizeKB || 'N/A',
      Status: r.status,
    })),
  );

  if (hasErrors) {
    console.error('\nVerification errors found:');
    for (const r of results) {
      if (r.errors.length > 0) {
        console.error(`- ${r.scene}:`);
        for (const e of r.errors) {
          console.error(`    ${e}`);
        }
      }
    }
    process.exit(1);
  }

  console.log('\nAll 8 showcase media assets passed strict verification.');
}

if (require.main === module) {
  verifyShowcase();
}

module.exports = { verifyShowcase };
