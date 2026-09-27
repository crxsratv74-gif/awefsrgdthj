require('dotenv').config();

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const http = require('http');
const express = require('express');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { chromium } = require('playwright');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 10000);
const URLS_FILE = process.env.URLS_FILE || './urls.txt';
const SETTINGS_FILE = process.env.SETTINGS_FILE || './recorder-settings.json';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || './recordings';
const RECORD_SECONDS = clampSeconds(process.env.RECORD_SECONDS || 30);
const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 60000);
const PAGE_WARMUP_MS = Number(process.env.PAGE_WARMUP_MS || 3000);
const AUTO_START = String(process.env.AUTO_START || 'false').toLowerCase() === 'true';
const DELETE_LOCAL_AFTER_UPLOAD = String(process.env.DELETE_LOCAL_AFTER_UPLOAD || 'false').toLowerCase() === 'true';
const APP_VERSION = '20.23.0';
const B2_PREFIX = 'recordings/';

const QUALITY_PRESETS = Object.freeze({
  '240p': { width: 426, height: 240 },
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '540p': { width: 960, height: 540 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
});

const SITE_PRESETS = Object.freeze({
  wispbyte: { label: 'Wispbyte Home', url: 'https://wispbyte.com/', quality: '480p', recordSeconds: 30, warmupMs: 5000 },
});

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

function clampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(3600, Math.max(1, Math.round(n)));
}

function cleanEndpoint(value) {
  return String(value || '').trim().replace(/^['"]+|['"]+$/g, '').replace(/\/+$/, '');
}

const B2_ENDPOINT = cleanEndpoint(process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com');
const B2_REGION = String(process.env.B2_REGION || 'us-east-005').trim();
const B2_BUCKET = String(process.env.B2_BUCKET || '').trim();
const B2_KEY_ID = String(process.env.B2_KEY_ID || '').trim();
const B2_APPLICATION_KEY = String(process.env.B2_APPLICATION_KEY || '').trim();

let b2EndpointError = null;
try {
  const parsed = new URL(B2_ENDPOINT);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Endpoint must use http:// or https://');
} catch {
  b2EndpointError = `Invalid B2_ENDPOINT: ${B2_ENDPOINT || '(empty)'}`;
}

const b2Configured = Boolean(!b2EndpointError && B2_ENDPOINT && B2_REGION && B2_BUCKET && B2_KEY_ID && B2_APPLICATION_KEY);
const s3 = b2Configured ? new S3Client({
  region: B2_REGION,
  endpoint: B2_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APPLICATION_KEY },
}) : null;

let settings = loadSettings();
let browser = null;
let runPromise = null;
let shutdownRequested = false;
let activeRunControl = null;
let activePage = null;
let activeContext = null;
let running = false;
let currentUrl = null;
let currentIndex = null;
let totalUrls = 0;
let activeRunUrls = [];
let activeRunSettings = null;
let lastResult = null;
let lastError = null;
let livePreviewBuffer = null;
let livePreviewUpdatedAt = null;
let runStartedAt = null;
let activeRunMode = null;
let scheduleStartedWindowKey = null;
let scheduleTimer = null;

function loadSettings() {
  const defaultQuality = QUALITY_PRESETS[process.env.DEFAULT_QUALITY] ? process.env.DEFAULT_QUALITY : '480p';
  const fallback = {
    quality: defaultQuality,
    width: QUALITY_PRESETS[defaultQuality].width,
    height: QUALITY_PRESETS[defaultQuality].height,
    recordSeconds: RECORD_SECONDS,
    durationEnabled: false,
    warmupMs: PAGE_WARMUP_MS,
    schedule: { enabled: false, startTime: '05:30', endTime: '06:00', timeZone: process.env.SCHEDULE_TIMEZONE || 'UTC' },
  };
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const quality = QUALITY_PRESETS[parsed.quality] ? parsed.quality : fallback.quality;
    const seconds = Number.isFinite(Number(parsed.recordSeconds)) ? clampSeconds(parsed.recordSeconds) : fallback.recordSeconds;
    const warmupMs = Number.isFinite(Number(parsed.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(parsed.warmupMs)))) : fallback.warmupMs;
    const schedule = normalizeSchedule(parsed.schedule, fallback.schedule);
    const durationEnabled = parsed.durationEnabled === true;
    return { quality, width: QUALITY_PRESETS[quality].width, height: QUALITY_PRESETS[quality].height, recordSeconds: seconds, durationEnabled, warmupMs, schedule };
  } catch (err) {
    console.log(`Settings load warning: ${err.message}`);
    return fallback;
  }
}

function normalizeSchedule(input, fallback) {
  const base = fallback || { enabled: false, startTime: '05:30', endTime: '06:00', timeZone: 'UTC' };
  const enabled = Boolean(input?.enabled);
  const startTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input?.startTime || '')) ? String(input.startTime) : base.startTime;
  const endTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input?.endTime || '')) ? String(input.endTime) : base.endTime;
  let timeZone = String(input?.timeZone || base.timeZone || 'UTC').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); } catch { timeZone = base.timeZone || 'UTC'; }
  return { enabled, startTime, endTime, timeZone };
}

function saveSettings(next) {
  const quality = QUALITY_PRESETS[next.quality] ? next.quality : settings.quality;
  const recordSeconds = clampSeconds(next.recordSeconds ?? settings.recordSeconds);
  const durationEnabled = next.durationEnabled !== undefined ? Boolean(next.durationEnabled) : settings.durationEnabled === true;
  const warmupMs = Number.isFinite(Number(next.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(next.warmupMs)))) : settings.warmupMs;
  const schedule = normalizeSchedule(next.schedule ?? settings.schedule, settings.schedule);
  settings = {
    quality,
    width: QUALITY_PRESETS[quality].width,
    height: QUALITY_PRESETS[quality].height,
    recordSeconds,
    durationEnabled,
    warmupMs,
    schedule,
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  return settings;
}

function parseClockMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function shiftDateKey(dateKey, deltaDays) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = part.value;
  return {
    dateKey: `${out.year}-${out.month}-${out.day}`,
    minute: Number(out.hour) * 60 + Number(out.minute),
  };
}

function zonedDateTimeToUtcMs(dateKey, timeString, timeZone) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const [hh, mm] = timeString.split(':').map(Number);
  const desiredAsUtc = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let guess = desiredAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(Number(actual.dateKey.slice(0, 4)), Number(actual.dateKey.slice(5, 7)) - 1, Number(actual.dateKey.slice(8, 10)), Math.floor(actual.minute / 60), actual.minute % 60, 0, 0);
    guess += desiredAsUtc - actualAsUtc;
  }
  return guess;
}

function getScheduleWindow(now = new Date()) {
  const schedule = settings.schedule;
  if (!schedule?.enabled) return { enabled: false, inWindow: false, windowKey: null, endAt: null };
  const start = parseClockMinutes(schedule.startTime);
  const end = parseClockMinutes(schedule.endTime);
  if (start == null || end == null || start === end) return { enabled: true, inWindow: false, windowKey: null, endAt: null, invalid: true };
  const local = zonedParts(now, schedule.timeZone || 'UTC');
  let inWindow = false;
  let windowKey = local.dateKey;
  let endDateKey = local.dateKey;
  if (start < end) {
    inWindow = local.minute >= start && local.minute < end;
  } else {
    inWindow = local.minute >= start || local.minute < end;
    if (local.minute < end) windowKey = shiftDateKey(local.dateKey, -1);
    endDateKey = local.minute >= start ? shiftDateKey(local.dateKey, 1) : local.dateKey;
  }
  const endAt = inWindow ? zonedDateTimeToUtcMs(endDateKey, schedule.endTime, schedule.timeZone || 'UTC') : null;
  return { enabled: true, inWindow, windowKey, endAt, startTime: schedule.startTime, endTime: schedule.endTime, timeZone: schedule.timeZone };
}

