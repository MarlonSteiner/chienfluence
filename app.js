import { db } from './db.js';
import { joinMp4 } from './mp4join.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const DEMO = new URLSearchParams(location.search).has('demo'); // fake camera, for testing without one

// ================= settings =================

const STEPS = {
  clip: [3, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120, 180, 300],
  brk: [5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 420, 600],
  count: Array.from({ length: 60 }, (_, i) => i + 1),
};
const PRESETS = [
  { name: '🩰 Pilates class', clip: 20, brk: 120, count: 20 },
  { name: '💪 Workout', clip: 15, brk: 60, count: 20 },
  { name: '💄 Get ready', clip: 30, brk: 60, count: 10 },
  { name: '✨ Quick story', clip: 10, brk: 20, count: 6 },
];
const DEFAULTS = { clip: 20, brk: 120, count: 20, facing: 'environment', delay: 10, sound: true, chime: false };

const store = {
  get(k, d) { try { const v = localStorage.getItem('cf.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cf.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const cfg = { ...DEFAULTS, ...store.get('settings', {}) };
const saveCfg = () => store.set('settings', cfg);

// ================= formatting =================

function fmtLen(s) {
  if (s < 60) return `${s}s`;
  const m = s / 60;
  return Number.isInteger(m) ? `${m} min` : `${Math.floor(m)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtLong(s) {
  s = Math.round(s);
  if (s < 60) return `${s} sec`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.round(s / 60)} min`;
}
function fmtClock(s, round = Math.ceil) { // countdowns round up; clip lengths pass Math.round
  s = Math.max(0, round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtDate(t) {
  return new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function show(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  window.scrollTo(0, 0);
}

// ================= home / setup =================

function renderSetup() {
  for (const st of $$('.stepper')) {
    const k = st.dataset.key;
    const list = STEPS[k];
    const i = list.indexOf(cfg[k]);
    $('.s-value', st).textContent = k === 'count' ? cfg[k] : fmtLen(cfg[k]);
    $('[data-dir="-1"]', st).disabled = i <= 0;
    $('[data-dir="1"]', st).disabled = i >= list.length - 1;
  }
  for (const c of $$('.chip')) {
    const p = PRESETS[c.dataset.i];
    c.setAttribute('aria-checked', p.clip === cfg.clip && p.brk === cfg.brk && p.count === cfg.count);
  }
  const total = cfg.count * cfg.clip + (cfg.count - 1) * cfg.brk;
  const footage = cfg.count * cfg.clip;
  $('#summary').innerHTML = cfg.count === 1
    ? `One <b>${fmtLen(cfg.clip)}</b> clip.`
    : `Films <b>${cfg.count} clips</b> of ${fmtLen(cfg.clip)} over about <b>${fmtLong(total)}</b>.<br>That's ${fmtLong(footage)} of footage to pick from.`;
  for (const [id, key] of [['#opt-facing', 'facing'], ['#opt-delay', 'delay']]) {
    for (const b of $$('button', $(id))) b.setAttribute('aria-checked', String(cfg[key]) === b.dataset.v);
  }
  $('#opt-sound').checked = cfg.sound;
  $('#opt-chime').checked = cfg.chime;
}

function setupHome() {
  $('#presets').innerHTML = PRESETS.map((p, i) => `<button class="chip" role="radio" data-i="${i}">${p.name}</button>`).join('');
  $('#presets').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    const p = PRESETS[c.dataset.i];
    Object.assign(cfg, { clip: p.clip, brk: p.brk, count: p.count });
    saveCfg(); renderSetup();
  });
  for (const st of $$('.stepper')) {
    st.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dir]');
      if (!b) return;
      const k = st.dataset.key, list = STEPS[k];
      let i = list.indexOf(cfg[k]);
      if (i < 0) i = list.findIndex((v) => v >= cfg[k]);
      i = Math.min(list.length - 1, Math.max(0, i + Number(b.dataset.dir)));
      cfg[k] = list[i];
      saveCfg(); renderSetup();
    });
  }
  for (const [id, key, num] of [['#opt-facing', 'facing', false], ['#opt-delay', 'delay', true]]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      cfg[key] = num ? Number(b.dataset.v) : b.dataset.v;
      saveCfg(); renderSetup();
    });
  }
  $('#opt-sound').addEventListener('change', (e) => { cfg.sound = e.target.checked; saveCfg(); });
  $('#opt-chime').addEventListener('change', (e) => { cfg.chime = e.target.checked; saveCfg(); });
  $('#start').addEventListener('click', startSession);

  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (ios && !standalone && !store.get('hideInstall', false)) $('#install-tip').hidden = false;
  $('#install-tip .x').addEventListener('click', () => { $('#install-tip').hidden = true; store.set('hideInstall', true); });

  renderSetup();
}

