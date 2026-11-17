// VRedux — stand on the spot, hold up your phone, see the remakes around you.
// Vibecoded by DeDomenici. No build step: three.js + optional MediaPipe/Spark from CDN.
import * as THREE from 'three';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18';
const MODELS = {
  selfie: { url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite', cat: 0 },
  deeplab: { url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite', cat: 15 },
};
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const $ = (s) => document.querySelector(s);
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180;
const wrapRad = (r) => Math.atan2(Math.sin(r), Math.cos(r));
const qs = new URLSearchParams(location.search);

// ---------- analytics (no personal data) ----------
function gc(name, label) {
  try { window.goatcounter?.count?.({ path: 'vredux-click-' + name, title: label || name, event: true }); } catch (e) {}
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-gc]');
  if (el) gc(el.dataset.gc, (el.textContent || '').trim().slice(0, 40));
});

// ---------- state ----------
const S = {
  scenes: [], scene: null, mode: '360', playing: false, t: 0, muted: true,
  nudge: 0, fov: 70, ghost: 0.5, matteSrc: 'pre', aiModel: 'selfie', fmt: qs.get('fmt') === 'alpha' ? 'alpha' : 'auto',
  media: [], layers: [], bg: null, bgMedia: null, matteMedia: null, camStream: null, geoWatch: null, unlocked: false,
  motion: { active: false, needsPerm: typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function',
    a: 0, b: 0, g: 0, absolute: false, corr: null, listening: false },
  drag: { yaw: 0, pitch: 0 },
  walk: null,
};
window.__vredux = S; // for debugging/tests

// ---------- renderer ----------
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: qs.has('shot') });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 3000);
camera.rotation.order = 'YXZ';
const bgScene = new THREE.Scene();
const layerScene = new THREE.Scene();