function scheduleSummary() {
  const w = getScheduleWindow();
  return { ...settings.schedule, inWindow: Boolean(w.inWindow), windowKey: w.windowKey, endAt: w.endAt };
}

async function scheduleTick() {
  const w = getScheduleWindow();
  if (!w.enabled || w.invalid || !settings.schedule.enabled) return;
  if (w.inWindow) {
    if (!scheduleStartedWindowKey || scheduleStartedWindowKey !== w.windowKey) {
      if (running) return;
      let urls = [];
      try { urls = readUrls(); } catch (err) { lastError = `Scheduled URL list error: ${err.message}`; return; }
      if (!urls.length) { lastError = 'Scheduled recording skipped: urls.txt is empty.'; return; }
      scheduleStartedWindowKey = w.windowKey;
      const scheduledSettings = { ...settings, schedule: undefined, windowEndAt: w.endAt };
      console.log(`Scheduled recording starting at ${settings.schedule.startTime} ${settings.schedule.timeZone} until ${settings.schedule.endTime}.`);
      runPromise = runRecorder(urls, 'scheduled', scheduledSettings)
        .catch(err => { lastError = err.message; console.error(`Scheduled recorder fatal error: ${err.message}`); })
        .finally(() => { runPromise = null; });
    }
  } else if (running && activeRunMode === 'scheduled' && scheduleStartedWindowKey) {
    if (activeRunControl) {
      activeRunControl.stopRequested = true;
      console.log(`Scheduled window ended. Stop requested for run ${activeRunControl.id}.`);
    }
  }
}


function normalizeUrls(input) {
  const values = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const value = String(raw ?? '').trim();
    if (!value || value.startsWith('#')) continue;
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`Only http:// and https:// URLs are allowed: ${value}`);
    const normalized = u.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function readUrls() {
  if (!fs.existsSync(URLS_FILE)) return [];
  return normalizeUrls(fs.readFileSync(URLS_FILE, 'utf8'));
}

function writeUrls(urls) {
  const clean = normalizeUrls(urls);
  fs.writeFileSync(URLS_FILE, clean.length ? `${clean.join('\n')}\n` : '');
  return clean;
}

function safeFilePart(value) {
  return String(value)
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 90) || 'page';
}

function makeFilename(index, url) {
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const host = safeFilePart(new URL(url).hostname);
  return `${String(index + 1).padStart(3, '0')}_${stamp}_${host}.webm`;
}

function validateKey(key) {
  const value = String(key || '');
  if (!value.startsWith(B2_PREFIX) || value.includes('..') || !/\.webm$/i.test(value)) throw new Error('Invalid recording key.');
  return value;
}

function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

async function uploadToB2(localPath, key) {
  if (!s3) throw new Error('B2 is not configured.');
  await s3.send(new PutObjectCommand({
    Bucket: B2_BUCKET,
    Key: key,
    Body: fs.createReadStream(localPath),
    ContentType: 'video/webm',
    ServerSideEncryption: 'AES256',
  }));
}

async function listB2Files() {
  if (!s3) throw new Error('B2 is not configured.');
  const all = [];
  let ContinuationToken;
  do {
    const out = await s3.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET,
      Prefix: B2_PREFIX,
      MaxKeys: 1000,
      ContinuationToken,
    }));
    all.push(...(out.Contents || []));
    ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (ContinuationToken);

  return all
    .filter(x => x.Key && /\.webm$/i.test(x.Key))
    .sort((a, b) => new Date(b.LastModified || 0) - new Date(a.LastModified || 0))
    .map(x => ({
      key: x.Key,
      filename: x.Key.slice(B2_PREFIX.length),
      size: x.Size || 0,
      lastModified: x.LastModified || null,
      previewUrl: `/api/preview?key=${encodeURIComponent(x.Key)}`,
      downloadUrl: `/api/download?key=${encodeURIComponent(x.Key)}`,
    }));
}

function safeStatus() {
  let savedUrls = [];
  try { savedUrls = readUrls(); } catch (err) { lastError = `URL file error: ${err.message}`; }
  return {
    ok: true,
    version: APP_VERSION,
    running,
    currentUrl,
    currentIndex,
    totalUrls,
    urls: running ? activeRunUrls.slice() : savedUrls,
    savedUrls,
    settings,
    schedule: scheduleSummary(),
    qualityPresets: QUALITY_PRESETS,
    b2Configured,
    bucket: B2_BUCKET || null,
    region: B2_REGION,
    endpoint: B2_ENDPOINT,
    endpointError: b2EndpointError,
    runStartedAt,
    activeRunSettings,
    activeRunMode,
    schedule: scheduleSummary(),
    lastResult,
    lastError,
    livePreviewUpdatedAt,
  };
}

function renderError(message, code = 500) {
  return { ok: false, error: message, code };
}

