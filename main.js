// main.js — Toilet Sticker (Three.js + Supabase + Lighting + Ambient Sound)

// ========== Imports ==========
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { createClient } from '@supabase/supabase-js';

// ========== Config ==========
const MODEL_URL = '/toilet.glb';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '';
const BUCKET = 'stickers';
const TABLE = 'stickers';

// Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ========== Session & DOM ==========
function getOrCreateSessionId() {
  const k = 'TOILET_SESSION_ID';
  let id = localStorage.getItem(k);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(k, id); }
  return id;
}
const SESSION_ID = getOrCreateSessionId();

const container = document.getElementById('scene');
const statusEl = document.getElementById('status');
const fileInput = document.getElementById('stickerInput');
const sizeRange = document.getElementById('sizeRange');
const rotRange = document.getElementById('rotRange');
const removeBtn = document.getElementById('removeBtn');
const publishBtn = document.getElementById('publishBtn');

// Admin bar
const adminBar = document.getElementById('adminBar');
const adminTitle = document.getElementById('adminTitle');
const adminPassInput = document.getElementById('adminPassword');
const adminEnterBtn = document.getElementById('adminEnter');
const adminLockedRow = document.getElementById('adminLocked');
const adminUnlockedRow = document.getElementById('adminUnlocked');
const adminCloseBtn = document.getElementById('adminClose');
const adminCleanAllBtn = document.getElementById('adminCleanAll');

// Audio toggle (texte)
const audioToggle = document.getElementById('audioToggle');

// ========== Three.js Core ==========
let scene, camera, renderer, controls, modelRoot;
let stickerTexture = null;
let stickerMesh = null;
let stickerScale = parseFloat(sizeRange?.value ?? '0.35');
let stickerRotZ = 0;
let baseQuat = new THREE.Quaternion();
let lastWallNormal = new THREE.Vector3(0, 0, 1);

const LS_KEY = 'toilet-sticker-save';
const liveStickers = new Map();
const textureCache = new Map();

let CLIENT_IP = null;
let fetchIpPromise = null;
function fetchClientIp() {
  if (CLIENT_IP) return Promise.resolve(CLIENT_IP);
  if (fetchIpPromise) return fetchIpPromise;
  fetchIpPromise = fetch('https://api.ipify.org?format=json')
    .then(r => (r.ok ? r.json() : Promise.reject()))
    .then(j => (CLIENT_IP = j.ip || null))
    .catch(() => (CLIENT_IP = null));
  return fetchIpPromise;
}

// ========== Boot ==========
init();
animate();
bootstrapLive().then(updatePublishLabel).catch(console.warn);
fetchClientIp();

// ========== Init ==========
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const w = innerWidth, h = innerHeight;
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 150);
  camera.position.set(0, 1.55, 2.6);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  // Light de base (sera remplacée/boostée)
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.75);
  scene.add(hemi);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.rotateSpeed = 0.55;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  const EPS = 1e-3;
  controls.minPolarAngle = EPS;
  controls.maxPolarAngle = Math.PI - EPS;
  controls.minAzimuthAngle = -Infinity;
  controls.maxAzimuthAngle = Infinity;

  addUIEvents();
  installAdminHotkey();
  installClickToPlace();

  loadModel(); // async (no top-level await)

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

// ========== Model ==========
async function loadModel() {
  status('Loading 3D…');
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  loader.load(
    MODEL_URL,
    async (gltf) => {
      modelRoot = gltf.scene;
      modelRoot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      scene.add(modelRoot);

      // 💡 Boost lumière après ajout du modèle
      await boostLightingPreset();

      centerOrbit(modelRoot);
      status('✅ Ready — pick a file, click a wall, then Publish');
    },
    undefined,
    (e) => { console.error(e); status('❌ Model load error'); }
  );
}

function centerOrbit(root, eyeH = 1.2) {
  const box = new THREE.Box3().setFromObject(root);
  const c = box.getCenter(new THREE.Vector3());
  const floor = findFloorY(root, c, box);
  const ext = new THREE.Vector3().subVectors(box.max, box.min);
  const r = Math.max(ext.x, ext.z) * 0.6;

  controls.target.set(c.x, floor + eyeH, c.z);
  camera.position.set(c.x, floor + eyeH + 0.4, c.z + r);
  controls.minDistance = r * 0.9;
  controls.maxDistance = r * 0.9;
  controls.update();
}

