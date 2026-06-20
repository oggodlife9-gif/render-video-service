/**
 * Free-tier video assembly service for Make.com → YouTube automation.
 *
 * Pipeline per request:
 *   1. Generate voiceover via Microsoft Edge TTS (free, no key)
 *   2. Fetch stock footage per scene from Pexels (free 200 req/hr)
 *   3. Trim + concat clips with FFmpeg to match voiceover length
 *   4. Burn title + per-scene captions via drawtext
 *   5. Upload final MP4 to tmpfiles.org (free, public URL, ~60 min TTL)
 *   6. Return public URL → Make.com hands it to YouTube upload
 *
 * Deploy: Render.com free web service (Docker). Set PEXELS_API_KEY env var.
 */

const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const { EdgeTTS } = require('node-edge-tts');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// We don't use the uuid import above — fall back to a simple generator so we
// avoid an extra dependency. Kept here intentionally as a stub marker.
const os = require('os');

const app = express();
app.use(express.json({ limit: '10mb' }));

const TMP_ROOT = path.join(os.tmpdir(), 'video-renders');
if (!fs.existsSync(TMP_ROOT)) fs.mkdirSync(TMP_ROOT, { recursive: true });

// --- helpers ---------------------------------------------------------------

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function safeFilename(s) {
  return String(s || 'video').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
}

/**
 * Generate a single voiceover MP3 for a concatenated string of segments.
 * Segments are separated by silence so captions align later.
 */
async function generateVoiceover({ text, voice, outPath }) {
  const tts = new EdgeTTS({
    voice: voice || 'en-US-AriaNeural',
    lang: 'en-US',
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    rate: '+0%',
    volume: '+0%',
    pitch: '+0Hz',
  });
  await tts.ttsPromise(text, outPath);
  return outPath;
}

/**
 * Look up a single stock video clip for a keyword.
 * Returns { url, width, height, duration } or null.
 */
async function fetchPexelsClip(query, apiKey) {
  if (!apiKey) throw new Error('PEXELS_API_KEY missing');
  const url = 'https://api.pexels.com/videos/search';
  const { data } = await axios.get(url, {
    headers: { Authorization: apiKey },
    params: {
      query,
      per_page: 5,
      orientation: 'landscape',
      size: 'medium',
    },
    timeout: 15000,
  });
  if (!data.videos || data.videos.length === 0) return null;
  // Pick the first landscape HD-ish clip with reasonable duration (>= 4s)
  const candidates = data.videos.filter(v =>
    v.video_files.some(f => f.width >= 1280) && (v.duration || 0) >= 4
  );
  const video = candidates[0] || data.videos[0];
  const file =
    video.video_files.find(f => f.width >= 1920 && f.height === 1080) ||
    video.video_files.find(f => f.width >= 1280) ||
    video.video_files[0];
  return {
    url: file.link,
    width: file.width,
    height: file.height,
    duration: video.duration,
  };
}

async function downloadTo(url, outPath) {
  const writer = fs.createWriteStream(outPath);
  const resp = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 60000,
  });
  resp.data.pipe(writer);
  await new Promise((res, rej) => {
    writer.on('finish', res);
    writer.on('error', rej);
  });
  return outPath;
}

async function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(parseFloat(data.format.duration) || 0);
    });
  });
}

/**
 * Upload an MP4 to tmpfiles.org and return a public direct-download URL.
 * File stays for ~60 minutes — plenty for Make.com to push it to YouTube.
 */
async function uploadToTmpFiles(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  const { data } = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 5 * 60 * 1000,
  });
  if (data.status !== 'success') throw new Error('tmpfiles upload failed: ' + JSON.stringify(data));
  // tmpfiles returns the HTML page URL — convert to direct download URL
  const htmlUrl = data.data.url;            // https://tmpfiles.org/dl/xxxx/file.mp4
  const directUrl = htmlUrl.replace('/dl/', '/dl/'); // already direct
  return directUrl;
}

// --- core: assemble --------------------------------------------------------

/**
 * Build the final MP4.
 *
 * @param {object} opts
 * @param {string[]} opts.clipPaths     local paths to scene clips
 * @param {number[]}  opts.clipDurations desired duration per clip (seconds)
 * @param {string}    opts.voiceoverPath local path to combined voiceover mp3
 * @param {string}    opts.title        title text overlay (first 4s)
 * @param {string[]}  opts.captions     per-scene captions (same length as clips)
 * @param {string}    opts.outPath      destination mp4
 */