async function launchChromium() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function installPlaywrightChromium() {
  const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '0' };
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  console.log('Playwright Chromium binary missing. Installing Chromium automatically...');
  await execFileAsync(command, ['playwright', 'install', 'chromium'], { env, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  console.log('Playwright Chromium install completed.');
}

async function ensureBrowser() {
  if (browser) return browser;
  try {
    browser = await launchChromium();
  } catch (err) {
    const text = String(err && (err.message || err));
    if (!/Executable doesn't exist|browserType\.launch|Please run the following command to download new browsers|chromium_headless_shell/i.test(text)) {
      throw err;
    }
    await installPlaywrightChromium();
    browser = await launchChromium();
  }
  return browser;
}

async function captureLivePreview(page) {
  try {
    livePreviewBuffer = await page.screenshot({ type: 'jpeg', quality: 70, animations: 'disabled' });
    livePreviewUpdatedAt = new Date().toISOString();
  } catch (_) {}
}

async function validateWebmFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile() || stat.size < 1024) {
    throw new Error(`Recorded WebM is empty or too small (${stat.size} bytes).`);
  }
  const handle = await fsp.open(filePath, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await handle.read(header, 0, 4, 0);
    if (bytesRead !== 4 || !header.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
      throw new Error('Recorded file is not a valid WebM/EBML file.');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return stat.size;
}

async function recordOneUrl(url, index, runSettings, runControl) {
  const b = await ensureBrowser();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), `pella-webm-${randomUUID()}-`));
  const filename = makeFilename(index, url);
  const localPath = path.resolve(RECORDINGS_DIR, filename);
  let context = null;
  let page = null;
  let video = null;

  try {
    context = await b.newContext({
      viewport: { width: runSettings.width, height: runSettings.height },
      screen: { width: runSettings.width, height: runSettings.height },
      deviceScaleFactor: 1,
      hasTouch: true,
      recordVideo: { dir: tempDir, size: { width: runSettings.width, height: runSettings.height } },
    });
    activeContext = context;
    page = await context.newPage();
    activePage = page;
    video = page.video();
    currentUrl = url;
    currentIndex = index;
    livePreviewBuffer = null;
    livePreviewUpdatedAt = null;

    page.on('console', msg => {
      if (msg.type() === 'error') console.log(`Page console error: ${msg.text()}`);
    });
    page.on('pageerror', err => console.log(`Page error: ${err.message}`));

    console.log(`Loading: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
      console.log(`Page loaded: ${url}`);
    } catch (err) {
      console.log(`Navigation warning for ${url}: ${err.message}`);
      if (page.url() === 'about:blank') throw err;
    }

    const videos = await page.locator('video').count().catch(() => 0);
    const audios = await page.locator('audio').count().catch(() => 0);
    console.log(`Detected media: ${videos} video, ${audios} audio`);

    if (runSettings.warmupMs > 0) await new Promise(r => setTimeout(r, runSettings.warmupMs));
    await captureLivePreview(page);

    const timedEndAt = runSettings.durationEnabled === false ? Infinity : Date.now() + runSettings.recordSeconds * 1000;
    const scheduleEndAt = Number(runSettings.windowEndAt);
    const shouldStop = () => Boolean(runControl?.stopRequested);
    const endAt = Number.isFinite(scheduleEndAt) && scheduleEndAt > 0 ? Math.min(timedEndAt, scheduleEndAt) : timedEndAt;
    let nextPreviewAt = 0;
    console.log(`Recording ${url} at ${runSettings.quality} (${runSettings.width}x${runSettings.height}) for ${runSettings.durationEnabled === false ? 'manual duration' : runSettings.recordSeconds+'s'}`);
    while (!shouldStop() && Date.now() < endAt) {
      if (Date.now() >= nextPreviewAt) {
        await captureLivePreview(page);
        nextPreviewAt = Date.now() + 1000;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } finally {
    // Playwright writes/finalizes video only when the browser context closes.
    // Do not close the page separately or from the Stop endpoint; that can race
    // with context shutdown and leave a zero-byte WebM.
    if (context) await context.close().catch(() => {});
    if (page && activePage === page) activePage = null;
    if (context && activeContext === context) activeContext = null;
  }

  try {
    if (!video) throw new Error('Playwright did not create a video object.');
    await fsp.mkdir(path.dirname(localPath), { recursive: true });
    await video.saveAs(localPath);
    const size = await validateWebmFile(localPath);
    console.log(`Recording saved locally: ${localPath} (${size} bytes, valid WebM)`);
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }

  const key = `${B2_PREFIX}${filename}`;

  if (b2Configured) {
    await uploadToB2(localPath, key);
    console.log(`B2 upload OK: ${key}`);
    if (DELETE_LOCAL_AFTER_UPLOAD) await fsp.unlink(localPath).catch(() => {});
  } else {
    console.log('B2 upload skipped: B2 is not configured.');
  }

  return {
    url,
    filename,
    key,
    quality: runSettings.quality,
    width: runSettings.width,
    height: runSettings.height,
    recordSeconds: runSettings.recordSeconds,
    uploaded: b2Configured,
    finishedAt: new Date().toISOString(),
  };
}

async function runRecorder(urls, source, runSettingsInput) {
  if (running) throw new Error('Recorder is already running.');
  const runUrls = normalizeUrls(urls);
  if (!runUrls.length) throw new Error('No URLs provided.');

  const runSettings = {
    quality: QUALITY_PRESETS[runSettingsInput?.quality] ? runSettingsInput.quality : settings.quality,
    recordSeconds: clampSeconds(runSettingsInput?.recordSeconds ?? settings.recordSeconds),
    durationEnabled: runSettingsInput?.durationEnabled !== undefined ? Boolean(runSettingsInput.durationEnabled) : settings.durationEnabled === true,
    warmupMs: Number.isFinite(Number(runSettingsInput?.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(runSettingsInput.warmupMs)))) : settings.warmupMs,
    windowEndAt: Number.isFinite(Number(runSettingsInput?.windowEndAt)) ? Number(runSettingsInput.windowEndAt) : null,
  };
  runSettings.width = QUALITY_PRESETS[runSettings.quality].width;
  runSettings.height = QUALITY_PRESETS[runSettings.quality].height;

  const runControl = { id: randomUUID(), stopRequested: false, source };
  activeRunControl = runControl;
  running = true;
  lastError = null;
  lastResult = null;
  activeRunUrls = runUrls.slice();
  totalUrls = runUrls.length;
  activeRunSettings = { ...runSettings };
  delete activeRunSettings.windowEndAt;
  activeRunMode = source === 'scheduled' ? 'scheduled' : source;
  runStartedAt = new Date().toISOString();

  console.log(`Recorder starting from ${source}. ${runUrls.length} URL(s). Quality: ${runSettings.quality} (${runSettings.width}x${runSettings.height}), ${runSettings.durationEnabled === false ? 'manual duration' : runSettings.recordSeconds+'s each'}, warmup ${runSettings.warmupMs}ms. Run=${runControl.id}`);
  console.log(`Recorder control initialized: stopRequested=${runControl.stopRequested}, shutdownRequested=${shutdownRequested}`);
  runUrls.forEach((u, i) => console.log(`  [${i + 1}/${runUrls.length}] ${u}`));

  try {
    for (let i = 0; i < runUrls.length; i += 1) {
      console.log(`Recorder queue checkpoint [${i + 1}/${runUrls.length}]: stopRequested=${runControl.stopRequested}, shutdownRequested=${shutdownRequested}`);
      // A per-run stop request is the only normal way to cancel a recording.
      // The global shutdown flag is only for process termination and must never
      // prevent a fresh manual Start from beginning a new run.
      if (runControl.stopRequested) break;
      const queueEndAt = Number(runSettings.windowEndAt);
      if (queueEndAt > 0 && Date.now() >= queueEndAt) {
        console.log(`Recorder queue stopped at scheduled end time (${new Date(queueEndAt).toISOString()}).`);
        break;
      }
      currentIndex = i;
      try {
        lastResult = await recordOneUrl(runUrls[i], i, runSettings, runControl);
      } catch (err) {
        lastError = `${runUrls[i]}: ${err.message}`;
        console.error(`Recording failed: ${lastError}`);
      }
    }
  } finally {
    running = false;
    currentUrl = null;
    currentIndex = null;
    totalUrls = 0;
    activeRunUrls = [];
    activeRunSettings = null;
    activeRunMode = null;
    if (activeRunControl === runControl) activeRunControl = null;
    runStartedAt = null;
    livePreviewBuffer = null;
    livePreviewUpdatedAt = null;
    console.log('Recorder finished.');
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use((_req, res, next) => {
  noStore(res);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: APP_VERSION, running, b2Configured, bucket: B2_BUCKET || null, region: B2_REGION, endpoint: B2_ENDPOINT, endpointError: b2EndpointError, settings, currentUrl, currentIndex, totalUrls, lastError });
});

app.get('/api/status', (_req, res) => res.json(safeStatus()));

app.get('/api/debug', (_req, res) => {
  let savedUrls = [];
  let urlsError = null;
  try { savedUrls = readUrls(); } catch (err) { urlsError = err.message; }
  res.json({
    ok: true,
    version: APP_VERSION,
    node: process.version,
    cwd: process.cwd(),
    b2Configured,
    b2Endpoint: B2_ENDPOINT,
    b2Region: B2_REGION,
    b2Bucket: B2_BUCKET || null,
    hasKeyId: Boolean(B2_KEY_ID),
    hasApplicationKey: Boolean(B2_APPLICATION_KEY),
    urlsFile: path.resolve(URLS_FILE),
    savedUrls,
    urlsError,
    settingsFile: path.resolve(SETTINGS_FILE),
    recordingsDir: path.resolve(RECORDINGS_DIR),
  });
});

app.post('/api/start', async (req, res) => {
  if (running) return res.status(409).json(renderError('Recorder is already running.', 409));
  try {
    const urls = normalizeUrls(Array.isArray(req.body?.urls) ? req.body.urls : req.body?.text);
    if (!urls.length) return res.status(400).json(renderError('Paste at least one valid URL into the panel.', 400));

    const quality = String(req.body?.quality || settings.quality);
    if (!QUALITY_PRESETS[quality]) return res.status(400).json(renderError(`Unsupported quality: ${quality}`, 400));
    const recordSeconds = clampSeconds(req.body?.recordSeconds ?? settings.recordSeconds);
    const durationEnabled = req.body?.durationEnabled !== undefined ? Boolean(req.body.durationEnabled) : settings.durationEnabled === true;
    const warmupMs = Number.isFinite(Number(req.body?.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(req.body.warmupMs)))) : settings.warmupMs;

    // The panel's scheduler toggle is authoritative. When the user starts manually
    // with the timer OFF, explicitly clear all schedule state so the scheduler cannot
    // race with the manual run. Reset the process-local shutdown marker as well; the
    // process is still alive, so a new manual recording must be allowed to start.
    const scheduleEnabledFromPanel = req.body?.scheduleEnabled;
    const schedulePatch = scheduleEnabledFromPanel !== undefined
      ? { ...(settings.schedule || {}), enabled: Boolean(scheduleEnabledFromPanel) }
      : settings.schedule;
    const savedSettings = saveSettings({ quality, recordSeconds, durationEnabled, warmupMs, schedule: schedulePatch });
    if (!savedSettings.schedule?.enabled) scheduleStartedWindowKey = null;
    shutdownRequested = false;

    // A manual start made while an active schedule window is open takes the slot for
    // that window, preventing the scheduler from launching a duplicate run 5 seconds later.
    if (savedSettings.schedule?.enabled) {
      const w = getScheduleWindow();
      if (w.inWindow && w.windowKey) scheduleStartedWindowKey = w.windowKey;
    }

    console.log(`Panel start requested with ${urls.length} URL(s), ${savedSettings.quality}, ${savedSettings.durationEnabled ? savedSettings.recordSeconds+'s / URL' : 'manual duration'}, schedule ${savedSettings.schedule?.enabled ? 'ON' : 'OFF'}.`);
    urls.forEach((u, i) => console.log(`  [${i + 1}] ${u}`));

    // Clear any stale per-run stop state by creating a fresh run inside runRecorder.
    runPromise = runRecorder(urls, 'panel', savedSettings)
      .catch(err => { lastError = err.message; console.error(`Recorder fatal error: ${err.message}`); })
      .finally(() => { runPromise = null; });

    // runRecorder sets running=true before its first await. If it did not, something
    // blocked the launch immediately and we should report that instead of telling the
    // panel that recording started.
    if (!running) {
      throw new Error('Recorder did not enter running state. Please try Start Recording again.');
    }

    return res.json({ ok: true, started: true, source: 'panel', urls, settings: savedSettings });
  } catch (err) {
    return res.status(400).json(renderError(err.message, 400));
  }
});

app.post('/api/stop', async (_req, res) => {
  if (!running) return res.json({ ok: true, stopped: false, message: 'Recorder is not running.' });
  if (activeRunControl) {
    activeRunControl.stopRequested = true;
    console.log(`Stop requested from panel for run ${activeRunControl.id}. The current recording will stop at the next safe checkpoint and the WebM will be finalized by browserContext.close().`);
  }
  return res.json({ ok: true, stopped: true, message: 'Stop requested. The current WebM will be finalized and the queue will stop.' });
});

app.get('/api/urls', (_req, res) => {
  try { res.json({ ok: true, urls: readUrls() }); }
  catch (err) { res.status(500).json(renderError(err.message, 500)); }
});

app.post('/api/urls', (req, res) => {
  try {
    const urls = writeUrls(Array.isArray(req.body?.urls) ? req.body.urls : req.body?.text);
    res.json({ ok: true, urls });
  } catch (err) { res.status(400).json(renderError(err.message, 400)); }
});

app.delete('/api/urls', (_req, res) => {
  try { res.json({ ok: true, urls: writeUrls([]) }); }
  catch (err) { res.status(500).json(renderError(err.message, 500)); }
});

app.post('/api/settings', (req, res) => {
  try {
    const quality = String(req.body?.quality || settings.quality);
    if (!QUALITY_PRESETS[quality]) throw new Error(`Unsupported quality: ${quality}`);
    const recordSeconds = clampSeconds(req.body?.recordSeconds ?? settings.recordSeconds);
    const durationEnabled = req.body?.durationEnabled !== undefined ? Boolean(req.body.durationEnabled) : settings.durationEnabled === true;
    const warmupMs = Number.isFinite(Number(req.body?.warmupMs)) ? Math.min(30000, Math.max(0, Math.round(Number(req.body.warmupMs)))) : settings.warmupMs;
    res.json({ ok: true, settings: saveSettings({ quality, recordSeconds, durationEnabled, warmupMs }) });
  } catch (err) { res.status(400).json(renderError(err.message, 400)); }
});

app.get('/api/schedule', (_req, res) => {
  res.json({ ok: true, schedule: scheduleSummary() });
});

app.post('/api/schedule', (req, res) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const startTime = String(req.body?.startTime || '');
    const endTime = String(req.body?.endTime || '');
    const timeZone = String(req.body?.timeZone || '').trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new Error('Start time must use HH:MM.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) throw new Error('End time must use HH:MM.');
    if (startTime === endTime) throw new Error('Start time and end time must be different.');
    try { new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date()); } catch { throw new Error(`Invalid time zone: ${timeZone}`); }
    const startMin = parseClockMinutes(startTime);
    const endMin = parseClockMinutes(endTime);
    const nextSchedule = { enabled, startTime, endTime, timeZone };
    settings = saveSettings({ ...settings, schedule: nextSchedule });
    if (!enabled) scheduleStartedWindowKey = null;
    console.log(`Schedule ${enabled ? 'enabled' : 'disabled'}: ${startTime}-${endTime} ${timeZone}`);
    res.json({ ok: true, schedule: scheduleSummary(), spansMidnight: startMin > endMin });
  } catch (err) { res.status(400).json(renderError(err.message, 400)); }
});

app.get('/api/files', async (_req, res) => {
  try {
    if (!b2Configured) return res.status(503).json(renderError('B2 is not configured. Add the B2 environment variables in Render.', 503));
    res.json({ ok: true, bucket: B2_BUCKET, files: await listB2Files() });
  } catch (err) {
    console.error(`B2 list error: ${err.message}`);
    res.status(502).json(renderError(`B2 list failed: ${err.message}`, 502));
  }
});

async function streamB2Object(req, res, key, attachment) {
  if (!b2Configured) throw new Error('B2 is not configured.');
  const request = { Bucket: B2_BUCKET, Key: key };
  if (req.headers.range) request.Range = req.headers.range;
  const out = await s3.send(new GetObjectCommand(request));
  const partial = Boolean(req.headers.range);
  res.status(partial ? 206 : 200);
  res.setHeader('Content-Type', out.ContentType || 'video/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  if (out.ContentLength != null) res.setHeader('Content-Length', String(out.ContentLength));
  if (out.ContentRange) res.setHeader('Content-Range', out.ContentRange);
  res.setHeader('Content-Disposition', attachment ? `attachment; filename="${path.basename(key).replace(/["\r\n]/g, '')}"` : 'inline');
  if (out.Body?.pipe) out.Body.pipe(res);
  else res.end(Buffer.from(await out.Body.transformToByteArray()));
}