const bgU = {
  uTex: { value: null }, uMatte: { value: null }, uMask: { value: null },
  uHeading: { value: 0 }, uAlphaMode: { value: 0 }, uGhost: { value: 0.5 },
  uRes: { value: new THREE.Vector2(1, 1) }, uForceOpaque: { value: 0 },
};
const SPHERE_VS = `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const DIR_TO_UV = `
  vec2 dirToUv(vec3 d, float heading){
    d = normalize(d);
    float b = atan(d.x, -d.z);                 // compass bearing of this view ray (north = -Z, east = +X)
    float u = fract(0.5 + (b - heading) / 6.2831853);
    float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / 3.1415927;
    return vec2(u, v);
  }`;
const bgMat = new THREE.ShaderMaterial({
  uniforms: bgU, vertexShader: SPHERE_VS, side: THREE.BackSide, depthWrite: false, depthTest: false, blending: THREE.NoBlending,
  fragmentShader: `
  uniform sampler2D uTex, uMatte, uMask; uniform float uHeading, uAlphaMode, uGhost, uForceOpaque; uniform vec2 uRes;
  varying vec3 vDir; ${DIR_TO_UV}
  void main(){
    vec2 uv = dirToUv(vDir, uHeading);
    vec3 c = texture2D(uTex, uv).rgb;
    float a = 1.0;
    if (uForceOpaque < 0.5) {
      if (uAlphaMode > 0.5 && uAlphaMode < 1.5) a = uGhost;                                     // ghost crossfade
      else if (uAlphaMode > 1.5 && uAlphaMode < 2.5) a = texture2D(uMatte, uv).r;              // pre-rendered matte
      else if (uAlphaMode > 2.5 && uAlphaMode < 3.5) { vec2 s = gl_FragCoord.xy / uRes; a = texture2D(uMask, vec2(s.x, 1.0 - s.y)).r; } // live AI
      else if (uAlphaMode > 3.5 && uAlphaMode < 4.5) { float l = dot(c, vec3(.299,.587,.114)); a = smoothstep(.5, .28, l); }      // ink key
      else if (uAlphaMode > 4.5) a = 0.0;                                                       // hidden
    }
    gl_FragColor = vec4(c * a, a);
  }`,
});
const bgSphere = new THREE.Mesh(new THREE.SphereGeometry(500, 64, 32), bgMat);
bgSphere.frustumCulled = false;
bgScene.add(bgSphere);

function layerMaterial(projection) {
  const flat = projection !== 'equirect';
  return new THREE.ShaderMaterial({
    uniforms: { uTex: { value: null }, uStacked: { value: 1 }, uOpacity: { value: 1 }, uHeading: { value: 0 } },
    vertexShader: flat
      ? `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`
      : SPHERE_VS,
    fragmentShader: `
      uniform sampler2D uTex; uniform float uStacked, uOpacity, uHeading;
      ${flat ? 'varying vec2 vUv;' : 'varying vec3 vDir;' + DIR_TO_UV}
      void main(){
        vec2 uv = ${flat ? 'vUv' : 'dirToUv(vDir, uHeading)'};
        vec3 c; float a;
        if (uStacked > 0.5) {          // colour on top half, matte (grey) on bottom half
          c = texture2D(uTex, vec2(uv.x, mix(0.502, 1.0, uv.y))).rgb;
          a = texture2D(uTex, vec2(uv.x, mix(0.0, 0.498, uv.y))).g;
          a = smoothstep(0.04, 0.96, a);
        } else { vec4 t = texture2D(uTex, uv); c = t.rgb; a = t.a; }
        a *= uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(c * a, a);
      }`,
    side: flat ? THREE.DoubleSide : THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

// ---------- procedural background (when a scene has no 360) ----------
function proceduralBg(heading) {
  const c = document.createElement('canvas'); c.width = 2048; c.height = 1024; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 1024);
  g.addColorStop(0, '#4b6b8a'); g.addColorStop(0.5, '#cfd8dc'); g.addColorStop(0.5, '#555'); g.addColorStop(1, '#1a1a1a');
  x.fillStyle = g; x.fillRect(0, 0, 2048, 1024);
  x.strokeStyle = 'rgba(255,255,255,.25)'; x.lineWidth = 2;
  for (let i = 0; i < 36; i++) { const u = i / 36 * 2048; x.beginPath(); x.moveTo(u, 512); x.lineTo(u, 1024); x.stroke(); }
  x.fillStyle = '#ffe14a'; x.font = 'bold 44px Archivo, sans-serif'; x.textAlign = 'center';
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  names.forEach((n, i) => { const b = i * 45; const u = ((0.5 + wrapDeg(b - heading) / 360) % 1 + 1) % 1 * 2048; x.fillText(n, u, 490); x.fillRect(u - 2, 500, 4, 24); });
  return new THREE.CanvasTexture(c);
}

// ---------- media helpers ----------
function makeVideo(src, { loop = true, muted = true } = {}) {
  const v = document.createElement('video');
  v.crossOrigin = 'anonymous'; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
  v.muted = muted; v.loop = loop; v.preload = 'auto'; v.src = src;
  return v;
}
function videoTex(v) {
  const t = new THREE.VideoTexture(v);
  t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}
const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
function pickLayerSource(src) {
  if (S.fmt === 'alpha') {
    if (isSafari && src.hevc) return { url: src.hevc, stacked: false };
    if (!isSafari && src.webm) return { url: src.webm, stacked: false };
  }
  if (src.stacked) return { url: src.stacked, stacked: true };
  if (src.webm) return { url: src.webm, stacked: false };
  return { url: src.hevc, stacked: false };
}
function pickBgSource(bg) {
  const list = (bg.sources || []).slice().sort((a, b) => b.width - a.width);
  if (!list.length) return null;
  const small = Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1) < 900 || navigator.connection?.saveData;
  const want = qs.get('q') === 'low' || small ? list[list.length - 1] : list[0];
  return want.src;
}

// ---------- scene loading ----------
function disposeScene() {
  S.playing = false;
  for (const m of S.media) { try { m.v.pause(); m.v.removeAttribute('src'); m.v.load(); } catch (e) {} m.tex?.dispose(); }
  S.media = [];
  for (const L of S.layers) { layerScene.remove(L.mesh); L.mesh.geometry.dispose(); L.mesh.material.dispose(); }
  S.layers = []; S.bgMedia = null; S.matteMedia = null;
  bgU.uTex.value?.dispose?.(); bgU.uTex.value = null; bgU.uMatte.value = null;
  exitWalk();
}

function loadScene(sc) {
  disposeScene();
  S.scene = sc; S.t = 0; S.nudge = 0; S.unlocked = false;
  bgU.uHeading.value = (sc.heading || 0) * D2R;
  S.drag.yaw = (sc.front ?? sc.heading ?? 0) * D2R; S.drag.pitch = 0;
  $('#sceneTitle').textContent = sc.title;
  const bg = sc.background;
  if (bg && bg.sources) {
    const v = makeVideo(pickBgSource(bg), { loop: bg.loop !== false, muted: true });
    if (bg.poster) v.poster = bg.poster;
    const tex = videoTex(v); bgU.uTex.value = tex;
    S.bgMedia = { v, tex, start: 0, loop: bg.loop !== false, kind: 'bg', audio: bg.audio !== false };
    S.media.push(S.bgMedia);
    if (bg.matte?.src) {
      const mv = makeVideo(bg.matte.src, { loop: bg.loop !== false, muted: true });
      const mt = videoTex(mv); bgU.uMatte.value = mt;
      S.matteMedia = { v: mv, tex: mt, start: 0, loop: bg.loop !== false, kind: 'matte' };
      S.media.push(S.matteMedia);
    }
  } else if (bg && bg.image) {
    const small = Math.min(screen.width, screen.height) * (window.devicePixelRatio || 1) < 900 || qs.get('q') === 'low';
    const tex = new THREE.TextureLoader().load(small && bg.imageLow ? bg.imageLow : bg.image, () => {}, undefined, () => toast('Background image failed to load'));
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; bgU.uTex.value = tex;
  } else {
    bgU.uTex.value = proceduralBg(sc.heading || 0);
  }
  if (!bgU.uMatte.value) bgU.uMatte.value = bgU.uTex.value;
  if (!bgU.uMask.value) bgU.uMask.value = segTex;

  (sc.layers || []).forEach((cfg) => addLayer(cfg));
  buildLayerChips(); buildEditor();
  if (!sc.splat && sc.splatSrc) sc.splat = { src: sc.splatSrc };
  $('#walkSeg').classList.toggle('hidden', !sc.splat);
  // matte source options availability
  const hasBgVideo = !!S.bgMedia;
  $('#matteSrc').querySelector('[value=pre]').disabled = !S.matteMedia;
  $('#matteSrc').querySelector('[value=ai]').disabled = !hasBgVideo;
  $('#matteSrc').querySelector('[value=ink]').disabled = !hasBgVideo;
  S.matteSrc = S.matteMedia ? 'pre' : hasBgVideo ? 'ai' : 'none';
  if (hasBgVideo && !S.matteMedia) S.matteSrc = 'none';
  $('#matteSrc').value = S.matteSrc;
  updateLoc();
  $('#bigPlay').classList.remove('hidden');
  $('#bigPlayHint').textContent = sc.kind === '360'
    ? 'Turn sound on. Hold your phone up like a window and turn around.'
    : 'Stand on the spot, hold your phone up, and look around for the characters.';
  setMode(qs.get('mode') || (sc.startMode) || '360', true);
}

function addLayer(cfg) {
  const pick = pickLayerSource(cfg.sources || {});
  const v = makeVideo(pick.url, { loop: cfg.loop !== false, muted: true });
  const tex = videoTex(v);
  const mat = layerMaterial(cfg.projection);
  mat.uniforms.uTex.value = tex; mat.uniforms.uStacked.value = pick.stacked ? 1 : 0;
  let mesh;
  if (cfg.projection === 'equirect') {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(400 - S.layers.length, 48, 24), mat);
    mat.uniforms.uHeading.value = (cfg.bearing || 0) * D2R;
  } else mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.frustumCulled = false; mesh.visible = false;
  const L = { cfg: { ...cfg }, mesh, v, tex, aspect: cfg.aspect || 1, enabled: cfg.enabled !== false, ready: false, stacked: pick.stacked };
  v.addEventListener('loadeddata', () => {
    L.ready = true;
    if (v.videoWidth) L.aspect = pick.stacked ? v.videoWidth / (v.videoHeight / 2) : v.videoWidth / v.videoHeight;
    placeLayer(L);
  });
  v.addEventListener('error', () => toast(`Layer "${cfg.title}" failed to load`));
  layerScene.add(mesh); S.layers.push(L);
  S.media.push({ v, tex, start: cfg.start || 0, loop: cfg.loop !== false, kind: 'layer', layer: L, audio: !!cfg.audio });
  placeLayer(L);
}

function layerOrigin() {
  if (S.walk?.active) return S.walk.origin;
  return new THREE.Vector3(0, 0, 0);
}
function placeLayer(L) {
  if (L.cfg.projection === 'equirect') { L.mesh.material.uniforms.uHeading.value = (L.cfg.bearing || 0) * D2R; return; }
  const sc = S.scene || {}; const o = layerOrigin();
  const b = (L.cfg.bearing || 0) * D2R, d = L.cfg.distance || 6, h = L.cfg.frameHeight || 2.8, w = h * L.aspect;
  const eye = S.walk?.active ? 0 : (sc.eyeHeight || 1.6);
  const y = (S.walk?.active ? S.walk.groundY : -eye) + (L.cfg.elevation || 0) + h / 2;
  L.mesh.scale.set(w, h, 1);
  L.mesh.position.set(o.x + Math.sin(b) * d, y, o.z - Math.cos(b) * d);
  L.mesh.renderOrder = 1000 - d;
}

// ---------- playback / sync ----------
function applyMute() {
  for (const m of S.media) if (m.kind === 'bg' || m.audio) m.v.muted = S.muted;
  $('#muteBtn').textContent = S.muted ? '🔇' : '🔊';
}
function syncMedia(force) {
  for (const m of S.media) {
    const v = m.v;
    if (m.layer && !m.layer.enabled) { m.layer.mesh.visible = false; if (!v.paused) v.pause(); continue; }
    const D = v.duration; const local = S.t - m.start;
    const vis = local >= 0 && (m.loop || !isFinite(D) || local <= D + 0.05);
    if (m.layer) m.layer.mesh.visible = vis && m.layer.ready;
    if (!S.playing || !vis) { if (!v.paused) v.pause(); if (force && isFinite(D)) v.currentTime = Math.max(0, Math.min(local, D)); continue; }
    if (v.paused) v.play().catch(() => {});
    if (m === S.bgMedia && !force) continue; // bg is the master clock
    if (isFinite(D) && D > 0) {
      const exp = m.loop ? ((local % D) + D) % D : Math.min(local, D);
      let diff = v.currentTime - exp;
      if (m.loop) { if (diff > D / 2) diff -= D; if (diff < -D / 2) diff += D; }
      if (force || Math.abs(diff) > 0.3) { try { v.currentTime = exp; } catch (e) {} }
    }
  }
}
function play(fromStart) {
  S.playing = true;
  if (fromStart) S.t = 0;
  syncMedia(true);
  $('#playBtn').textContent = '❚❚';
  $('#bigPlay').classList.add('hidden');
}
function pause() { S.playing = false; syncMedia(false); $('#playBtn').textContent = '▶'; }

// ---------- modes ----------
async function setMode(mode, quiet) {
  if (mode === 'walk' && !S.scene?.splat) mode = '360';
  S.mode = mode;
  document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (!quiet) gc('mode-' + mode, 'Mode: ' + mode);
  $('#ghostWrap').style.display = mode === 'ghost' ? '' : 'none';
  const needCam = mode === 'ghost' || mode === 'pass';
  if (needCam) await startCamera(); else stopCamera();
  if (mode === 'walk') await enterWalk(); else exitWalk();
  updateAlphaMode();
}
function updateAlphaMode() {
  let m = 0;
  if (S.mode === 'ghost') m = 1;
  else if (S.mode === 'pass') {
    m = 5;
    if (S.bgMedia) m = { pre: S.matteMedia ? 2 : 5, ai: 3, ink: 4, none: 5 }[S.matteSrc];
  }
  bgU.uAlphaMode.value = m;
  $('#aiModelWrap').style.display = S.matteSrc === 'ai' ? '' : 'none';
  if (m === 3) ensureSeg().catch((e) => { console.warn(e); toast('AI cut-out could not start on this device: ' + (e.message || e)); });
}
async function startCamera() {
  if (S.camStream) return;
  if (!navigator.mediaDevices?.getUserMedia) { toast('No camera access in this browser. Showing ghost over black.'); return; }
  try {
    S.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    const cam = $('#cam'); cam.srcObject = S.camStream; cam.style.display = 'block'; await cam.play().catch(() => {});
    gc('passthrough-start', 'Passthrough camera started');
  } catch (e) { toast('Camera blocked: ' + (e.message || e.name) + '. Allow camera access to see the street behind the characters.'); }
}
function stopCamera() {
  if (S.camStream) { S.camStream.getTracks().forEach((t) => t.stop()); S.camStream = null; }
  const cam = $('#cam'); cam.srcObject = null; cam.style.display = 'none';
}

// ---------- device orientation ----------
const zee = new THREE.Vector3(0, 0, 1), eul = new THREE.Euler(), q0 = new THREE.Quaternion(),
  q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), qDev = new THREE.Quaternion(), qYaw = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
function screenAngle() { return ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * D2R; }
function onOrient(e, isAbsEvent) {
  if (e.alpha == null && e.beta == null) return;
  const M = S.motion;
  if (!isAbsEvent && M.absolute && M.lastAbs && performance.now() - M.lastAbs < 1000) return; // prefer absolute stream
  if (isAbsEvent) { M.absolute = true; M.lastAbs = performance.now(); }
  else if (e.absolute === true) M.absolute = true;
  let a = e.alpha || 0;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    // iOS: alpha is relative; derive a smoothed correction to true compass heading
    const target = wrapDeg(360 - e.webkitCompassHeading - a);
    M.corr = M.corr == null ? target : M.corr + wrapDeg(target - M.corr) * 0.05;
    M.absolute = true;
  }
  if (M.corr != null) a += M.corr;
  M.a = a * D2R; M.b = (e.beta || 0) * D2R; M.g = (e.gamma || 0) * D2R;
  if (!M.active) { M.active = true; updateMotionBtn(); toast(M.absolute ? 'Motion on, aligned to compass' : 'Motion on (no compass: tap recentre to align)'); }
}
function listenMotion() {
  if (S.motion.listening) return; S.motion.listening = true;
  window.addEventListener('deviceorientationabsolute', (e) => onOrient(e, true));
  window.addEventListener('deviceorientation', (e) => onOrient(e, false));
}
async function enableMotion() {
  try {
    if (S.motion.needsPerm) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { toast('Motion permission denied. Drag to look around instead.'); return; }
      S.motion.needsPerm = false;
    }
    listenMotion();
    setTimeout(() => { if (!S.motion.active) toast('No motion sensor found. Drag to look around.'); }, 1500);
  } catch (e) { toast('Motion unavailable: ' + (e.message || e)); }
  updateMotionBtn();
}
function updateMotionBtn() {
  const b = $('#motionBtn');
  b.textContent = S.motion.active ? (S.motion.absolute ? 'Motion ✓ compass' : 'Motion ✓') : 'Enable motion';
  b.classList.toggle('on', S.motion.active);
}
function cameraBearing() {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return Math.atan2(f.x, -f.z);
}
function updateCameraOrientation() {
  if (S.motion.active) {
    eul.set(S.motion.b, S.motion.a, -S.motion.g, 'YXZ');
    qDev.setFromEuler(eul); qDev.multiply(q1); qDev.multiply(q0.setFromAxisAngle(zee, -screenAngle()));
    qYaw.setFromAxisAngle(yAxis, S.nudge);
    camera.quaternion.copy(qYaw).multiply(qDev);
  } else {
    camera.rotation.set(S.drag.pitch, -S.drag.yaw + S.nudge, 0, 'YXZ');
  }
}
function recentre() {
  const front = ((S.scene?.front ?? S.scene?.heading) || 0) * D2R;
  if (S.motion.active) S.nudge = wrapRad(S.nudge + (cameraBearing() - front));
  else { S.drag.yaw = front; S.drag.pitch = 0; S.nudge = 0; }
  toast('Recentred: the scene now faces where your phone points');
}

// ---------- pointer: drag look, pinch zoom ----------
const ptrs = new Map(); let pinch0 = null;
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch0 = { d: Math.hypot(p.x - q.x, p.y - q.y), fov: S.fov }; } });
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  if (ptrs.size === 2 && pinch0) {
    p.x = e.clientX; p.y = e.clientY; const [a, b] = [...ptrs.values()];
    S.fov = THREE.MathUtils.clamp(pinch0.fov * pinch0.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), 25, 100); return;
  }
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  const k = (S.fov / canvas.clientHeight) * D2R;
  if (S.motion.active) S.nudge = wrapRad(S.nudge + dx * k); // drag = manual alignment while gyro is on
  else { S.drag.yaw -= dx * k; S.drag.pitch = THREE.MathUtils.clamp(S.drag.pitch + dy * k, -1.5, 1.5); }
});
const endPtr = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; };
canvas.addEventListener('pointerup', endPtr); canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); S.fov = THREE.MathUtils.clamp(S.fov + e.deltaY * 0.05, 25, 100); }, { passive: false });

// ---------- live AI segmentation (MediaPipe) ----------
const SEG_W = 256, SEG_H = 256;
const segRT = new THREE.WebGLRenderTarget(SEG_W, SEG_H);
const segPx = new Uint8Array(SEG_W * SEG_H * 4);
const segMask = new Uint8Array(SEG_W * SEG_H);
const segTex = new THREE.DataTexture(segMask, SEG_W, SEG_H, THREE.RedFormat, THREE.UnsignedByteType);
segTex.minFilter = segTex.magFilter = THREE.LinearFilter; segTex.needsUpdate = true;
let seg = null, segLoading = null, segLast = 0, segImg = null, segMs = 0;
async function ensureSeg() {
  if (seg && seg.model === S.aiModel) return seg;
  if (segLoading) return segLoading;
  toast('Loading AI person cut-out…');
  segLoading = (async () => {
    const vision = await import(MP + '/vision_bundle.mjs');
    const files = await vision.FilesetResolver.forVisionTasks(MP + '/wasm');
    const M = MODELS[S.aiModel];
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: M.url, delegate }, runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false });
    let s;
    try { s = await vision.ImageSegmenter.createFromOptions(files, opts('GPU')); } catch (e) { s = await vision.ImageSegmenter.createFromOptions(files, opts('CPU')); }
    seg?.s?.close?.();
    seg = { s, model: S.aiModel, cat: M.cat };
    toast('AI cut-out ready'); return seg;
  })();
  try { return await segLoading; } finally { segLoading = null; }
}
function runSeg(now) {
  if (!seg || now - segLast < 70) return;
  segLast = now; const t0 = performance.now();
  bgU.uForceOpaque.value = 1;
  renderer.setRenderTarget(segRT); renderer.clear(); renderer.render(bgScene, camera);
  renderer.readRenderTargetPixels(segRT, 0, 0, SEG_W, SEG_H, segPx);
  renderer.setRenderTarget(null); bgU.uForceOpaque.value = 0;
  if (!segImg) segImg = new ImageData(SEG_W, SEG_H);
  for (let y = 0; y < SEG_H; y++) segImg.data.set(segPx.subarray((SEG_H - 1 - y) * SEG_W * 4, (SEG_H - y) * SEG_W * 4), y * SEG_W * 4);
  try {
    const r = seg.s.segmentForVideo(segImg, now);
    const masks = r.confidenceMasks || [];
    const m = masks[seg.cat] || masks[0];
    if (m) {
      const f = m.getAsFloat32Array(); const mw = m.width, mh = m.height;
      if (mw === SEG_W && mh === SEG_H) for (let i = 0; i < f.length; i++) segMask[i] = f[i] * 255;
      else for (let y = 0; y < SEG_H; y++) for (let x = 0; x < SEG_W; x++) segMask[y * SEG_W + x] = f[((y * mh / SEG_H) | 0) * mw + ((x * mw / SEG_W) | 0)] * 255;
      segTex.needsUpdate = true;
    }
    r.close?.();
  } catch (e) { console.warn('seg', e); }
  segMs = performance.now() - t0;
}

// ---------- walkable splat (beta) ----------
async function enterWalk() {
  const cfg = S.scene?.splat; if (!cfg) return;
  if (S.walk?.active) return;
  toast('Loading walkable splat scene (beta)…');
  try {
    if (!S.walk) {
      const spark = await import('@sparkjsdev/spark');
      const scene = new THREE.Scene();
      const sr = new spark.SparkRenderer({ renderer }); scene.add(sr);
      const mesh = new spark.SplatMesh({ url: cfg.src });
      const r = cfg.rotation || [180, 0, 0];
      mesh.rotation.set(r[0] * D2R, r[1] * D2R, r[2] * D2R);
      if (cfg.scale) mesh.scale.setScalar(cfg.scale);
      if (cfg.position) mesh.position.fromArray(cfg.position);
      scene.add(mesh);
      S.walk = { scene, mesh, active: false, origin: new THREE.Vector3().fromArray(cfg.anchor || [0, 0, 0]), groundY: cfg.groundY ?? 0, pos: new THREE.Vector3().fromArray(cfg.spawn || [0, 1.6, 4]), move: { x: 0, y: 0 }, keys: new Set(), loaded: false };
      mesh.initialized?.then?.(() => { S.walk.loaded = true; toast('Splat loaded. Walk around!'); }).catch((e) => toast('Splat failed: ' + e.message));
    }
    S.walk.active = true;
    if (!S.motion.active) { S.drag.yaw = (S.scene.splat.spawnBearing ?? 0) * D2R; S.drag.pitch = 0; S.nudge = 0; }
    $('#joy').classList.remove('hidden'); $('#walkHint').classList.remove('hidden');
    S.layers.forEach(placeLayer);
    gc('walk-start', 'Walkable splat started');
  } catch (e) { console.error(e); toast('Walk mode could not load: ' + (e.message || e)); S.mode = '360'; }
}
function exitWalk() {
  if (!S.walk?.active) return;
  S.walk.active = false; camera.position.set(0, 0, 0);
  $('#joy').classList.add('hidden'); $('#walkHint').classList.add('hidden');
  S.layers.forEach(placeLayer);
}
(() => { // joystick + WASD
  const joy = $('#joy'), knob = $('#joyKnob'); let id = null;
  const set = (e) => { const r = joy.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2); const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; } knob.style.transform = `translate(${x * 35}px,${y * 35}px)`; if (S.walk) S.walk.move = { x, y }; };
  joy.addEventListener('pointerdown', (e) => { id = e.pointerId; joy.setPointerCapture(id); set(e); });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
  const end = () => { id = null; knob.style.transform = ''; if (S.walk) S.walk.move = { x: 0, y: 0 }; };
  joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
  addEventListener('keydown', (e) => S.walk?.keys.add(e.key.toLowerCase()));
  addEventListener('keyup', (e) => S.walk?.keys.delete(e.key.toLowerCase()));
})();
function updateWalk(dt) {
  const W = S.walk; if (!W?.active) return;
  let mx = W.move.x, my = W.move.y; const k = W.keys;
  if (k.has('w') || k.has('arrowup')) my -= 1; if (k.has('s') || k.has('arrowdown')) my += 1;
  if (k.has('a') || k.has('arrowleft')) mx -= 1; if (k.has('d') || k.has('arrowright')) mx += 1;
  const speed = (S.scene.splat.speed || 1.4) * dt;
  const b = cameraBearing();
  const fwd = new THREE.Vector3(Math.sin(b), 0, -Math.cos(b)), right = new THREE.Vector3(Math.cos(b), 0, Math.sin(b));
  W.pos.addScaledVector(fwd, -my * speed).addScaledVector(right, mx * speed);
  camera.position.copy(W.pos);
}

// ---------- location ----------
function haversine(a, b, c, d) { const R = 6371000, p1 = a * D2R, p2 = c * D2R, dp = (c - a) * D2R, dl = (d - b) * D2R; const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
function bearingTo(a, b, c, d) { const p1 = a * D2R, p2 = c * D2R, dl = (d - b) * D2R; return (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * R2D + 360) % 360; }
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function updateLoc(pos) {
  const sc = S.scene, el = $('#loc'); if (!sc) return;
  if (sc.lat == null || sc.lng == null) {
    el.innerHTML = sc.freePlayOnly ? '<span class="tag">FREE-PLAY</span> works anywhere' : '<span class="tag">FREE-PLAY</span> filming spot TBC';
    return;
  }
  if (!pos) { el.innerHTML = `<span class="tag">ON LOCATION</span><button id="findBtn" data-gc="find-spot">📍 Find the spot</button> <span class="hint">or just play anywhere</span>`; $('#findBtn').onclick = startGeo; return; }
  const d = haversine(pos.coords.latitude, pos.coords.longitude, sc.lat, sc.lng);
  const br = bearingTo(pos.coords.latitude, pos.coords.longitude, sc.lat, sc.lng);
  if (d <= (sc.unlockRadius || 20)) {
    el.innerHTML = `<span class="here">YOU'RE HERE</span> ±${Math.round(pos.coords.accuracy)} m`;
    if (!S.unlocked) { S.unlocked = true; toast("You're on the spot. Hold your phone up!"); gc('unlock', 'Reached filming spot'); }
  } else {
    el.innerHTML = `${d < 1000 ? Math.round(d) + ' m' : (d / 1000).toFixed(1) + ' km'} away · head ${COMPASS[Math.round(br / 45) % 8]} <span class="hint">(±${Math.round(pos.coords.accuracy)} m) · playback works anywhere</span>`;
  }
}
function startGeo() {
  if (!navigator.geolocation) { toast('No location on this device'); return; }
  if (S.geoWatch != null) navigator.geolocation.clearWatch(S.geoWatch);
  S.geoWatch = navigator.geolocation.watchPosition(updateLoc, (e) => toast('Location unavailable: ' + e.message), { enableHighAccuracy: true, maximumAge: 5000 });
}