async function assembleVideo(opts) {
  const {
    clipPaths, clipDurations, voiceoverPath, title, captions, outPath,
  } = opts;

  if (clipPaths.length !== clipDurations.length) {
    throw new Error('clipPaths / clipDurations length mismatch');
  }

  // Build a concat filter that also trims each clip to its target duration
  // and scales every frame to a uniform 1920x1080.
  const inputs = [];
  for (let i = 0; i < clipPaths.length; i++) {
    inputs.push(
      `-ss 0 -t ${clipDurations[i].toFixed(3)} -i ${escapePath(clipPaths[i])}`
    );
  }
  inputs.push(`-i ${escapePath(voiceoverPath)}`);

  // Concat filter
  let filterParts = [];
  for (let i = 0; i < clipPaths.length; i++) {
    filterParts.push(
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=cover,` +
      `crop=1920:1080,setpts=PTS-STARTPTS,fps=30,format=yuv420p[v${i}];`
    );
  }
  filterParts.push(
    clipPaths.map((_, i) => `[v${i}]`).join('') +
    `concat=n=${clipPaths.length}:v=1:a=0[vc];`
  );

  // Title overlay (first 4 seconds), bottom-left white text with shadow
  const safeTitle = (title || '').replace(/'/g, "\\'").replace(/:/g, '\\:');
  const titleFilter =
    `drawtext=text='${safeTitle}':fontcolor=white:fontsize=64:` +
    `box=1:boxcolor=black@0.55:boxborderw=20:` +
    `x=(w-text_w)/2:y=h-120:` +
    `enable='between(t,0,4)'[vc];`;

  // Per-scene captions: stagger by accumulated durations
  let captionAccum = 0;
  let captionChains = '';
  const safeCaptions = (captions || []).map(c =>
    (c || '').replace(/'/g, "\\'").replace(/:/g, '\\:').slice(0, 120)
  );
  // Apply captions in a single filter chain. Since each scene is 1 filter,
  // we chain them via [vc] -> [cap1] -> [cap2] -> ...
  let lastTag = 'vc';
  for (let i = 0; i < safeCaptions.length; i++) {
    const start = captionAccum;
    const end = captionAccum + clipDurations[i];
    captionAccum = end;
    const txt = safeCaptions[i];
    if (!txt) continue;
    const outTag = i === safeCaptions.length - 1 ? 'vout' : `cap${i}`;
    const f =
      `drawtext=text='${txt}':fontcolor=white:fontsize=42:` +
      `box=1:boxcolor=black@0.5:boxborderw=14:` +
      `x=(w-text_w)/2:y=h-220:` +
      `enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'`;
    filterParts.push(`[${lastTag}]${f}[${outTag}];`);
    lastTag = outTag;
  }
  // If no captions, keep last tag as vout
  if (lastTag !== 'vout') {
    filterParts.push(`[${lastTag}]copy[vout];`);
    lastTag = 'vout';
  }

  filterParts.push(titleFilter.replace('[vc]', `[${lastTag}]`));

  const filterComplex = filterParts.join('');

  const audioIndex = clipPaths.length;

  const cmd = [
    `ffmpeg -y`,
    ...inputs,
    `-filter_complex "${filterComplex}"`,
    `-map [vout]`,
    `-map ${audioIndex}:a`,
    `-c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p`,
    `-c:a aac -b:a 128k`,
    `-movflags +faststart`,
    `-shortest`,
    escapePath(outPath),
  ].join(' ');

  await runFFmpeg(cmd);
  return outPath;
}

function escapePath(p) {
  // FFmpeg on Linux uses forward slashes; quote if it has spaces
  const normalized = p.replace(/\\/g, '/');
  return /\s/.test(normalized) ? `"${normalized}"` : normalized;
}

function runFFmpeg(cmdString) {
  return new Promise((resolve, reject) => {
    require('child_process').exec(cmdString, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error('ffmpeg failed: ' + err.message + '\n' + stderr.slice(-2000)));
      }
      resolve(stdout);
    });
  });
}

// --- routes ----------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    ffmpeg: whichFFmpeg(),
  });
});

function whichFFmpeg() {
  try {
    return require('child_process').execSync('which ffmpeg').toString().trim();
  } catch {
    return 'unknown';
  }
}