app.get('/api/preview', async (req, res) => {
  try { await streamB2Object(req, res, validateKey(req.query.key), false); }
  catch (err) { console.error(`B2 preview error: ${err.message}`); if (!res.headersSent) res.status(502).send(`Preview failed: ${err.message}`); }
});

app.get('/api/download', async (req, res) => {
  try { await streamB2Object(req, res, validateKey(req.query.key), true); }
  catch (err) { console.error(`B2 download error: ${err.message}`); if (!res.headersSent) res.status(502).send(`Download failed: ${err.message}`); }
});

function removeLocalByKey(key) {
  const local = path.resolve(RECORDINGS_DIR, path.basename(key));
  if (fs.existsSync(local)) fs.unlinkSync(local);
}

app.post('/api/delete', async (req, res) => {
  try {
    const key = validateKey(req.body?.key);
    if (!b2Configured) throw new Error('B2 is not configured.');
    await s3.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key }));
    removeLocalByKey(key);
    res.json({ ok: true, deleted: key });
  } catch (err) {
    console.error(`B2 delete error: ${err.message}`);
    res.status(502).json(renderError(`Delete failed: ${err.message}`, 502));
  }
});

app.post('/api/delete-many', async (req, res) => {
  try {
    const input = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const keys = [...new Set(input.map(validateKey))];
    if (!keys.length) return res.status(400).json(renderError('No files selected.', 400));
    if (!b2Configured) throw new Error('B2 is not configured.');
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: B2_BUCKET, Delete: { Objects: keys.map(Key => ({ Key })), Quiet: true } }));
    for (const key of keys) removeLocalByKey(key);
    if (result.Errors?.length) throw new Error(result.Errors.map(e => `${e.Key}: ${e.Message}`).join('; '));
    res.json({ ok: true, deleted: keys });
  } catch (err) {
    console.error(`B2 bulk delete error: ${err.message}`);
    res.status(502).json(renderError(`Delete failed: ${err.message}`, 502));
  }
});

