'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

function runFfmpeg(args) {
  const ffmpegBin = '/opt/homebrew/bin/ffmpeg';
  const bin = fs.existsSync(ffmpegBin) ? ffmpegBin : 'ffmpeg';
  return cp.execFileSync(bin, args, { stdio: 'pipe' });
}

/**
 * Transcodes a raw video file to GIF, MP4, and a poster JPEG.
 */
function transcodeMedia(
  inputVideoPath,
  outputBaseName,
  docsDir,
  websiteDir,
  posterTimestamp = '00:00:01.800',
) {
  if (!fs.existsSync(inputVideoPath)) {
    throw new Error(`Input video not found: ${inputVideoPath}`);
  }

  const gifPathDocs = path.join(docsDir, `${outputBaseName}.gif`);
  const posterPathDocs = path.join(docsDir, `${outputBaseName}.poster.jpg`);

  const mp4PathWeb = websiteDir ? path.join(websiteDir, `${outputBaseName}.mp4`) : null;
  const posterPathWeb = websiteDir ? path.join(websiteDir, `${outputBaseName}.poster.jpg`) : null;
  const gifPathWeb = websiteDir ? path.join(websiteDir, `${outputBaseName}.gif`) : null;

  console.log(`[Media Pipeline] Transcoding: ${outputBaseName}...`);

  // 1. Generate Poster (still frame at posterTimestamp or fallback)
  try {
    runFfmpeg([
      '-y',
      '-ss',
      posterTimestamp,
      '-i',
      inputVideoPath,
      '-vframes',
      '1',
      '-q:v',
      '3',
      posterPathDocs,
    ]);
  } catch {
    runFfmpeg([
      '-y',
      '-ss',
      '00:00:00.500',
      '-i',
      inputVideoPath,
      '-vframes',
      '1',
      '-q:v',
      '3',
      posterPathDocs,
    ]);
  }

  // 2. Generate Optimized GIF (<1.5MB target ~600KB-1.2MB, Lanczos, 9 fps, palettegen with diff_mode=rectangle)
  const isMobile = outputBaseName === 'server-app';
  const scaleFilter = isMobile ? 'scale=-2:640:flags=lanczos' : 'scale=960:540:flags=lanczos';
  const mp4ScaleFilter = isMobile
    ? 'scale=trunc(iw*640/ih/2)*2:640:flags=lanczos'
    : 'scale=960:540:flags=lanczos';

  runFfmpeg([
    '-y',
    '-i',
    inputVideoPath,
    '-vf',
    `fps=9,${scaleFilter},split[s0][s1];[s0]palettegen=max_colors=64:stats_mode=diff:reserve_transparent=0[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    '-loop',
    '0',
    gifPathDocs,
  ]);

  // 3. Generate Web MP4 (H.264, yuv420p, crf 23, faststart)
  const tempMp4 = path.join(docsDir, `${outputBaseName}.mp4`);
  runFfmpeg([
    '-y',
    '-i',
    inputVideoPath,
    '-vf',
    mp4ScaleFilter,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '23',
    '-movflags',
    '+faststart',
    '-an',
    tempMp4,
  ]);

  // Copy to website directory if provided
  if (websiteDir) {
    fs.mkdirSync(websiteDir, { recursive: true });
    fs.copyFileSync(tempMp4, mp4PathWeb);
    fs.copyFileSync(posterPathDocs, posterPathWeb);
    fs.copyFileSync(gifPathDocs, gifPathWeb);
  }

  const gifStat = fs.statSync(gifPathDocs);
  const mp4Stat = fs.statSync(tempMp4);
  const posterStat = fs.statSync(posterPathDocs);

  console.log(`[Media Pipeline] Done ${outputBaseName}:`);
  console.log(`  - GIF: ${(gifStat.size / 1024).toFixed(1)} KB`);
  console.log(`  - MP4: ${(mp4Stat.size / 1024).toFixed(1)} KB`);
  console.log(`  - Poster: ${(posterStat.size / 1024).toFixed(1)} KB`);

  return {
    gifSize: gifStat.size,
    mp4Size: mp4Stat.size,
    posterSize: posterStat.size,
    gifPath: gifPathDocs,
    mp4Path: tempMp4,
    posterPath: posterPathDocs,
  };
}

module.exports = { transcodeMedia };