const urls = new Map(); // blob -> object URL, so thumbnails aren't recreated
function urlFor(blob) {
  if (!blob) return '';
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
}

async function renderSessions() {
  let sessions = [];
  try { sessions = (await db.allSessions()).filter((s) => s.clipCount > 0).sort((a, b) => b.createdAt - a.createdAt); } catch { /* no storage */ }
  $('#past').hidden = !sessions.length;
  $('#sessions').innerHTML = sessions.map((s) => `
    <li><button class="session" data-id="${s.id}">
      ${s.cover ? `<img src="${urlFor(s.cover)}" alt="">` : '<span class="ph"></span>'}
      <span><b>${fmtDate(s.createdAt)}</b><small>${s.clipCount} clip${s.clipCount === 1 ? '' : 's'} · ${fmtClock(s.totalSec || 0, Math.round)}</small></span>
      <span class="chev">›</span>
    </button></li>`).join('');
}
$('#sessions').addEventListener('click', (e) => {
  const b = e.target.closest('.session');
  if (b) openReview(b.dataset.id);
});

// ================= camera =================

let stream = null;
let demoAudio = null;

async function openCamera() {
  closeCamera();
  if (DEMO) { stream = fakeCamera(); }
  else {
    const video = { facingMode: cfg.facing, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: cfg.sound });
  }
  const cam = $('#cam');
  cam.srcObject = stream;
  cam.classList.toggle('mirror', cfg.facing === 'user' && !DEMO);
  cam.play().catch(() => {}); // don't wait: the promise can hang until the page is visible
  return stream;
}

function closeCamera() {
  if (stream) for (const t of stream.getTracks()) t.stop();
  stream = null;
  $('#cam').srcObject = null;
}

// A pretend camera (pastel canvas + a tone) for testing in the simulator or on a desktop.
function fakeCamera() {
  const c = document.createElement('canvas');
  c.width = 720; c.height = 1280;
  const g = c.getContext('2d');
  const t0 = performance.now();
  const iv = setInterval(function draw() { // a timer, not rAF, so it also draws in a background tab
    if (!stream) return clearInterval(iv);
    const t = (performance.now() - t0) / 1000;
    const grd = g.createLinearGradient(0, 0, 720, 1280);
    grd.addColorStop(0, `hsl(${340 + 15 * Math.sin(t / 2)} 80% 88%)`);
    grd.addColorStop(1, '#fff3ec');
    g.fillStyle = grd; g.fillRect(0, 0, 720, 1280);
    g.fillStyle = '#e8879e';
    g.beginPath(); g.arc(360 + 220 * Math.sin(t * 1.3), 640 + 300 * Math.cos(t * 0.9), 90, 0, 7); g.fill();
    g.fillStyle = '#4a3034'; g.font = '600 72px system-ui'; g.textAlign = 'center';
    g.fillText(new Date().toLocaleTimeString(), 360, 200);
  }, 33);
  const s = c.captureStream(30);
  if (cfg.sound) {
    demoAudio = demoAudio || new AudioContext();
    const osc = demoAudio.createOscillator();
    const dest = demoAudio.createMediaStreamDestination();
    const gain = demoAudio.createGain(); gain.gain.value = 0.05;
    osc.frequency.value = 440; osc.connect(gain).connect(dest); osc.start();
    for (const tr of dest.stream.getAudioTracks()) s.addTrack(tr);
  }
  return s;
}

function pickMime() {
  if (!window.MediaRecorder) return null;
  const options = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
  return options.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
}

function grabThumb() {
  const v = $('#cam');
  if (!v.videoWidth) return Promise.resolve(null);
  const scale = 420 / Math.max(v.videoWidth, v.videoHeight);
  const c = document.createElement('canvas');
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
}

// ================= keep the screen on =================

let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      return true;
    }
  } catch { /* not allowed right now */ }
  return false;
}
function releaseAwake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

// ================= chime =================

let audioCtx = null;
function chime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [[880, 0], [1318.5, 0.16]].forEach(([f, d]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, now + d);
    g.gain.linearRampToValueAtTime(0.18, now + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + d + 0.6);
    o.connect(g).connect(audioCtx.destination);
    o.start(now + d); o.stop(now + d + 0.65);
  });
}