function findFloorY(root, c, box) {
  const from = new THREE.Vector3(c.x, box.max.y + 0.5, c.z);
  const rc = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObjects(root.children, true);
  return hits.length ? hits[0].point.y : box.min.y;
}

// ========== UI Events ==========
function addUIEvents() {
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      new THREE.TextureLoader().load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        stickerTexture = t;
        status('🖼 Sticker ready — click a wall');
        if (!stickerMesh) loadSticker(stickerTexture);
      });
    });
  }

  if (sizeRange) {
    sizeRange.addEventListener('input', () => {
      stickerScale = parseFloat(sizeRange.value);
      if (stickerMesh) { stickerMesh.scale.set(stickerScale, stickerScale, 1); saveSticker(); }
    });
  }

  if (rotRange) {
    rotRange.addEventListener('input', () => {
      stickerRotZ = (parseFloat(rotRange.value) * Math.PI) / 180;
      if (stickerMesh) { applyStickerRotation(); saveSticker(); }
    });
  }

  if (removeBtn) removeBtn.addEventListener('click', removeLocalSticker);
  if (publishBtn) publishBtn.addEventListener('click', publishSticker);

  // Admin
  if (adminEnterBtn) {
    adminEnterBtn.addEventListener('click', () => {
      const v = adminPassInput.value || '';
      if (v === ADMIN_PASSWORD && ADMIN_PASSWORD !== '') { unlockAdminBar(); }
      else { alert('Wrong password'); }
    });
  }
  if (adminCloseBtn) adminCloseBtn.addEventListener('click', () => lockAdminBar(true));
  if (adminCleanAllBtn) adminCleanAllBtn.addEventListener('click', deleteAllStickers);
}

// Click vs drag
function installClickToPlace() {
  let movedSinceDown = false;
  renderer.domElement.addEventListener('pointerdown', () => { movedSinceDown = false; });
  controls.addEventListener('change', () => { movedSinceDown = true; });
  renderer.domElement.addEventListener('click', (e) => {
    if (movedSinceDown) return;
    tryPlaceStickerFromPointer(e);
  });
}

// ========== Placement Sticker ==========
function tryPlaceStickerFromPointer(ev) {
  if (!stickerTexture || !modelRoot) return;

  const rect = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );

  const ray = new THREE.Raycaster();
  ray.setFromCamera(mouse, camera);
  const hits = ray.intersectObjects([modelRoot], true);
  if (!hits.length) return;

  const hit = hits[0];
  let n = new THREE.Vector3(0, 0, 1);
  if (hit.face?.normal) {
    n.copy(hit.face.normal);
    hit.object.updateMatrixWorld();
    n.transformDirection(hit.object.matrixWorld).normalize();
  }
  if (Math.abs(n.y) > 0.6) { status('⛔ Place on a wall'); return; }
  n = snappedWallNormal(n);

  const EPS = 0.006;
  const p = hit.point.clone().add(n.clone().multiplyScalar(EPS));
  lastWallNormal.copy(n);

  placeOrMoveSticker(p, n);
  saveSticker();
}

function snappedWallNormal(n) {
  const v = n.clone(); v.y = 0;
  if (v.lengthSq() < 1e-6) return new THREE.Vector3(0, 0, 1);
  v.normalize();
  return Math.abs(v.x) > Math.abs(v.z)
    ? new THREE.Vector3(Math.sign(v.x) || 1, 0, 0)
    : new THREE.Vector3(0, 0, Math.sign(v.z) || 1);
}