app.get('/api/live-preview', (_req, res) => {
  if (!livePreviewBuffer) return res.status(404).send('No live preview available.');
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.end(livePreviewBuffer);
});

app.post('/api/input', async (req, res) => {
  try {
    if (!running || !activePage || activePage.isClosed()) {
      return res.status(409).json({ ok: false, error: 'No active browser page.' });
    }

    const type = String(req.body?.type || '').trim().toLowerCase();
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    const maxX = Number(activeRunSettings?.width || 0);
    const maxY = Number(activeRunSettings?.height || 0);

    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > maxX || y > maxY) {
      return res.status(400).json({ ok: false, error: 'Invalid input coordinates.' });
    }

    if (type === 'click') {
      const button = ['left', 'middle', 'right'].includes(String(req.body?.button)) ? String(req.body.button) : 'left';
      const clickCount = Math.min(2, Math.max(1, Number(req.body?.clickCount) || 1));
      await activePage.mouse.click(x, y, { button, clickCount });
      return res.json({ ok: true, type, x, y });
    }

    if (type === 'tap') {
      await activePage.touchscreen.tap(x, y);
      return res.json({ ok: true, type, x, y });
    }

    if (type === 'wheel') {
      const deltaX = Number(req.body?.deltaX) || 0;
      const deltaY = Number(req.body?.deltaY) || 0;
      await activePage.mouse.move(x, y);
      await activePage.mouse.wheel(deltaX, deltaY);
      return res.json({ ok: true, type, x, y, deltaX, deltaY });
    }

    return res.status(400).json({ ok: false, error: 'Unsupported input type.' });
  } catch (err) {
    console.error(`Live input error: ${err.message}`);
    return res.status(502).json({ ok: false, error: `Input failed: ${err.message}` });
  }
});

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B','KB','MB','GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

app.get('/api/bootstrap', (_req, res) => {
  noStore(res);
  res.json({
    ok: true,
    version: APP_VERSION,
    initialUrls: (() => { try { return readUrls(); } catch { return []; } })(),
    settings,
    schedule: scheduleSummary(),
    qualityPresets: QUALITY_PRESETS,
    sitePresets: SITE_PRESETS,
  });
});

app.get('/app.js', (_req, res) => {
  noStore(res);
  res.type('application/javascript').sendFile(path.join(__dirname, 'app.js'));
});