// ================= the session =================

let S = null; // the running session

async function startSession() {
  const mime = pickMime();
  if (mime === null) return sheetMessage('😿', 'Recording isn\'t supported here', 'Open Chienfluence in Safari on your iPhone.');
  if (cfg.chime && !audioCtx) { try { audioCtx = new AudioContext(); audioCtx.resume(); } catch { /* fine without */ } }

  $('#start').disabled = true;
  try {
    await openCamera();
  } catch (e) {
    $('#start').disabled = false;
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    return sheetMessage('📷', denied ? 'Chienfluence needs your camera' : 'Couldn\'t open the camera',
      denied ? 'Allow camera' + (cfg.sound ? ' and microphone' : '') + ' access when asked. If you said no before, go to Settings › Safari › Camera.' : String(e?.message || e));
  }
  $('#start').disabled = false;
  navigator.storage?.persist?.().catch(() => {});

  const plan = { clip: cfg.clip, brk: cfg.brk, count: cfg.count, facing: cfg.facing, sound: cfg.sound };
  S = {
    id: 's' + Date.now().toString(36),
    plan, mime,
    done: 0, // clips finished
    phase: null, phaseStart: 0, phaseEnd: 0,
    rec: null, saves: [],
    chimed: false,
  };
  await db.putSession({ id: S.id, createdAt: Date.now(), plan, clipCount: 0, totalSec: 0, cover: null }).catch(() => {});

  show('shoot');
  const awake = await keepAwake();
  $('#awake-tip').hidden = awake || DEMO;
  setTimeout(() => { $('#awake-tip').hidden = true; }, 12000);
  setPhase('countdown', cfg.delay);
  S.timer = setInterval(tick, 100);
  tick();
}

function setPhase(phase, seconds) {
  S.phase = phase;
  S.phaseStart = Date.now();
  S.phaseEnd = S.phaseStart + seconds * 1000;
  S.chimed = false;
  const shoot = $('#shoot');
  shoot.classList.toggle('is-rec', phase === 'rec');
  shoot.classList.toggle('is-break', phase === 'break');
  shoot.classList.toggle('is-countdown', phase === 'countdown');
  $('#pill-rec').hidden = phase !== 'rec';
  $('#skip').hidden = phase === 'rec';
  $('#skip').textContent = phase === 'countdown' ? 'Start now' : 'Film now';
  $('#flip').hidden = phase === 'rec';
}

function tick() {
  if (!S) return;
  const now = Date.now();
  const left = (S.phaseEnd - now) / 1000;
  const total = (S.phaseEnd - S.phaseStart) / 1000;
  const n = S.plan.count;

  $('#pill-count').textContent = S.phase === 'rec' ? `Clip ${S.done + 1} of ${n}` : `${S.done} of ${n} filmed`;

  if (S.phase === 'rec') {
    $('#rec-time').textContent = fmtClock(left);
    if (left <= 0) endClip();
    return;
  }

  // countdown or break
  const frac = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0;
  $('#ring-fg').style.strokeDashoffset = String(339.3 * (1 - frac));
  if (left <= 3.05) {
    $('#big').textContent = Math.max(1, Math.ceil(left));
    $('#small').textContent = '';
    $('#status').textContent = 'Filming in…';
  } else {
    $('#big').textContent = fmtClock(left);
    $('#small').textContent = S.phase === 'break' ? 'until next clip' : 'until we start';
    $('#status').textContent = S.phase === 'break' ? 'Break time 🌸' : 'Get in position ♡';
  }
  if (cfg.chime && !S.chimed && left <= 1.6) { S.chimed = true; chime(); }
  if (left <= 0) startClip();
}

function startClip() {
  if (!S || S.phase === 'rec' || S.opening) return;
  if (!stream || !stream.active) { reopenCamera(); return; }
  const opts = { videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 };
  if (S.mime) opts.mimeType = S.mime;
  let rec;
  try { rec = new MediaRecorder(stream, opts); }
  catch { rec = new MediaRecorder(stream); }

  const clip = { index: S.done, chunks: [], startedAt: 0, thumb: null };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) clip.chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.onerror = () => toast('Recording hiccup, carrying on');
  clip.stopped = stopped;
  rec.start();
  clip.startedAt = Date.now();
  S.rec = { rec, clip };
  setPhase('rec', S.plan.clip);
  setTimeout(async () => { if (S?.rec?.clip === clip) clip.thumb = await grabThumb(); }, Math.min(1200, S.plan.clip * 500));
}