// ---------- UI ----------
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 2600); }
function buildLayerChips() {
  const row = $('#layerRow'); row.innerHTML = '';
  if (!S.layers.length) { row.style.display = 'none'; return; }
  row.style.display = '';
  S.layers.forEach((L) => {
    const b = document.createElement('button'); b.className = 'lchip' + (L.enabled ? '' : ' off');
    b.textContent = `${L.cfg.title}${L.cfg.film ? ' · ' + L.cfg.film : ''}`;
    b.onclick = () => { L.enabled = !L.enabled; b.classList.toggle('off', !L.enabled); gc('layer-toggle', 'Layer: ' + L.cfg.id); syncMedia(true); };
    row.appendChild(b);
  });
}
function buildEditor() {
  const sel = $('#edLayer'); sel.innerHTML = '';
  $('#editor').style.display = S.layers.some((L) => L.cfg.projection !== 'equirect') ? '' : 'none';
  S.layers.forEach((L, i) => { const o = document.createElement('option'); o.value = i; o.textContent = L.cfg.title; sel.appendChild(o); });
  loadEditor();
}
const ED = [['edBearing', 'bearing', 'oBearing', '°'], ['edDist', 'distance', 'oDist', ''], ['edH', 'frameHeight', 'oH', ''], ['edE', 'elevation', 'oE', '']];
function loadEditor() { const L = S.layers[+$('#edLayer').value]; if (!L) return; ED.forEach(([id, k, o, u]) => { $('#' + id).value = L.cfg[k] ?? 0; $('#' + o).textContent = (L.cfg[k] ?? 0) + u; }); }
$('#edLayer').onchange = loadEditor;
ED.forEach(([id, k, o, u]) => { $('#' + id).oninput = (e) => { const L = S.layers[+$('#edLayer').value]; if (!L) return; L.cfg[k] = +e.target.value; $('#' + o).textContent = e.target.value + u; placeLayer(L); }; });
$('#copyJson').onclick = async () => {
  const L = S.layers[+$('#edLayer').value]; if (!L) return;
  const txt = JSON.stringify(L.cfg, null, 2);
  try { await navigator.clipboard.writeText(txt); toast('Layer JSON copied, paste it into videos.json'); } catch (e) { prompt('Copy this into videos.json', txt); }
};