function makeStickerQuaternion(normal) {
  const n = normal.clone().normalize();
  const worldUp = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const tangent = worldUp.clone().cross(n).normalize();
  const bitangent = n.clone().cross(tangent).normalize();
  const m = new THREE.Matrix4().makeBasis(tangent, bitangent, n);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function createStickerMeshFromTexture(tex) {
  const img = tex.image;
  const ratio = img ? img.width / img.height : 1;
  const geom = new THREE.PlaneGeometry(1 * ratio, 1);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  return new THREE.Mesh(geom, mat);
}

function placeOrMoveSticker(point, normal) {
  if (stickerMesh) {
    scene.remove(stickerMesh);
    stickerMesh.geometry?.dispose();
    stickerMesh.material?.dispose();
  }
  stickerMesh = createStickerMeshFromTexture(stickerTexture);
  stickerMesh.position.copy(point);
  stickerMesh.scale.set(stickerScale, stickerScale, 1);
  baseQuat = makeStickerQuaternion(normal);
  stickerMesh.quaternion.copy(baseQuat);
  applyStickerRotation();
  scene.add(stickerMesh);
  status('Sticker placed ✓ — Publish to share');
}

function applyStickerRotation() {
  if (!stickerMesh) return;
  stickerMesh.quaternion.copy(baseQuat);
  stickerMesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), stickerRotZ);
}

function saveSticker() {
  if (!stickerMesh) return;
  const d = {
    position: stickerMesh.position.toArray(),
    quaternion: stickerMesh.quaternion.toArray(),
    baseQuat: baseQuat.toArray(),
    scale: stickerScale,
    rotZ: stickerRotZ,
    axis: lastWallNormal?.toArray?.() || [0, 0, 1]
  };
  localStorage.setItem(LS_KEY, JSON.stringify(d));
}

function loadSticker(texture) {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw || !texture) return;
  try {
    const d = JSON.parse(raw);
    stickerMesh = createStickerMeshFromTexture(texture);
    stickerMesh.position.fromArray(d.position);
    stickerScale = d.scale ?? 0.35; if (sizeRange) sizeRange.value = String(stickerScale);
    stickerRotZ = d.rotZ ?? 0; if (rotRange) rotRange.value = String((stickerRotZ * 180) / Math.PI);
    stickerMesh.scale.set(stickerScale, stickerScale, 1);
    if (d.baseQuat) { baseQuat.fromArray(d.baseQuat); applyStickerRotation(); }
    else {
      const qF = new THREE.Quaternion().fromArray(d.quaternion);
      const qR = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), stickerRotZ);
      baseQuat.copy(qF).multiply(qR.invert()); applyStickerRotation();
    }
    if (d.axis) lastWallNormal.fromArray(d.axis);
    scene.add(stickerMesh);
  } catch (e) { console.warn('Load sticker error', e); }
}

function removeLocalSticker() {
  if (stickerMesh) {
    scene.remove(stickerMesh);
    stickerMesh.geometry?.dispose();
    stickerMesh.material?.dispose();
    stickerMesh = null;
  }
  localStorage.removeItem(LS_KEY);
  status('Sticker removed (local)');
}

// ========== Publish ==========
async function publishSticker() {
  if (!stickerMesh || !fileInput?.files?.[0]) { status('⚠️ Pick a file and place it first'); return; }
  try {
    lockPublish(false);
    status('Uploading…');

    const ip = await fetchClientIp();
    const file = fileInput.files[0];
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `users/${SESSION_ID}/${Date.now()}.${ext}`;

    const up = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type });
    if (up.error) throw up.error;

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const image_url = pub.publicUrl;

    const row = {
      session_id: SESSION_ID,
      client_ip: ip,
      image_url,
      position: stickerMesh.position.toArray(),
      quaternion: stickerMesh.quaternion.toArray(),
      scale: stickerScale,
      rotz: stickerRotZ,
      axis: lastWallNormal ? lastWallNormal.toArray() : [0, 0, 1]
    };

    const ins = await supabase.from(TABLE).insert(row);
    if (ins.error) throw ins.error;

    status('✅ Published');
    await updatePublishLabel();
  } catch (e) {
    console.error(e);
    const m = String(e?.message || e);
    if (m.includes('violates row-level security') || m.includes('quota_ok')) status('⛔ Limit reached: 2 stickers / 24h');
    else if (m.includes('Bucket')) status('⛔ Storage policy issue');
    else if (m.includes('JWT') || m.includes('Unauthorized')) status('❌ Auth (check VITE_SUPABASE_URL / VITE_SUPABASE_ANON)');
    else status('❌ Publish error');
    cooldownPublish();
  } finally {
    lockPublish(true);
  }
}