function endClip() {
  if (!S?.rec) return;
  const { rec, clip } = S.rec;
  S.rec = null;
  clip.endedAt = Date.now();
  try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
  S.saves.push(saveClip(S.id, rec, clip));
  S.done++;
  if (S.done >= S.plan.count) finishSession();
  else setPhase('break', S.plan.brk);
}

async function saveClip(sessionId, rec, clip) {
  await clip.stopped;
  if (!clip.chunks.length) return;
  const type = (rec.mimeType || S?.mime || 'video/mp4').split(';')[0];
  const blob = new Blob(clip.chunks, { type });
  const thumb = clip.thumb || null;
  const duration = (clip.endedAt - clip.startedAt) / 1000;
  const item = { id: `${sessionId}-${String(clip.index).padStart(3, '0')}`, sessionId, index: clip.index, blob, thumb, duration, type, createdAt: clip.startedAt };
  try {
    await db.putClip(item);
    const s = await db.getSession(sessionId);
    if (s) {
      s.clipCount = (s.clipCount || 0) + 1;
      s.totalSec = (s.totalSec || 0) + duration;
      if (!s.cover && thumb) s.cover = thumb;
      await db.putSession(s);
    }
  } catch (e) {
    toast('Phone storage is full 😿');
  }
}

async function finishSession() {
  if (!S) return;
  const s = S;
  clearInterval(s.timer);
  if (s.rec) {
    const { rec, clip } = s.rec;
    s.rec = null;
    clip.endedAt = Date.now();
    try { rec.stop(); } catch { /* */ }
    if (Date.now() - clip.startedAt > 800) s.saves.push(saveClip(s.id, rec, clip));
  }
  $('#status').textContent = 'Saving your clips…';
  $('#big').textContent = '♡';
  $('#small').textContent = '';
  $('#shoot').classList.remove('is-rec');
  $('#shoot').classList.add('is-break');
  await Promise.all(s.saves);
  S = null;
  closeCamera();
  releaseAwake();
  openReview(s.id);
}

async function reopenCamera() {
  if (!S || S.opening) return;
  S.opening = true;
  try { await openCamera(); } catch { toast('Couldn\'t reopen the camera'); }
  if (S) S.opening = false;
}

$('#stop').addEventListener('click', () => {
  if (!S) return;
  if (S.done === 0 && S.phase !== 'rec') {
    clearInterval(S.timer);
    db.deleteSession(S.id).catch(() => {});
    S = null; closeCamera(); releaseAwake();
    show('home'); renderSessions();
    return;
  }
  finishSession();
});
$('#skip').addEventListener('click', () => { if (S && S.phase !== 'rec') { S.phaseEnd = Date.now(); tick(); } });
$('#flip').addEventListener('click', async () => {
  if (S?.phase === 'rec') return;
  cfg.facing = cfg.facing === 'user' ? 'environment' : 'user';
  saveCfg(); renderSetup();
  if (S) { S.opening = true; try { await openCamera(); } catch { toast('Couldn\'t switch camera'); } if (S) S.opening = false; }
});

// iOS pauses the camera when the app goes to the background. Save what we have, pick up again on return.
document.addEventListener('visibilitychange', async () => {
  if (!S) return;
  if (document.visibilityState === 'hidden') {
    if (S.phase === 'rec') endClip();
  } else {
    await keepAwake();
    if (!stream || !stream.active || stream.getVideoTracks().some((t) => t.readyState === 'ended')) reopenCamera();
  }
});

// ================= review =================

let R = null; // { session, clips, selected:Set }

async function openReview(sessionId) {
  const [session, clips] = await Promise.all([db.getSession(sessionId), db.clipsFor(sessionId)]);
  if (!clips.length) {
    if (session) db.deleteSession(sessionId).catch(() => {});
    toast('No clips were saved');
    show('home'); renderSessions();
    return;
  }
  R = { session, clips, selected: new Set() };
  show('review');
  renderReview();
}

function clipName(c, i) {
  const d = new Date(c.createdAt);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ext = (c.type || '').includes('webm') ? 'webm' : 'mp4';
  return `chienfluence-${day}-clip${String(i + 1).padStart(2, '0')}.${ext}`;
}