document.querySelectorAll('.seg').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#playBtn').onclick = () => (S.playing ? pause() : play(false));
$('#restartBtn').onclick = () => play(true);
$('#bigPlayBtn').onclick = async () => {
  if (S.motion.needsPerm) await enableMotion(); else listenMotion();
  S.muted = false; applyMute(); play(true);
};
$('#motionBtn').onclick = enableMotion;
$('#alignBtn').onclick = recentre;
$('#nudgeL').onclick = () => { S.nudge = wrapRad(S.nudge - 5 * D2R); };
$('#nudgeR').onclick = () => { S.nudge = wrapRad(S.nudge + 5 * D2R); };
$('#muteBtn').onclick = () => { S.muted = !S.muted; applyMute(); };
$('#fsBtn').onclick = () => {
  const el = $('#player');
  if (document.fullscreenElement || document.webkitFullscreenElement) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else if (el.requestFullscreen) el.requestFullscreen().catch(() => document.body.classList.toggle('ui-hidden'));
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  else document.body.classList.toggle('ui-hidden'); // iPhone: hide chrome instead
};
$('#hideBtn').onclick = () => document.body.classList.toggle('ui-hidden');
$('#ghostOpacity').oninput = (e) => { S.ghost = +e.target.value; bgU.uGhost.value = S.ghost; };
$('#matteSrc').onchange = (e) => { S.matteSrc = e.target.value; gc('matte-' + S.matteSrc, 'Matte source: ' + S.matteSrc); if (S.mode !== 'pass') setMode('pass'); else updateAlphaMode(); };
$('#aiModel').onchange = (e) => { S.aiModel = e.target.value; seg = null; updateAlphaMode(); };
$('#fmtSel').value = S.fmt;
$('#fmtSel').onchange = (e) => { S.fmt = e.target.value; gc('format-' + S.fmt); const sc = S.scene; loadScene(sc); };
$('#backBtn').onclick = () => { disposeScene(); stopCamera(); showHome(); };