// ========== Live ==========
async function bootstrapLive() {
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at', { ascending: true }).limit(500);
  if (!error && Array.isArray(data)) data.forEach(addLiveFromRow);

  supabase
    .channel('stickers-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE }, (payload) => {
      addLiveFromRow(payload.new);
      if (payload.new?.session_id === SESSION_ID) updatePublishLabel();
    })
    .subscribe();
}

function addLiveFromRow(row) {
  if (!row?.id || liveStickers.has(row.id)) return;
  loadTex(row.image_url, (tex) => {
    const g = new THREE.PlaneGeometry(1, 1);
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    const mesh = new THREE.Mesh(g, m);
    mesh.position.fromArray(row.position);
    mesh.quaternion.fromArray(row.quaternion);
    const sc = row.scale ?? 0.35;
    mesh.scale.set(sc, sc, 1);
    scene.add(mesh);
    liveStickers.set(row.id, mesh);
  });
}

// ========== Admin Purge ==========
async function deleteAllStickers() {
  if (!confirm('Delete ALL stickers for everyone?')) return;
  try {
    const del = await supabase.from(TABLE).delete().not('id', 'is', null);
    if (del.error) throw del.error;

    const keys = await listAllStorageKeysRecursive('');
    while (keys.length) {
      const chunk = keys.splice(0, 100);
      const rem = await supabase.storage.from(BUCKET).remove(chunk);
      if (rem.error) throw rem.error;
    }

    liveStickers.forEach(mesh => scene.remove(mesh));
    liveStickers.clear();
    status('💥 All stickers purged');
  } catch (e) {
    console.error('deleteAllStickers error:', e);
    status('❌ Error purging all stickers');
  }
}

async function listAllStorageKeysRecursive(prefix) {
  const all = [];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) throw error;

  for (const item of data || []) {
    const full = prefix ? `${prefix}/${item.name}` : item.name;
    // Heuristique fichier/dossier (SDK v2)
    if (item && item.metadata && typeof item.metadata.size === 'number') {
      all.push(full); // fichier
    } else if (item && item.name) {
      const sub = await listAllStorageKeysRecursive(full); // dossier
      all.push(...sub);
    }
  }
  return all;
}

// ========== Admin Bar ==========
let adminOpen = false;
let adminUnlocked = false;

function installAdminHotkey() {
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'a' && e.shiftKey) toggleAdminBar();
  });
}
function toggleAdminBar() {
  adminOpen = !adminOpen;
  adminBar.setAttribute('aria-hidden', adminOpen ? 'false' : 'true');
  if (adminOpen) { if (adminUnlocked) showAdminUnlocked(); else showAdminLocked(); }
}
function lockAdminBar(hide = false) {
  adminUnlocked = false;
  adminTitle.textContent = 'Admin';
  adminLockedRow.hidden = false;
  adminUnlockedRow.hidden = true;
  if (hide) { adminOpen = false; adminBar.setAttribute('aria-hidden', 'true'); }
}
function unlockAdminBar() { adminUnlocked = true; showAdminUnlocked(); }
function showAdminLocked() {
  adminTitle.textContent = 'Admin';
  adminLockedRow.hidden = false;
  adminUnlockedRow.hidden = true;
  adminPassInput.value = ''; adminPassInput.focus();
}
function showAdminUnlocked() {
  adminTitle.textContent = 'Admin connected';
  adminLockedRow.hidden = true;
  adminUnlockedRow.hidden = false;
}

// ========== Helpers ==========
function loadTex(url, cb) {
  if (textureCache.has(url)) { cb(textureCache.get(url)); return; }
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textureCache.set(url, t);
    cb(t);
  });
}
function status(txt) { if (statusEl) statusEl.textContent = txt; }