function renderReview() {
  const { clips, selected } = R;
  const total = clips.reduce((a, c) => a + (c.duration || 0), 0);
  $('#review-sub').textContent = `${clips.length} clip${clips.length === 1 ? '' : 's'} · ${fmtClock(total, Math.round)} · ${fmtDate(R.session?.createdAt || clips[0].createdAt)}`;
  $('#select-all').textContent = selected.size === clips.length ? 'Clear' : 'Select all';
  $('#grid').innerHTML = clips.map((c, i) => `
    <li class="tile${selected.has(c.id) ? ' on' : ''}" data-id="${c.id}">
      <button class="open" aria-label="Watch clip ${i + 1}">
        ${c.thumb ? `<img src="${urlFor(c.thumb)}" alt="">` : ''}
        <span class="play"><svg viewBox="0 0 24 24"><use href="#i-play"/></svg></span>
      </button>
      <span class="num">#${i + 1}</span>
      <span class="dur">${fmtClock(c.duration || 0, Math.round)}</span>
      <button class="pick" role="checkbox" aria-checked="${selected.has(c.id)}" aria-label="Pick clip ${i + 1}"><span>${selected.has(c.id) ? '♥' : '♡'}</span></button>
    </li>`).join('');

  const n = selected.size;
  $('#actions').innerHTML = n
    ? `<button class="btn soft danger icon-only" data-act="delete" aria-label="Delete ${n} clips"><svg viewBox="0 0 24 24"><use href="#i-trash"/></svg></button>
       ${n === 1
    ? '<button class="btn primary" data-act="save">Save this clip</button>'
    : `<button class="btn ghost-btn" data-act="save">Save ${n}</button>
       <button class="btn primary" data-act="join">Join ${n} ✨</button>`}`
    : `<button class="btn ghost-btn" data-act="save">Save all</button>
       <button class="btn primary" data-act="join">Join all ✨</button>`;
}

function pickedClips() {
  return R.selected.size ? R.clips.filter((c) => R.selected.has(c.id)) : R.clips;
}

$('#grid').addEventListener('click', (e) => {
  const tile = e.target.closest('.tile');
  if (!tile) return;
  const id = tile.dataset.id;
  if (e.target.closest('.pick')) {
    R.selected.has(id) ? R.selected.delete(id) : R.selected.add(id);
    renderReview();
  } else openPlayer(id);
});
$('#select-all').addEventListener('click', () => {
  if (R.selected.size === R.clips.length) R.selected.clear();
  else R.clips.forEach((c) => R.selected.add(c.id));
  renderReview();
});
$('#back').addEventListener('click', () => { R = null; show('home'); renderSessions(); });
$('#actions').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'save') saveClips(pickedClips());
  if (act === 'join') joinClips(pickedClips());
  if (act === 'delete') confirmDelete(pickedClips());
});

// ---------- saving ----------

async function shareFiles(files) {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      // fall through to downloading
    }
  }
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f);
    a.download = f.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  }
  return true;
}

async function saveClips(clips) {
  const files = clips.map((c) => new File([c.blob], clipName(c, R.clips.indexOf(c)), { type: c.blob.type || 'video/mp4' }));
  if (await shareFiles(files)) toast(files.length === 1 ? 'Saved ♡' : `${files.length} clips ready ♡`);
}

// ---------- joining ----------