function showHome() {
  $('#player').classList.add('hidden'); $('#home').classList.remove('hidden');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
function openScene(sc) {
  $('#home').classList.add('hidden'); $('#player').classList.remove('hidden');
  history.replaceState(null, '', '#' + sc.id);
  resize(); loadScene(sc); gc('open-' + sc.id, 'Open scene: ' + sc.title);
  listenMotion(); // Android starts streaming straight away; iOS needs the button
  updateMotionBtn();
}
function renderList() {
  const ul = $('#sceneList'); ul.innerHTML = '';
  S.scenes.forEach((sc) => {
    const li = document.createElement('li'); const b = document.createElement('button'); b.className = 'scene-card';
    const tags = [sc.kind === '360' ? '360 video' : 'Street corner', sc.layers?.length ? sc.layers.length + ' cut-outs' : '', sc.splat ? 'Walkable (beta)' : '', sc.lat == null ? 'Free-play' : 'On location'].filter(Boolean);
    b.innerHTML = `<h2></h2><p></p><div class="meta">${tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>`;
    b.querySelector('h2').textContent = sc.title; b.querySelector('p').textContent = sc.subtitle || '';
    b.onclick = () => openScene(sc);
    li.appendChild(b); ul.appendChild(li);
  });
}
function openOwn(url, name) {
  const sc = { id: 'own', title: name || 'Your 360 video', kind: '360', lat: null, lng: null, freePlayOnly: true, heading: 0, front: 0, background: { sources: [{ src: url, width: 1 }], loop: true, audio: true }, layers: [] };
  gc('load-own', 'Loaded own video'); openScene(sc);
}
$('#ownFile').onchange = (e) => { const f = e.target.files[0]; if (f) openOwn(URL.createObjectURL(f), f.name); };
$('#ownUrlForm').onsubmit = (e) => { e.preventDefault(); const u = $('#ownUrl').value.trim(); if (u) openOwn(u, u.split('/').pop()); };

// ---------- loop ----------
function resize() {
  const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  const db = renderer.getDrawingBufferSize(new THREE.Vector2()); bgU.uRes.value.copy(db);
}
addEventListener('resize', resize);
let last = performance.now(), lastSync = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(1, (now - last) / 1000), dt = Math.min(0.1, rawDt); last = now;
  if ($('#player').classList.contains('hidden')) return;
  if (S.playing) {
    if (S.bgMedia && !S.bgMedia.v.paused && S.bgMedia.v.readyState >= 2) S.t = S.bgMedia.v.currentTime + S.bgMedia.start;
    else S.t += rawDt; // real time, so layer start offsets stay in sync even at low frame rates
  }
  if (now - lastSync > 500) { lastSync = now; syncMedia(false); }
  if (Math.abs(camera.fov - S.fov) > 0.01) { camera.fov = S.fov; camera.updateProjectionMatrix(); }
  updateCameraOrientation();
  updateWalk(dt);
  bgSphere.position.copy(camera.position);
  for (const L of S.layers) {
    if (L.cfg.projection === 'equirect') L.mesh.position.copy(camera.position);
    else L.mesh.lookAt(camera.position.x, L.mesh.position.y, camera.position.z);
  }
  renderer.setRenderTarget(null); renderer.clear();
  if (S.walk?.active) {
    renderer.render(S.walk.scene, camera);
  } else {
    if (bgU.uAlphaMode.value === 3) runSeg(now);
    renderer.render(bgScene, camera);
  }
  renderer.render(layerScene, camera);
  if (qs.has('debug')) $('#diag').textContent = `mode ${S.mode} t=${S.t.toFixed(2)} fov ${S.fov.toFixed(0)} motion ${S.motion.active} abs ${S.motion.absolute} seg ${segMs.toFixed(0)}ms`;
}

// ---------- boot ----------
(async () => {
  try {
    const r = await fetch('videos.json', { cache: 'no-cache' });
    S.scenes = (await r.json()).scenes || [];
  } catch (e) { toast('Could not load videos.json'); }
  renderList();
  requestAnimationFrame(frame);
  addEventListener('hashchange', () => {
    const h = location.hash.slice(1); if (!h || h === S.scene?.id) return;
    const s2 = S.scenes.find((s) => s.id === h) || (h === 'splat' && S.scenes.find((s) => s.splat || s.splatSrc));
    if (s2) { disposeScene(); openScene(s2); }
  });
  const want = location.hash.slice(1) || qs.get('scene');
  const sc = want && (S.scenes.find((s) => s.id === want) || (want === 'splat' && S.scenes.find((s) => s.splat || s.splatSrc)));
  if (sc) {
    openScene(sc);
    
  }
})();