app.get('/', (_req, res) => {
  let urls = [];
  try { urls = readUrls(); } catch (_) {}
  const options = Object.entries(QUALITY_PRESETS)
    .map(([q, p]) => '<option value="' + q + '" ' + (q === settings.quality ? 'selected' : '') + '>' + q + ' — ' + p.width + '×' + p.height + '</option>')
    .join('');

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
<title>Pella Render Recorder v${APP_VERSION}</title>
<style>
:root{
  --bg:#0a0f17;
  --panel:#101722;
  --panel-2:#0d141e;
  --panel-3:#131c28;
  --line:#223044;
  --line-2:#2c3b50;
  --text:#f5f8fc;
  --muted:#8fa1b6;
  --muted-2:#687990;
  --accent:#5b8cff;
  --accent-2:#7ca4ff;
  --success:#35d07f;
  --danger:#ff6b73;
  --warning:#ffbd66;
  --shadow:0 18px 50px rgba(0,0,0,.32);
  --radius:18px;
  font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
*{box-sizing:border-box}
html{background:var(--bg)}
body{
  margin:0;
  background:
    radial-gradient(900px 500px at 10% -10%,rgba(91,140,255,.12),transparent 55%),
    radial-gradient(800px 500px at 100% 0%,rgba(53,208,127,.07),transparent 60%),
    var(--bg);
  color:var(--text);
  min-height:100vh;
}
a{color:var(--accent-2)}
button,input,select,textarea{font:inherit}
button,.btn{cursor:pointer}
.shell{max-width:1380px;margin:0 auto;padding:28px 22px 40px}
.topbar{
  display:flex;justify-content:space-between;align-items:center;gap:18px;
  padding:18px 20px;margin-bottom:18px;border:1px solid var(--line);
  border-radius:22px;background:rgba(16,23,34,.86);backdrop-filter:blur(16px);
  box-shadow:var(--shadow);
}
.brand{display:flex;align-items:center;gap:14px;min-width:0}
.brandmark{
  width:42px;height:42px;border-radius:13px;display:grid;place-items:center;
  background:linear-gradient(135deg,#5b8cff,#7b62ff);font-weight:800;letter-spacing:-.03em;
}
.brandcopy{min-width:0}
.brandcopy h1{margin:0;font-size:20px;font-weight:800;letter-spacing:-.02em}
.brandcopy .sub{margin-top:4px;color:var(--muted);font-size:12px}
.top-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(340px,.8fr);gap:18px}
.stack{display:grid;gap:18px}
.card{
  background:linear-gradient(180deg,rgba(16,23,34,.96),rgba(13,20,30,.96));
  border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);
  overflow:hidden;
}
.card-head{
  display:flex;justify-content:space-between;align-items:flex-start;gap:16px;
  padding:20px 22px;border-bottom:1px solid var(--line)
}
.card-title{display:flex;align-items:center;gap:10px}
.card-title .icon{
  width:34px;height:34px;border-radius:10px;background:var(--panel-3);
  border:1px solid var(--line-2);display:grid;place-items:center;color:var(--accent-2);font-size:15px;
}
.card-title h2{margin:0;font-size:16px;letter-spacing:-.01em}
.card-title p{margin:4px 0 0;color:var(--muted);font-size:12px}
.card-body{padding:22px}
.status{
  margin:0 0 18px;padding:12px 14px;border:1px solid var(--line);border-radius:13px;
  background:var(--panel-2);color:#b7c6d9;font-size:13px
}
.status.err{color:#ffb9be;border-color:rgba(255,107,115,.35);background:rgba(93,24,30,.18)}
.toolbar{display:flex;gap:10px;flex-wrap:wrap}
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  min-height:42px;padding:0 14px;border-radius:12px;border:1px solid var(--line-2);
  background:#131c28;color:var(--text);text-decoration:none;font-weight:650;font-size:13px;
  transition:.18s ease;box-shadow:inset 0 1px 0 rgba(255,255,255,.03)
}
.btn:hover{transform:translateY(-1px);background:#182333;border-color:#3a4d68}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn.primary{background:linear-gradient(135deg,#5b8cff,#466fd7);border-color:#6e98ff;color:white}
.btn.primary:hover{filter:brightness(1.06)}
.btn.success{background:rgba(53,208,127,.10);border-color:rgba(53,208,127,.35);color:#82e8b0}
.btn.danger{background:rgba(255,107,115,.09);border-color:rgba(255,107,115,.35);color:#ff9da4}
.btn.ghost{background:transparent}
.grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:14px}
.field{grid-column:span 4;display:grid;gap:8px}
.field.wide{grid-column:span 12}
.field.half{grid-column:span 6}
label{color:#dce5f0;font-size:12px;font-weight:650}
.input,.select,textarea{
  width:100%;border:1px solid var(--line-2);border-radius:12px;
  background:#0c131c;color:var(--text);padding:12px 13px;outline:none;
  transition:.18s ease
}
.input:focus,.select:focus,textarea:focus{border-color:#5d87dc;box-shadow:0 0 0 3px rgba(91,140,255,.12)}
textarea{min-height:210px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.55}
.help{color:var(--muted);font-size:11px;line-height:1.5}
.pillrow{display:flex;gap:8px;flex-wrap:wrap}
.pill{
  display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border-radius:999px;
  background:#111b29;border:1px solid var(--line);color:#c7d4e5;font-size:11px
}
.pill.active{color:#9fe9bd;border-color:rgba(53,208,127,.25);background:rgba(53,208,127,.08)}
.preview-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px}.switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none}.switch input{position:absolute;opacity:0;pointer-events:none}.slider{width:42px;height:24px;border-radius:999px;background:#3a4654;position:relative;transition:.18s;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}.slider:after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.18s;box-shadow:0 2px 5px rgba(0,0,0,.25)}.switch input:checked + .slider{background:#11a9ff}.switch input:checked + .slider:after{transform:translateX(18px)}.switch-text{font-size:13px;color:#d7e2ef}.switch-text b{font-weight:800}.preview img[aria-disabled='true']{opacity:.86;cursor:default!important}
.preview{
  position:relative;min-height:320px;border:1px solid var(--line);border-radius:15px;
  background:#060a0f;overflow:hidden;display:flex;align-items:center;justify-content:center
}
.preview:before{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(120deg,rgba(91,140,255,.05),transparent 40%,rgba(53,208,127,.03))
}
.preview img{display:block;width:100%;max-height:580px;object-fit:contain;position:relative}
.empty{padding:60px 24px;text-align:center;color:var(--muted)}
.url-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;margin-top:12px}
.notice{
  padding:12px 14px;border-radius:12px;background:#0d1824;border:1px solid var(--line);
  color:#a9bad0;min-height:42px;font-size:12px
}
.notice.ok{background:rgba(53,208,127,.08);border-color:rgba(53,208,127,.22);color:#91e6b5}
.notice.err{background:rgba(255,107,115,.08);border-color:rgba(255,107,115,.25);color:#ffadb3}
.files{display:grid;gap:12px}
.file{
  background:#0b121b;border:1px solid var(--line);border-radius:15px;padding:14px
}
.filehead{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;margin-bottom:12px}
.name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dce6f3}
.meta{font-size:11px;color:var(--muted);white-space:nowrap}
.file video{width:100%;max-height:430px;background:#000;border-radius:11px;border:1px solid #172231}
.small{font-size:11px}.muted{color:var(--muted)}
.top-card{padding:22px}
.hero{
  display:flex;justify-content:space-between;gap:20px;align-items:flex-end;
  flex-wrap:wrap
}
.hero-copy{max-width:760px}
.hero-copy h2{margin:0;font-size:24px;letter-spacing:-.03em}
.hero-copy p{margin:8px 0 0;color:var(--muted);font-size:13px;line-height:1.55}
.metrics{display:flex;gap:10px;flex-wrap:wrap}
.metric{
  min-width:150px;padding:12px 14px;border:1px solid var(--line);border-radius:13px;background:#0c131d
}
.metric .k{color:var(--muted-2);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
.metric .v{margin-top:4px;font-weight:750;font-size:14px;color:#dce6f3}
kbd{font-family:inherit;padding:3px 6px;border:1px solid var(--line-2);border-bottom-color:#162235;border-radius:6px;background:#0c131c;color:#aebed1;font-size:10px}
@media(max-width:1020px){.layout{grid-template-columns:1fr}.metrics{width:100%}.metric{flex:1}}
@media(max-width:760px){
  .shell{padding:14px 12px 26px}.topbar,.card-head{padding:16px}.card-body{padding:16px}
  .field,.field.half{grid-column:span 12}
  .filehead{grid-template-columns:1fr}.meta{white-space:normal}
  .url-tools{grid-template-columns:1fr}
  .top-actions{width:100%;justify-content:flex-start}
}

/* Recording state effects */
#edgeGlow{
  position:fixed;
  inset:0;
  z-index:99999;
  pointer-events:none;
  opacity:0;
  transition:opacity .2s ease;
  background:
    linear-gradient(90deg,transparent 0%,rgba(91,140,255,.18) 34%,#74e8ff 50%,rgba(91,140,255,.18) 66%,transparent 100%) top/260px 3px repeat-x,
    linear-gradient(90deg,transparent 0%,rgba(91,140,255,.18) 34%,#74e8ff 50%,rgba(91,140,255,.18) 66%,transparent 100%) bottom/260px 3px repeat-x,
    linear-gradient(0deg,transparent 0%,rgba(91,140,255,.18) 34%,#74e8ff 50%,rgba(91,140,255,.18) 66%,transparent 100%) left/3px 260px repeat-y,
    linear-gradient(0deg,transparent 0%,rgba(91,140,255,.18) 34%,#74e8ff 50%,rgba(91,140,255,.18) 66%,transparent 100%) right/3px 260px repeat-y;
  filter:drop-shadow(0 0 5px rgba(91,140,255,.35)) drop-shadow(0 0 16px rgba(91,140,255,.22));
}
body.recording #edgeGlow{
  opacity:1;
  animation:edgeSweep 2.8s linear infinite,edgePulse 1.8s ease-in-out infinite;
}
@keyframes edgeSweep{
  0%{background-position:-260px 0,calc(100% + 260px) 100%,0 calc(100% + 260px),100% -260px}
  100%{background-position:calc(100% + 260px) 0,-260px 100%,0 -260px,100% calc(100% + 260px)}
}
@keyframes edgePulse{0%,100%{filter:drop-shadow(0 0 4px rgba(91,140,255,.28)) drop-shadow(0 0 12px rgba(91,140,255,.18))}50%{filter:drop-shadow(0 0 9px rgba(116,232,255,.55)) drop-shadow(0 0 24px rgba(91,140,255,.35))}}
.action-btn{min-width:190px}
.action-btn.recording-stop{
  background:linear-gradient(135deg,#f0445d,#c7283d);
  border-color:#ff7184;
  color:#fff;
  box-shadow:0 0 0 1px rgba(255,113,132,.18),0 0 14px rgba(255,73,93,.45),inset 0 1px 0 rgba(255,255,255,.12);
  animation:stopPulse 1.25s ease-in-out infinite;
}
.action-btn.recording-stop:hover{filter:brightness(1.07)}
@keyframes stopPulse{0%,100%{box-shadow:0 0 0 1px rgba(255,113,132,.16),0 0 12px rgba(255,73,93,.35),inset 0 1px 0 rgba(255,255,255,.12)}50%{box-shadow:0 0 0 1px rgba(255,113,132,.3),0 0 22px rgba(255,73,93,.62),inset 0 1px 0 rgba(255,255,255,.12)}}
@media (prefers-reduced-motion:reduce){
  body.recording #edgeGlow,.action-btn.recording-stop{animation:none}
}


/* v20.19 UI polish: presentation only */
.quick-guide{display:flex;align-items:center;gap:18px;padding:14px 18px;margin:0 0 18px;background:rgba(13,20,30,.86)}
.guide-step{display:flex;align-items:center;gap:10px;min-width:0;flex:1}
.guide-step>div{display:grid;gap:2px}
.guide-step b{font-size:12px;color:#eef4fb}
.guide-step small{font-size:10px;color:var(--muted);line-height:1.4}
.guide-num{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(91,140,255,.12);border:1px solid rgba(91,140,255,.28);color:#9ab8ff;font-weight:800;font-size:11px;flex:0 0 auto}
.guide-line{width:34px;height:1px;background:linear-gradient(90deg,rgba(91,140,255,.1),rgba(91,140,255,.42),rgba(91,140,255,.1));flex:0 0 auto}
.field-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.field-sub{margin-top:3px;color:var(--muted-2);font-size:10px;line-height:1.4}
.warning-pill{color:#ffd394;border-color:rgba(255,189,102,.24);background:rgba(255,189,102,.08)}
.duration-control{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px;padding:10px 11px;border:1px solid var(--line);border-radius:12px;background:#0b121a}
.duration-input{max-width:150px}
.duration-input:disabled{opacity:.48;cursor:not-allowed;background:#080e15}
.unit-label{font-size:11px;color:var(--muted)}
.preview{min-height:360px}
.preview-badge{position:absolute;top:12px;left:12px;z-index:2;padding:6px 8px;border-radius:999px;font-size:9px;font-weight:800;letter-spacing:.09em;color:#b8d4ff;background:rgba(8,14,22,.78);border:1px solid rgba(124,164,255,.25);backdrop-filter:blur(10px)}
.empty{display:grid;justify-items:center;gap:8px;max-width:360px}
.empty-icon{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;background:#0d1723;border:1px solid var(--line-2);color:#7ca4ff;font-size:18px}
.empty b{font-size:13px;color:#dbe6f3}
.empty span{font-size:11px;color:var(--muted);line-height:1.5}
.preview-controls-card{justify-content:space-between;padding:12px 14px;border:1px solid var(--line);border-radius:13px;background:#0c141e}
.control-title{font-size:12px;font-weight:750;color:#dfe8f3;margin-bottom:3px}
.control-switch{padding:7px 9px;border-radius:10px;background:#111b28;border:1px solid var(--line)}
.card-head{background:linear-gradient(180deg,rgba(255,255,255,.012),transparent)}
.card:hover{border-color:#2c3d55}
.btn.primary{box-shadow:0 8px 22px rgba(70,111,215,.2)}
.action-btn{font-size:13px;font-weight:800;min-height:46px;padding-inline:18px}
.status{display:flex;align-items:center;min-height:46px}
@media(max-width:760px){
  .quick-guide{display:grid;grid-template-columns:1fr;gap:10px;padding:14px}
  .guide-line{width:100%;height:1px}
  .duration-control{align-items:stretch}
  .duration-control .switch{width:100%;justify-content:space-between}
  .duration-input{max-width:100%;flex:1}
  .preview{min-height:280px}
  .preview-controls-card{align-items:flex-start;flex-direction:column}
  .control-switch{width:100%;justify-content:space-between}
}

</style>
</head>
<body>
<div id="edgeGlow" aria-hidden="true"></div>
<main class="shell">
  <header class="topbar">
    <div class="brand">
      <div class="brandmark">P</div>
      <div class="brandcopy">
        <h1>Pella Render Recorder</h1>
        <div class="sub">Professional webpage capture · Playwright · Backblaze B2</div>
      </div>
    </div>
    <div class="top-actions">
      <button type="button" id="refreshBtn" class="btn ghost">↻ Refresh</button>
      <button type="button" id="stopBtn" hidden aria-hidden="true" tabindex="-1">■ Stop</button>
      <button type="button" id="startBtn" class="btn primary action-btn">▶ Start Recording</button>
    </div>
  </header>

  <section class="card top-card">
    <div id="status" class="status">Version ${APP_VERSION} · Connecting…</div>
    <div class="hero">
      <div class="hero-copy">
        <h2>Record web pages cleanly and send the finished WebM to B2.</h2>
        <p id="substatus">Manual Start uses the URLs currently in the panel. Saved urls.txt is only loaded when you press Load urls.txt.</p>
      </div>
      <div class="metrics">
        <div class="metric"><div class="k">Quality</div><div class="v" id="heroQuality">${settings.quality} · ${settings.width}×${settings.height}</div></div>
        <div class="metric"><div class="k">Duration</div><div class="v"><span id="heroSeconds">Manual</span><span id="heroSecondsSuffix"></span></div></div>
        <div class="metric"><div class="k">B2 Bucket</div><div class="v">${B2_BUCKET ? htmlEscape(B2_BUCKET) : 'Not configured'}</div></div>
      </div>
    </div>
  </section>

  <section class="quick-guide card">
    <div class="guide-step"><span class="guide-num">1</span><div><b>Add your URLs</b><small>One webpage per line</small></div></div>
    <div class="guide-line"></div>
    <div class="guide-step"><span class="guide-num">2</span><div><b>Choose recording options</b><small>Quality, warmup, optional seconds limit</small></div></div>
    <div class="guide-line"></div>
    <div class="guide-step"><span class="guide-num">3</span><div><b>Start Recording</b><small>WebM is uploaded to B2 when finished</small></div></div>
  </section>

  <div class="layout">
    <div class="stack">
      <section class="card">
        <div class="card-head">
          <div class="card-title"><div class="icon">⚙</div><div><h2>Recording Settings</h2><p>These settings apply to the next recording.</p></div></div>
        </div>
        <div class="card-body">
          <div class="grid">
            <div class="field half">
              <label for="quality">Video quality</label>
              <select id="quality" class="select">${options}</select>
              <div id="selectedQualityHelp" class="help">Selected: ${settings.quality} — ${settings.width}×${settings.height}.</div>
            </div>
            <div class="field">
              <div class="field-head"><div><label for="recordSeconds">Seconds per URL</label><div class="field-sub">Optional time limit for each URL</div></div><span id="durationModePill" class="pill warning-pill">MANUAL</span></div>
              <div class="duration-control">
                <label class="switch"><input id="durationEnabled" type="checkbox"><span class="slider" aria-hidden="true"></span><span class="switch-text">Enable limit <b id="durationEnabledLabel">OFF</b></span></label>
                <input id="recordSeconds" class="input duration-input" type="number" min="1" max="3600" value="${settings.recordSeconds}" disabled>
                <span class="unit-label">seconds</span>
              </div>
              <div id="durationHelp" class="help">Manual mode: each URL continues until you press Stop or the scheduled end time. Turn ON to use the seconds value.</div>
            </div>
            <div class="field">
              <label for="warmupSeconds">Page warmup seconds</label>
              <input id="warmupSeconds" class="input" type="number" min="0" max="30" step="1" value="${Math.round(settings.warmupMs/1000)}">
              <div class="help">Wait after the page loads before the timed capture starts.</div>
            </div>
          </div>
          <div class="toolbar" style="margin-top:14px">
            <button type="button" id="saveSettingsBtn" class="btn success">✓ Save Settings</button>
            <button type="button" id="wispbytePresetBtn" class="btn">Wispbyte Preset</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title"><div class="icon">⏰</div><div><h2>Automatic Schedule</h2><p>Start the saved URL list automatically every day at a specific time and stop at the end time.</p></div></div>
          <span id="scheduleStatus" class="pill">OFF</span>
        </div>
        <div class="card-body">
          <div class="grid">
            <div class="field">
              <label class="switch"><input id="scheduleEnabled" type="checkbox"><span class="slider" aria-hidden="true"></span><span class="switch-text">Daily schedule <b id="scheduleEnabledLabel">OFF</b></span></label>
            </div>
            <div class="field">
              <label>Start time</label>
              <div class="row" style="gap:8px;align-items:center">
                <input id="scheduleStartHour" class="input" type="number" min="1" max="12" step="1" value="5" aria-label="Start hour" style="max-width:88px">
                <span>:</span>
                <input id="scheduleStartMinute" class="input" type="number" min="0" max="59" step="1" value="30" aria-label="Start minute" style="max-width:88px">
                <select id="scheduleStartPeriod" class="input" aria-label="Start AM or PM" style="max-width:100px">
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label>End time</label>
              <div class="row" style="gap:8px;align-items:center">
                <input id="scheduleEndHour" class="input" type="number" min="1" max="12" step="1" value="6" aria-label="End hour" style="max-width:88px">
                <span>:</span>
                <input id="scheduleEndMinute" class="input" type="number" min="0" max="59" step="1" value="0" aria-label="End minute" style="max-width:88px">
                <select id="scheduleEndPeriod" class="input" aria-label="End AM or PM" style="max-width:100px">
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>
              </div>
              <div class="help">Choose the hour, minutes, and AM/PM explicitly.</div>
            </div>
            <div class="field wide">
              <label for="scheduleTimeZone">Time zone</label>
              <input id="scheduleTimeZone" class="input" type="text" placeholder="Asia/Kolkata">
              <div class="help">Use your local IANA time zone. Example: Asia/Kolkata. Scheduled recording uses the saved <b>urls.txt</b> list.</div>
            </div>
          </div>
          <div class="toolbar" style="margin-top:14px">
            <button type="button" id="saveScheduleBtn" class="btn success">✓ Save Schedule</button>
          </div>
          <div id="scheduleHelp" class="help" style="margin-top:10px">Example: ON · 5:30 AM → 6:00 AM. Save the URL list before the scheduled start.</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title"><div class="icon">↗</div><div><h2>URLs to Record</h2><p>Paste one URL per line. Start uses exactly the URLs shown here.</p></div></div>
          <span id="urlCount" class="pill">0 URLs in panel</span>
        </div>
        <div class="card-body">
          <div class="field wide">
            <textarea id="urls" placeholder="https://example.com/video1&#10;https://example.com/video2"></textarea>
          </div>
          <div class="url-tools">
            <input id="newUrl" class="input" type="url" placeholder="https://example.com/video-page">
            <button type="button" id="addUrlBtn" class="btn">+ Add URL & Save</button>
          </div>
          <div class="toolbar" style="margin-top:10px">
            <button type="button" id="saveUrlsBtn" class="btn">Save URL List</button>
            <button type="button" id="loadUrlsBtn" class="btn">Load urls.txt</button>
            <button type="button" id="clearPanelBtn" class="btn danger">Clear Panel</button>
            <button type="button" id="clearSavedBtn" class="btn danger">Clear Saved List</button>
          </div>
          <div class="help" style="margin-top:12px"><b>Working list:</b> Start uses the URLs shown above. Save URL List updates <b>urls.txt</b> for scheduled recording.</div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title"><div class="icon">◉</div><div><h2>Live Screen Preview</h2><p id="liveText">No active recording.</p></div></div>
          <div class="pillrow"><span id="selectedQuality" class="pill">Selected: ${settings.quality} · ${settings.width}×${settings.height}</span><span id="activeQuality" class="pill active">Active: none</span></div>
        </div>
        <div class="card-body">
          <div class="preview" id="livePreviewFrame"><div class="preview-badge">LIVE PREVIEW</div><div id="liveEmpty" class="empty"><div class="empty-icon">◉</div><b>Nothing is recording</b><span>Start a recording to see and optionally control the hosted Chrome page.</span></div><img id="livePreview" alt="Live webpage preview" style="display:none"></div>
          <div class="preview-controls preview-controls-card">
            <div><div class="control-title">Remote page control</div><div class="help">View the hosted Chrome page in the preview. Touch, click and scroll are disabled by default for safety.</div></div>
            <label class="switch control-switch"><input id="previewInteractionToggle" type="checkbox"><span class="slider" aria-hidden="true"></span><span class="switch-text">Touch / Click <b id="previewInteractionLabel">OFF</b></span></label>
          </div>
        </div>
      </section>
    </div>

    <aside class="stack">
      <section class="card">
        <div class="card-head">
          <div class="card-title"><div class="icon">☁</div><div><h2>B2 Recordings</h2><p>Private WebM recordings stored in Backblaze B2.</p></div></div>
          <div class="toolbar">
            <button type="button" id="selectAllBtn" class="btn">Select All</button>
            <button type="button" id="deleteSelectedBtn" class="btn danger">Delete Selected</button>
          </div>
        </div>
        <div class="card-body">
          <div id="filesNotice" class="notice">Loading recordings…</div>
          <div id="files" class="files" style="margin-top:12px"></div>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <div class="card-title"><div class="icon">!</div><div><h2>Panel Message</h2><p>Latest action, error, or upload status.</p></div></div>
          <button type="button" id="clearMessageBtn" class="btn">Clear</button>
        </div>
        <div class="card-body">
          <div id="message" class="notice">Ready.</div>
          <div class="small muted" style="margin-top:10px">Diagnostics: <a href="/health" target="_blank" rel="noreferrer">/health</a> · <a href="/api/debug" target="_blank" rel="noreferrer">/api/debug</a></div>
        </div>
      </section>
    </aside>
  </div>
</main>
<script defer src="/app.js?v=20.23.0"></script>
</body></html>`);
});

const server = http.createServer(app);
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pella Render Recorder ${APP_VERSION} listening on 0.0.0.0:${PORT}`);
  console.log(`SERVER_PORT=${process.env.SERVER_PORT || '(not set)'}`);
  console.log(`PORT=${process.env.PORT || '(not set)'}`);
  console.log(`Selected listen port=${PORT}`);
  console.log(`B2 configured: ${b2Configured}`);
  console.log(`B2 endpoint: ${B2_ENDPOINT || '(not set)'}`);
  console.log(`B2 bucket: ${B2_BUCKET || '(not set)'}`);
  console.log(`B2 region: ${B2_REGION}`);
  console.log(`URLS_FILE=${URLS_FILE}`);
  console.log(`Settings: ${settings.quality} ${settings.width}x${settings.height}, ${settings.recordSeconds}s, warmup ${settings.warmupMs}ms`);
  if (b2EndpointError) console.log(b2EndpointError);
  if (AUTO_START) {
    const urls = (() => { try { return readUrls(); } catch { return []; } })();
    if (urls.length) {
      runPromise = runRecorder(urls, 'auto', settings).catch(err => { lastError = err.message; console.error(`Auto-start error: ${err.message}`); }).finally(() => { runPromise = null; });
    }
  }
  scheduleTick().catch(err => { lastError = `Schedule error: ${err.message}`; console.error(lastError); });
  scheduleTimer = setInterval(() => { scheduleTick().catch(err => { lastError = `Schedule error: ${err.message}`; console.error(lastError); }); }, 5000);
});

async function shutdown(){
  if (scheduleTimer) clearInterval(scheduleTimer);
  shutdownRequested=true;
  if (activeRunControl) activeRunControl.stopRequested = true;
  try { if (runPromise) await runPromise; } catch (_) {}
  try { if (browser) await browser.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