app.post('/render', async (req, res) => {
  const id = newId();
  const workDir = path.join(TMP_ROOT, id);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const {
      scenes,           // [{ text, query, caption? }]
      voice = 'en-US-AriaNeural',
      title = '',
      pexelsKey,        // optional override; otherwise use env
      upload = true,    // set false to skip upload (returns local path)
    } = req.body || {};

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: 'scenes[] required' });
    }
    const pexelsApiKey = pexelsKey || process.env.PEXELS_API_KEY;
    if (!pexelsApiKey) return res.status(400).json({ error: 'PEXELS_API_KEY missing' });

    // 1) Generate voiceover (single combined file)
    const fullScript = scenes.map(s => s.text).join(' ');
    const voiceoverPath = path.join(workDir, 'voiceover.mp3');
    await generateVoiceover({ text: fullScript, voice, outPath: voiceoverPath });
    const totalAudio = await getMediaDuration(voiceoverPath);

    // 2) Allocate per-scene duration proportional to text length
    const totalChars = scenes.reduce((a, s) => a + (s.text || '').length, 0) || 1;
    let remaining = totalAudio;
    const sceneDurations = scenes.map((s, i) => {
      const isLast = i === scenes.length - 1;
      const d = isLast ? remaining : (totalAudio * ((s.text || '').length / totalChars));
      remaining -= d;
      return Math.max(2.5, d); // floor so every scene is at least 2.5s
    });

    // 3) Fetch + download stock clips
    const clipPaths = [];
    for (let i = 0; i < scenes.length; i++) {
      const q = scenes[i].query || scenes[i].text || 'abstract';
      let clip = null;
      try {
        clip = await fetchPexelsClip(q, pexelsApiKey);
      } catch (e) {
        console.warn(`Pexels failed for "${q}":`, e.message);
      }
      if (!clip) {
        // Fallback: empty mp4 of solid color via lavfi
        const fallback = path.join(workDir, `fallback_${i}.mp4`);
        await runFFmpeg(
          `ffmpeg -y -f lavfi -i color=c=0x1a1a2e:s=1920x1080:d=${sceneDurations[i].toFixed(2)} ` +
          `-c:v libx264 -pix_fmt yuv420p ${escapePath(fallback)}`
        );
        clipPaths.push(fallback);
      } else {
        const ext = (clip.url.split('.').pop() || 'mp4').split('?')[0];
        const localClip = path.join(workDir, `clip_${i}.${ext}`);
        await downloadTo(clip.url, localClip);
        clipPaths.push(localClip);
      }
    }

    // 4) Assemble
    const outPath = path.join(workDir, 'final.mp4');
    const captions = scenes.map(s => s.caption || s.text || '');
    await assembleVideo({
      clipPaths,
      clipDurations: sceneDurations,
      voiceoverPath,
      title,
      captions,
      outPath,
    });

    let publicUrl = null;
    if (upload) {
      publicUrl = await uploadToTmpFiles(outPath);
    }

    // Best-effort cleanup of intermediates (keep final.mp4 for a bit)
    setTimeout(() => {
      try {
        for (const f of fs.readdirSync(workDir)) {
          if (f !== 'final.mp4') fs.unlinkSync(path.join(workDir, f));
        }
      } catch {}
    }, 5 * 60 * 1000);

    res.json({
      ok: true,
      id,
      duration_seconds: totalAudio,
      video_url: publicUrl,
      local_path: upload ? null : outPath,
      file_size_bytes: fs.statSync(outPath).size,
    });
  } catch (err) {
    console.error('Render error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// List of free Edge TTS voices for the docs
app.get('/voices', (req, res) => {
  res.json({
    note: 'Edge TTS voices — pick one and pass to /render as `voice`',
    examples: [
      'en-US-AriaNeural',
      'en-US-GuyNeural',
      'en-US-JennyNeural',
      'en-GB-RyanNeural',
      'en-GB-SoniaNeural',
      'en-AU-NatashaNeural',
      'es-ES-ElviraNeural',
      'fr-FR-DeniseNeural',
      'de-DE-KatjaNeural',
      'it-IT-IsabellaNeural',
      'ja-JP-NanamiNeural',
      'zh-CN-XiaoxiaoNeural',
    ],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[video-render] listening on :${PORT}`);
});