async function getTodayCount() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await supabase.from(TABLE).select('id', { count: 'exact', head: true }).gte('created_at', since).eq('session_id', SESSION_ID);
  return res?.count ?? 0;
}
async function updatePublishLabel() {
  try {
    const c = await getTodayCount();
    if (!publishBtn) return;
    if (c >= 2) {
      publishBtn.textContent = 'Blocked';
      publishBtn.disabled = true;
      publishBtn.style.opacity = 0.5;
      publishBtn.style.cursor = 'not-allowed';
    } else {
      publishBtn.textContent = `Publish ${c}/2`;
      publishBtn.disabled = false;
      publishBtn.style.opacity = 1;
      publishBtn.style.cursor = 'pointer';
    }
  } catch (e) { console.warn('updatePublishLabel error', e); }
}
function lockPublish(enabled) { if (publishBtn) publishBtn.disabled = !enabled; }
function cooldownPublish() {
  if (!publishBtn) return;
  if (publishBtn.textContent === 'Blocked') return;
  publishBtn.disabled = true;
  let t = 10;
  const iv = setInterval(() => {
    publishBtn.textContent = `Retry in ${t}s`;
    if (--t <= 0) { clearInterval(iv); updatePublishLabel(); publishBtn.disabled = false; }
  }, 1000);
}

// ========== Lighting Boost Preset ==========
async function boostLightingPreset() {
  // Renderer tuning
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.9;
  renderer.physicallyCorrectLights = true;

  // Remove any previous helpers/lights if needed (optional)

  // 3-point lighting
  const hemi = new THREE.HemisphereLight(0xffffff, 0x1a1a1a, 0.8);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3.5, 6, 2.0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 2;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(-4.0, 3.0, -1.5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(0, 5, -4);
  scene.add(rim);

  // Optional: Environment map (place /public/env.hdr)
  // await loadEnvHDR();

  // Boost env reflection on PBR materials
  if (modelRoot) {
    modelRoot.traverse(o => {
      if (o.isMesh && o.material?.isMeshStandardMaterial) {
        o.material.envMapIntensity = 1.5;
        o.material.needsUpdate = true;
      }
    });
  }
}

async function loadEnvHDR() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const hdr = await new RGBELoader().loadAsync('/env.hdr');
  const envMap = pmrem.fromEquirectangular(hdr).texture;
  scene.environment = envMap;
  // scene.background = envMap; // si tu veux voir le HDR
  hdr.dispose(); pmrem.dispose();
}

// ========== Ambient Sound (text button "Mute/Unmute") ==========
let ambientAudio;
const LS_AUDIO_KEY = 'toilet-audio-muted';
const AUDIO_SRC = `${import.meta.env.BASE_URL || '/'}ambient.mp3`;
// Par défaut: unmuted (son actif)
let desiredMuted = (localStorage.getItem(LS_AUDIO_KEY) ?? 'false') === 'true';

function updateAudioIcon(muted) {
  if (audioToggle) audioToggle.textContent = muted ? 'Unmute' : 'Mute';
}
function tryPlayAudio() {
  if (!ambientAudio) return;
  ambientAudio.play().catch(() => {
    const unlock = () => {
      ambientAudio.play().finally(() => {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
        window.removeEventListener('touchstart', unlock);
      });
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    window.addEventListener('touchstart', unlock, { once: true, passive: true });
  });
}
function initAmbient() {
  ambientAudio = new Audio(AUDIO_SRC);
  ambientAudio.loop = true;
  ambientAudio.preload = 'auto';
  ambientAudio.volume = 0.25;
  ambientAudio.muted = desiredMuted; // false par défaut => audible
  updateAudioIcon(desiredMuted);
  tryPlayAudio();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ambientAudio && !ambientAudio.muted) { tryPlayAudio(); }
  });
}
if (audioToggle) {
  audioToggle.addEventListener('click', () => {
    if (!ambientAudio) return;
    ambientAudio.muted = !ambientAudio.muted;
    localStorage.setItem(LS_AUDIO_KEY, String(ambientAudio.muted));
    updateAudioIcon(ambientAudio.muted);
    if (!ambientAudio.muted) tryPlayAudio();
  });
}
window.addEventListener('DOMContentLoaded', initAmbient);

// ========== Animate ==========
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