async function joinClips(clips) {
  if (clips.length === 1) return saveClips(clips);
  if (clips.some((c) => !(c.type || c.blob.type).includes('mp4'))) {
    return sheetMessage('🎞', 'Can\'t join these clips', 'Joining needs MP4 clips, which is what iPhones record. You can still save them one by one.');
  }
  openSheet(`<div class="spinner"></div><h3>Stitching your clips…</h3><p>Joining ${clips.length} clips into one video.</p>`);
  let blob;
  try {
    const t0 = performance.now();
    blob = await joinMp4(clips.map((c) => c.blob));
    const wait = 700 - (performance.now() - t0); // let the cute spinner be seen
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  } catch (e) {
    console.error(e);
    return sheetMessage('😿', 'Joining didn\'t work', 'Something in these clips confused me. You can still save them one by one. (' + (e.message || e) + ')');
  }
  const d = new Date(clips[0].createdAt);
  const name = `chienfluence-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${clips.length}clips.mp4`;
  const file = new File([blob], name, { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  openSheet(`
    <h3>Your video is ready 💕</h3>
    <video src="${url}" playsinline controls></video>
    <p>${clips.length} clips · ${fmtClock(clips.reduce((a, c) => a + (c.duration || 0), 0), Math.round)}. Tap Save, then <b>Save Video</b>.</p>
    <div class="row">
      <button class="btn ghost-btn" data-sheet="close">Close</button>
      <button class="btn primary" data-sheet="save">Save video</button>
    </div>`, {
    save: async () => { if (await shareFiles([file])) toast('Saved ♡'); },
    onClose: () => URL.revokeObjectURL(url),
  });
}

// ---------- deleting ----------

function confirmDelete(clips) {
  const n = clips.length;
  openSheet(`
    <div class="emoji">🗑</div>
    <h3>Delete ${n === 1 ? 'this clip' : `${n} clips`}?</h3>
    <p>${n === R.clips.length ? 'That\'s all of them. ' : ''}${n === 1 ? 'It\'ll' : 'They\'ll'} be gone for good, so save the ones you love first.</p>
    <div class="row">
      <button class="btn ghost-btn" data-sheet="close">Keep</button>
      <button class="btn primary" data-sheet="del">Delete</button>
    </div>`, {
    del: async () => {
      closeSheet();
      $('#player').open && $('#player').close();
      await deleteClips(clips);
    },
  });
}

async function deleteClips(clips) {
  const ids = new Set(clips.map((c) => c.id));
  await Promise.all(clips.map((c) => db.deleteClip(c.id).catch(() => {})));
  R.clips = R.clips.filter((c) => !ids.has(c.id));
  for (const id of ids) R.selected.delete(id);
  const s = R.session;
  if (!R.clips.length) {
    await db.deleteSession(s.id).catch(() => {});
    toast('All clips deleted');
    R = null; show('home'); renderSessions();
    return;
  }
  if (s) {
    s.clipCount = R.clips.length;
    s.totalSec = R.clips.reduce((a, c) => a + (c.duration || 0), 0);
    s.cover = R.clips.find((c) => c.thumb)?.thumb || null;
    await db.putSession(s).catch(() => {});
  }
  toast(clips.length === 1 ? 'Clip deleted' : `${clips.length} clips deleted`);
  renderReview();
}

// ---------- player ----------

let playing = null;
function openPlayer(id) {
  const c = R.clips.find((x) => x.id === id);
  if (!c) return;
  playing = c;
  const v = $('#player-video');
  v.src = URL.createObjectURL(c.blob);
  renderPlayerPick();
  $('#player').showModal();
  v.play().catch(() => {});
}
function renderPlayerPick() {
  const on = R.selected.has(playing.id);
  $('#p-pick').classList.toggle('on', on);
  $('#p-pick').innerHTML = `<span class="h">${on ? '♥' : '♡'}</span> ${on ? 'Picked' : 'Pick'}`;
}
$('#player').addEventListener('close', () => {
  const v = $('#player-video');
  v.pause();
  if (v.src) URL.revokeObjectURL(v.src);
  v.removeAttribute('src'); v.load();
  playing = null;
});
$('#p-close').addEventListener('click', () => $('#player').close());
$('#player').addEventListener('click', (e) => { if (e.target === $('#player')) $('#player').close(); });
$('#p-pick').addEventListener('click', () => {
  R.selected.has(playing.id) ? R.selected.delete(playing.id) : R.selected.add(playing.id);
  renderPlayerPick(); renderReview();
});
$('#p-save').addEventListener('click', () => saveClips([playing]));
$('#p-del').addEventListener('click', () => confirmDelete([playing]));

// ---------- sheet ----------

let sheetHandlers = {};
function openSheet(html, handlers = {}) {
  if (sheetHandlers.onClose && $('#sheet').open) sheetHandlers.onClose();
  sheetHandlers = handlers;
  $('#sheet-box').innerHTML = html;
  if (!$('#sheet').open) $('#sheet').showModal();
}
function closeSheet() { if ($('#sheet').open) $('#sheet').close(); }
function sheetMessage(emoji, title, text) {
  openSheet(`<div class="emoji">${emoji}</div><h3>${title}</h3><p>${text}</p>
    <div class="row"><button class="btn primary" data-sheet="close">Okay</button></div>`);
}
$('#sheet').addEventListener('close', () => { sheetHandlers.onClose?.(); sheetHandlers = {}; });
$('#sheet').addEventListener('click', (e) => {
  if (e.target === $('#sheet')) return closeSheet();
  const k = e.target.closest('[data-sheet]')?.dataset.sheet;
  if (!k) return;
  if (k === 'close') closeSheet();
  else sheetHandlers[k]?.();
});

// ================= start =================

setupHome();
renderSessions();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

window.chienfluence = { joinMp4, db }; // handy for testing in the console
