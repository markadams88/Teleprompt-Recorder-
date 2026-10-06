/* Teleprompter — plain JavaScript, no build step. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  const $ = (id) => document.getElementById(id);

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full or blocked */ }
    }
  };

  const KEYS = {
    script: 'tp.script',
    size: 'tp.fontSize',
    speed: 'tp.speed',
    countdown: 'tp.countdown'
  };

  const READING_POS = 1 / 3;    // reading line, fraction of screen height
  const LINE_HEIGHT = 1.3;      // must match .script-text line-height
  const HIDE_DELAY = 3000;      // controls auto-hide (ms)

  let toastTimer = 0;
  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms || 3500);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  function formatDuration(ms) {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m ? `${m} min ${s} s` : `${s} s`;
  }

  // ---------------------------------------------------------------- elements

  const screens = {
    script: $('screen-script'),
    record: $('screen-record'),
    preview: $('screen-preview')
  };

  const scriptInput = $('script-input');
  const saveStatus = $('save-status');
  const wordCount = $('word-count');

  const stage = $('stage');
  const video = $('camera');
  const band = $('band');
  const textEl = $('script-text');
  const readingLine = $('reading-line');
  const controls = $('controls');
  const topbar = $('topbar');
  const sizeSlider = $('size-slider');
  const speedSlider = $('speed-slider');
  const playBtn = $('play-btn');
  const recordBtn = $('record-btn');
  const flipBtn = $('flip-btn');
  const mirrorBtn = $('mirror-btn');
  const resetBtn = $('reset-btn');
  const backBtn = $('back-btn');
  const countdownBtn = $('countdown-btn');
  const recIndicator = $('rec-indicator');
  const recTime = $('rec-time');
  const captureInfo = $('capture-info');
  const countdownEl = $('countdown');
  const countdownNum = $('countdown-num');
  const cameraMsg = $('camera-msg');

  const clipVideo = $('clip');
  const clipInfo = $('clip-info');
  const saveBtn = $('save-btn');
  const downloadLink = $('download-link');
  const shareStatus = $('share-status');

  // ---------------------------------------------------------------- state

  const state = {
    screen: 'script',
    // camera
    stream: null,
    facing: 'user',
    mirror: true,
    cameraReq: 0,
    // scrolling
    playing: false,
    dragging: false,
    offset: 0,
    lastTs: 0,
    raf: 0,
    readingY: 0,
    textHeight: 0,
    fontSize: store.get(KEYS.size, 44),
    speedLevel: store.get(KEYS.speed, 45),
    countdown: store.get(KEYS.countdown, true),
    // recording
    recorder: null,
    chunks: [],
    mimeType: '',
    recording: false,
    recStartedAt: 0,
    recStartDate: null,
    recElapsed: 0,
    recTimer: 0,
    countdownTimer: 0,
    countingDown: false,
    // preview
    clipUrl: '',
    clipFile: null,
    saved: false,
    // misc
    wakeLock: null,
    hideTimer: 0
  };

  function showScreen(name) {
    state.screen = name;
    Object.keys(screens).forEach((key) => { screens[key].hidden = key !== name; });
  }

  // ================================================================ 1. SCRIPT SCREEN

  let saveTimer = 0;

  function updateWordCount() {
    const words = (scriptInput.value.match(/\S+/g) || []).length;
    if (!words) { wordCount.textContent = ''; return; }
    const ms = (words / 140) * 60000; // a typical speaking pace
    wordCount.textContent = `${words.toLocaleString('en-GB')} word${words === 1 ? '' : 's'} · about ${formatDuration(ms)} to read aloud`;
  }

  function saveScript() {
    clearTimeout(saveTimer);
    store.set(KEYS.script, scriptInput.value);
    saveStatus.textContent = 'Saved';
  }

  scriptInput.value = store.get(KEYS.script, '');
  updateWordCount();
  if (scriptInput.value) saveStatus.textContent = 'Saved';

  scriptInput.addEventListener('input', () => {
    saveStatus.textContent = 'Saving…';
    updateWordCount();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveScript, 400);
  });

  $('clear-btn').addEventListener('click', () => {
    if (!scriptInput.value) return;
    if (!confirm('Clear the whole script? This can’t be undone.')) return;
    scriptInput.value = '';
    saveScript();
    updateWordCount();
  });

  // IMPORTANT (iOS): the camera is requested synchronously inside this tap handler,
  // so Safari treats it as user-initiated on first use.
  $('start-btn').addEventListener('click', () => {
    saveScript();
    scriptInput.blur();
    enterRecording();
  });

  window.addEventListener('pagehide', () => { if (state.screen === 'script') saveScript(); });

  // ================================================================ 2. RECORDING SCREEN

  function enterRecording() {
    const text = scriptInput.value.trim() ? scriptInput.value : '';
    textEl.textContent = text || 'Your script is empty. Go back and paste or type it on the Script screen.';
    textEl.classList.toggle('is-empty', !text);

    showScreen('record');
    applyFontSize();
    applySpeedLabel();
    updateCountdownBtn();
    setPlaying(false);
    state.offset = 0;
    layout();
    showControls();
    requestWakeLock();
    startCamera();
  }

  function exitRecording() {
    if (state.recording) return;
    cancelCountdown();
    setPlaying(false);
    stopStream();
    releaseWakeLock();
    hideCameraMessage();
    showScreen('script');
  }

  backBtn.addEventListener('click', exitRecording);

  // ---------------------------------------------------------------- scrolling

  function speedPx() {
    // Exponential: fine steps at the slow end. Level 1 ≈ 4 px/s, level 100 ≈ 300 px/s.
    return 4 * Math.pow(75, (state.speedLevel - 1) / 99);
  }

  function maxOffset() { return Math.max(0, state.textHeight - state.fontSize * LINE_HEIGHT); }

  function applyOffset() {
    // Centre of the current line sits on the reading line.
    const y = state.readingY - state.offset - (state.fontSize * LINE_HEIGHT) / 2;
    textEl.style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`;
  }

  function layout() {
    state.readingY = stage.clientHeight * READING_POS - band.offsetTop;
    readingLine.style.top = `${state.readingY}px`;
    state.textHeight = textEl.offsetHeight;
    applyOffset();
  }

  function tick(ts) {
    state.raf = 0;
    if (!state.playing) return;
    const dt = state.lastTs ? Math.min((ts - state.lastTs) / 1000, 0.1) : 0;
    state.lastTs = ts;
    if (!state.dragging) {
      state.offset += speedPx() * dt;
      const max = maxOffset();
      if (state.offset >= max) {
        state.offset = max;
        applyOffset();
        setPlaying(false);
        return;
      }
      applyOffset();
    }
    state.raf = requestAnimationFrame(tick);
  }

  function setPlaying(on) {
    if (on && state.offset >= maxOffset() && maxOffset() > 0) state.offset = 0; // finished: start again
    state.playing = on;
    playBtn.classList.toggle('is-playing', on);
    playBtn.setAttribute('aria-label', on ? 'Pause scroll' : 'Play scroll');
    $('play-label').textContent = on ? 'Pause' : 'Play';
    if (on && !state.raf) {
      state.lastTs = 0;
      state.raf = requestAnimationFrame(tick);
    } else if (!on && state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
    if (!on) applyOffset();
  }

  function togglePlay() { setPlaying(!state.playing); }

  function resetScroll() {
    state.offset = 0;
    applyOffset();
  }

  // Keep position proportional when the text reflows (size change, rotation).
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => {
      const old = state.textHeight;
      const h = textEl.offsetHeight;
      if (old > 0 && h > 0 && h !== old) state.offset *= h / old;
      state.textHeight = h;
      applyOffset();
    }).observe(textEl);
    new ResizeObserver(() => layout()).observe(stage);
  } else {
    window.addEventListener('resize', layout);
  }
  window.addEventListener('orientationchange', () => setTimeout(layout, 300));

  // ---------------------------------------------------------------- sliders

  function applyFontSize() {
    sizeSlider.value = state.fontSize;
    $('size-value').textContent = state.fontSize;
    textEl.style.fontSize = `${state.fontSize}px`;
  }

  function applySpeedLabel() {
    speedSlider.value = state.speedLevel;
    $('speed-value').textContent = state.speedLevel;
  }

  sizeSlider.addEventListener('input', () => {
    state.fontSize = Number(sizeSlider.value);
    applyFontSize();
    store.set(KEYS.size, state.fontSize);
    showControls();
  });

  speedSlider.addEventListener('input', () => {
    state.speedLevel = Number(speedSlider.value);
    applySpeedLabel();
    store.set(KEYS.speed, state.speedLevel);
    showControls();
  });

  // ---------------------------------------------------------------- controls show / hide

  function showControls() {
    controls.classList.remove('is-hidden');
    topbar.classList.remove('is-hidden');
    clearTimeout(state.hideTimer);
    state.hideTimer = setTimeout(hideControls, HIDE_DELAY);
  }

  function hideControls() {
    controls.classList.add('is-hidden');
    topbar.classList.add('is-hidden');
  }

  // Any touch within the controls keeps them visible.
  [controls, topbar].forEach((el) => {
    el.addEventListener('pointerdown', showControls);
    el.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') showControls(); });
  });

  // Tap the screen to show controls; tap the text to pause/play; drag the text to scroll by hand.
  let drag = null;

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.chrome, .camera-msg')) return;
    drag = {
      id: e.pointerId,
      y: e.clientY,
      startOffset: state.offset,
      moved: false,
      onText: !!e.target.closest('#band')
    };
  });

  stage.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) > 10) {
      drag.moved = true;
      if (drag.onText) state.dragging = true;
    }
    if (drag.moved && drag.onText) {
      state.offset = Math.min(maxOffset(), Math.max(0, drag.startOffset - dy));
      applyOffset();
    }
  });

  function endDrag(e, cancelled) {
    if (!drag || e.pointerId !== drag.id) return;
    if (!cancelled && !drag.moved && drag.onText) togglePlay();
    if (!cancelled) showControls();
    state.dragging = false;
    state.lastTs = 0;
    drag = null;
  }
  stage.addEventListener('pointerup', (e) => endDrag(e, false));
  stage.addEventListener('pointercancel', (e) => endDrag(e, true));

  playBtn.addEventListener('click', togglePlay);
  resetBtn.addEventListener('click', resetScroll);

  // ---------------------------------------------------------------- countdown toggle

  function updateCountdownBtn() {
    countdownBtn.textContent = `3-2-1: ${state.countdown ? 'On' : 'Off'}`;
    countdownBtn.setAttribute('aria-pressed', String(state.countdown));
  }

  countdownBtn.addEventListener('click', () => {
    state.countdown = !state.countdown;
    store.set(KEYS.countdown, state.countdown);
    updateCountdownBtn();
  });

  // ================================================================ CAMERA

  const AUDIO_CONSTRAINTS = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    sampleRate: { ideal: 48000 }
  };

  function initialVideoConstraints(facing) {
    return facing === 'environment'
      ? { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }
      : { facingMode: { ideal: 'user' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  }

  function stopStream() {
    state.cameraReq++; // invalidates any camera request still in flight
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    video.srcObject = null;
  }

  // Note: getUserMedia is called before the first `await`, so when this runs
  // from a tap handler it is still inside the user gesture.
  async function openCamera(facing) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: initialVideoConstraints(facing),
        audio: AUDIO_CONSTRAINTS
      });
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'TypeError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: true });
      } else {
        throw err;
      }
    }
    const track = stream.getVideoTracks()[0];
    if (track) await improveVideo(track, facing);
    return stream;
  }

  // Step up to the best mode the camera actually supports, without a new permission prompt.
  async function improveVideo(track, facing) {
    if (!track.applyConstraints) return;
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const capLong = Math.max((caps.width && caps.width.max) || 0, (caps.height && caps.height.max) || 0);
    const capShort = Math.min((caps.width && caps.width.max) || 0, (caps.height && caps.height.max) || 0);
    const capFps = (caps.frameRate && caps.frameRate.max) || 0;

    const ladder = facing === 'environment'
      ? [[3840, 2160, 60], [3840, 2160, 30], [1920, 1080, 60], [1920, 1080, 30]]
      : [[1920, 1080, 30]];

    for (const [w, h, fps] of ladder) {
      if (capLong && (capLong < w || capShort < h)) continue;   // sensor mode not offered
      if (fps > 30 && capFps && capFps < fps) continue;
      const before = track.getSettings();
      if (meets(before, w, fps)) return;                         // already there
      try {
        await track.applyConstraints({
          width: { ideal: w },
          height: { ideal: h },
          frameRate: { ideal: fps }
        });
      } catch (e) { /* try the next step down */ }
      if (meets(track.getSettings(), w, fps)) return;
    }
  }

  function meets(s, w, fps) {
    const long = Math.max(s.width || 0, s.height || 0);
    return long >= w * 0.95 && (s.frameRate || 0) >= fps - 1;
  }

  async function startCamera() {
    hideCameraMessage();
    captureInfo.textContent = 'Starting camera…';

    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraMessage('Camera not available',
        'This browser can’t use the camera here. Open the app over https in Safari (or from your Home Screen) on iOS 14.3 or later.', false);
      return;
    }

    stopStream();
    const req = state.cameraReq;
    const facing = state.facing;
    updateCameraButtons();
    try {
      const stream = await openCamera(facing);
      if (req !== state.cameraReq || state.screen !== 'record') {
        stream.getTracks().forEach((t) => t.stop()); // user left or switched meanwhile
        return;
      }
      attachStream(stream);
    } catch (err) {
      if (req !== state.cameraReq) return;
      showCameraError(err);
    } finally {
      updateCameraButtons();
    }
  }

  function attachStream(stream) {
    state.stream = stream;
    video.muted = true;               // iOS: inline autoplay needs muted + playsinline
    video.setAttribute('playsinline', '');
    video.srcObject = stream;
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* will start on the next tap */ });

    state.mirror = state.facing === 'user';
    applyMirror();

    stream.getTracks().forEach((t) => {
      t.addEventListener('ended', () => {
        if (state.stream !== stream || state.screen !== 'record') return;
        if (state.recording) stopRecording();
        showCameraMessage('Camera stopped',
          'The camera or microphone was interrupted (perhaps by a call or another app). Tap below to start it again.', true);
      });
    });

    updateCaptureInfo();
  }

  function updateCaptureInfo() {
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (!track) return;
    const s = track.getSettings();
    // videoWidth/videoHeight reflect the real frames (and their orientation).
    const w = video.videoWidth || s.width || 0;
    const h = video.videoHeight || s.height || 0;
    const fps = s.frameRate ? Math.round(s.frameRate) : '?';
    const audio = state.stream.getAudioTracks()[0];
    const rate = audio && audio.getSettings().sampleRate;
    let txt = `${w}×${h} · ${fps} fps`;
    if (rate) txt += ` · ${(rate / 1000).toFixed(rate % 1000 ? 1 : 0)} kHz`;
    if (state.recording && state.recorder) {
      const vb = state.recorder.videoBitsPerSecond;
      txt += ` · ${codecLabel(state.mimeType)}${vb ? ` ${Math.round(vb / 1e6)} Mbps` : ''}`;
    }
    captureInfo.textContent = txt;
  }

  video.addEventListener('resize', updateCaptureInfo);
  video.addEventListener('loadedmetadata', updateCaptureInfo);

  function codecLabel(type) {
    if (!type) return 'default';
    if (/hvc1|hev1/i.test(type)) return 'HEVC';
    if (/avc1|mp4/i.test(type)) return 'H.264';
    if (/vp9/i.test(type)) return 'VP9';
    return type.split(';')[0];
  }

  function applyMirror() {
    video.classList.toggle('mirrored', state.mirror);
    mirrorBtn.setAttribute('aria-pressed', String(state.mirror));
  }

  mirrorBtn.addEventListener('click', () => {
    state.mirror = !state.mirror;   // preview only; the recording is the raw camera stream
    applyMirror();
  });

  flipBtn.addEventListener('click', () => {
    if (state.recording || state.countingDown) return;
    state.facing = state.facing === 'user' ? 'environment' : 'user';
    startCamera();
  });

  function updateCameraButtons() {
    const busy = state.recording || state.countingDown;
    flipBtn.disabled = busy;
    backBtn.disabled = state.recording;
  }

  function showCameraError(err) {
    const name = (err && err.name) || '';
    const where = 'Settings > Safari > Camera and Settings > Safari > Microphone' +
      ' (on iOS 18 and later: Settings > Apps > Safari)';
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      showCameraMessage('Camera or microphone blocked',
        'Teleprompter needs your camera and microphone to record.\n\n' +
        `To allow them, go to ${where} and choose “Ask” or “Allow”.\n\n` +
        'In Safari you can also tap “aA” in the address bar > Website Settings.\n\n' +
        'Then come back here and tap Try again.', true);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      showCameraMessage('No camera found', 'No camera or microphone could be found on this device.', true);
    } else if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      showCameraMessage('Camera in use',
        'The camera or microphone is being used by another app (or a phone call). Close it, then tap Try again.', true);
    } else {
      showCameraMessage('Camera unavailable',
        `The camera couldn’t be started${name ? ` (${name})` : ''}. Tap Try again.`, true);
    }
    captureInfo.textContent = 'No camera';
  }

  function showCameraMessage(title, text, canRetry) {
    $('camera-msg-title').textContent = title;
    $('camera-msg-text').textContent = text;
    $('camera-retry').hidden = !canRetry;
    cameraMsg.hidden = false;
    showControls();
  }

  function hideCameraMessage() { cameraMsg.hidden = true; }

  // Retry from a tap, so iOS can prompt for permission again.
  $('camera-retry').addEventListener('click', startCamera);

  // ================================================================ RECORDING

  function pickMimeType() {
    if (!window.MediaRecorder) return null;
    const types = [
      'video/mp4;codecs=avc1',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4',
      'video/webm;codecs=vp9,opus',   // desktop fallbacks, for testing only
      'video/webm'
    ];
    if (typeof MediaRecorder.isTypeSupported !== 'function') return '';
    for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t;
    return '';
  }

  recordBtn.addEventListener('click', () => {
    if (state.recording) stopRecording();
    else if (state.countingDown) cancelCountdown();
    else if (state.countdown) beginCountdown();
    else startRecording();
  });

  function beginCountdown() {
    if (!state.stream) { toast('The camera isn’t ready yet.'); return; }
    let n = 3;
    state.countingDown = true;
    recordBtn.classList.add('is-counting');
    recordBtn.setAttribute('aria-label', 'Cancel countdown');
    updateCameraButtons();
    showNumber(n);
    state.countdownTimer = setInterval(() => {
      n -= 1;
      if (n > 0) {
        showNumber(n);
      } else {
        cancelCountdown();
        startRecording();
      }
    }, 1000);
    hideControls();
  }

  let countdownNumRef = countdownNum;
  function showNumber(n) {
    countdownEl.hidden = false;
    // Replace the node so the CSS pop animation restarts for each number.
    const fresh = countdownNumRef.cloneNode(false);
    fresh.textContent = n;
    countdownNumRef.replaceWith(fresh);
    countdownNumRef = fresh;
  }

  function cancelCountdown() {
    clearInterval(state.countdownTimer);
    state.countdownTimer = 0;
    state.countingDown = false;
    countdownEl.hidden = true;
    countdownNumRef.textContent = '';
    recordBtn.classList.remove('is-counting');
    recordBtn.setAttribute('aria-label', 'Start recording');
    updateCameraButtons();
  }

  function startRecording() {
    const stream = state.stream;
    if (!stream || !stream.getVideoTracks().length) {
      toast('The camera isn’t ready yet.');
      return;
    }
    const mimeType = pickMimeType();
    if (mimeType === null) {
      toast('Recording isn’t supported in this browser. Please update iOS.', 5000);
      return;
    }

    const s = stream.getVideoTracks()[0].getSettings();
    const long = Math.max(video.videoWidth, video.videoHeight, s.width || 0, s.height || 0);
    const options = {
      videoBitsPerSecond: long >= 3000 ? 16000000 : 10000000,
      audioBitsPerSecond: 192000
    };
    if (mimeType) options.mimeType = mimeType;

    let rec;
    try {
      rec = new MediaRecorder(stream, options);
    } catch (e) {
      try {
        rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (e2) {
        toast('Recording couldn’t start on this device.', 5000);
        return;
      }
    }

    state.recorder = rec;
    state.mimeType = rec.mimeType || mimeType || 'video/mp4';
    state.chunks = [];

    rec.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size) state.chunks.push(e.data);
    });
    rec.addEventListener('stop', onRecorderStop);
    rec.addEventListener('error', (e) => {
      toast(`Recording error: ${(e.error && e.error.name) || 'unknown'}`, 5000);
    });
    rec.addEventListener('start', () => {
      state.recStartedAt = performance.now();
      setPlaying(true);   // scroll starts as the recording starts
    });

    try {
      // No timeslice: Safari writes one clean MP4 when stopped.
      rec.start();
    } catch (e) {
      toast('Recording couldn’t start on this device.', 5000);
      state.recorder = null;
      return;
    }

    state.recording = true;
    state.recStartDate = new Date();
    state.recStartedAt = performance.now();
    recordBtn.classList.add('is-recording');
    recordBtn.setAttribute('aria-label', 'Stop recording');
    recIndicator.hidden = false;
    recTime.textContent = '0:00';
    state.recTimer = setInterval(() => {
      recTime.textContent = formatTime(performance.now() - state.recStartedAt);
    }, 250);
    updateCameraButtons();
    updateCaptureInfo();
    hideControls();
  }

  function endRecordingUI() {
    state.recording = false;
    state.recElapsed = performance.now() - state.recStartedAt;
    clearInterval(state.recTimer);
    setPlaying(false);
    recIndicator.hidden = true;
    recordBtn.classList.remove('is-recording');
    recordBtn.setAttribute('aria-label', 'Start recording');
    updateCameraButtons();
  }

  function stopRecording() {
    const rec = state.recorder;
    if (!state.recording || !rec) return;
    endRecordingUI();
    captureInfo.textContent = 'Finishing…';
    try {
      if (rec.state !== 'inactive') rec.stop();
      else onRecorderStop();
    } catch (e) {
      onRecorderStop();
    }
  }

  function onRecorderStop() {
    const rec = state.recorder;
    if (!rec) return;
    state.recorder = null;
    if (state.recording) endRecordingUI(); // stopped by the system (e.g. camera interrupted)

    const chunks = state.chunks;
    state.chunks = [];
    if (!chunks.length) {
      toast('Nothing was recorded. Please try again.');
      updateCaptureInfo();
      return;
    }
    const type = (state.mimeType || 'video/mp4').split(';')[0];
    const blob = new Blob(chunks, { type });
    showPreview(blob, type);
  }

  function clipName(date, type) {
    const d = date || new Date();
    const ext = /webm/.test(type) ? 'webm' : 'mp4';
    return `teleprompter-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-` +
      `${pad2(d.getHours())}${pad2(d.getMinutes())}.${ext}`;
  }

  // ================================================================ 3. PREVIEW / SAVE

  function showPreview(blob, type) {
    // Release the camera and microphone: saves battery, and stops iOS routing
    // playback to the quiet earpiece while the mic is open.
    stopStream();
    cancelCountdown();
    releaseWakeLock();

    const name = clipName(state.recStartDate, type);
    state.clipFile = new File([blob], name, { type, lastModified: Date.now() });
    state.clipUrl = URL.createObjectURL(blob);
    state.saved = false;

    clipVideo.src = `${state.clipUrl}#t=0.1`; // shows the first frame on iOS
    clipVideo.load();

    const mb = blob.size / (1024 * 1024);
    clipInfo.textContent = `${name} · ${formatDuration(state.recElapsed)} · ` +
      `${mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`}`;

    const canShareFiles = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [state.clipFile] }));
    saveBtn.hidden = !canShareFiles;
    downloadLink.href = state.clipUrl;
    downloadLink.download = name;
    downloadLink.hidden = canShareFiles;
    shareStatus.textContent = canShareFiles
      ? 'Tap Save to Photos, then choose “Save Video”.'
      : 'Sharing isn’t available here, so download the video instead.';

    showScreen('preview');
  }

  clipVideo.addEventListener('loadedmetadata', () => {
    if (clipVideo.videoWidth) {
      clipInfo.textContent += ` · ${clipVideo.videoWidth}×${clipVideo.videoHeight}`;
    }
  }, false);

  saveBtn.addEventListener('click', async () => {
    if (!state.clipFile) return;
    try {
      // Files only — adding a title or text stops iOS offering “Save Video”.
      await navigator.share({ files: [state.clipFile] });
      state.saved = true;
      shareStatus.textContent = 'Done. If you chose “Save Video”, it’s in Photos.';
    } catch (err) {
      if (err && err.name === 'AbortError') {
        shareStatus.textContent = 'Sharing cancelled.';
      } else {
        shareStatus.textContent = 'Couldn’t open sharing. Use Download video instead.';
        downloadLink.hidden = false;
      }
    }
  });

  downloadLink.addEventListener('click', () => { state.saved = true; });

  function clearClip() {
    clipVideo.pause();
    clipVideo.removeAttribute('src');
    clipVideo.load();
    if (state.clipUrl) URL.revokeObjectURL(state.clipUrl);
    state.clipUrl = '';
    state.clipFile = null;
  }

  $('again-btn').addEventListener('click', () => {
    if (!state.saved && !confirm('This clip hasn’t been saved. Record again anyway?')) return;
    clearClip();
    enterRecording(); // camera restarted from this tap
  });

  $('discard-btn').addEventListener('click', () => {
    if (!state.saved && !confirm('Discard this clip? It hasn’t been saved.')) return;
    clearClip();
    showScreen('script');
  });

  // ================================================================ WAKE LOCK & LIFECYCLE

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || state.wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      state.wakeLock = lock;
      lock.addEventListener('release', () => { if (state.wakeLock === lock) state.wakeLock = null; });
    } catch (e) { /* refused — fail quietly */ }
  }

  function releaseWakeLock() {
    const lock = state.wakeLock;
    state.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // iOS suspends the camera in the background: finish the clip so it isn't lost.
      if (state.recording) stopRecording();
      cancelCountdown();
      setPlaying(false);
    } else if (state.screen === 'record') {
      requestWakeLock();
      const live = state.stream && state.stream.getTracks().every((t) => t.readyState === 'live');
      if (state.stream && !live) {
        showCameraMessage('Camera stopped', 'The camera was paused while the app was in the background. Tap below to start it again.', true);
      } else if (state.stream && video.paused) {
        video.play().catch(() => {});
      }
    }
  });

  // ================================================================ SERVICE WORKER

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support unavailable */ });
    });
  }

  // Initial UI state
  applyFontSize();
  applySpeedLabel();
  updateCountdownBtn();
  showScreen('script');
})();
