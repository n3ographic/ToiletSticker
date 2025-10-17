// main.js — Toilet Sticker (Three.js + Supabase)
// Orbit 360°, collage au click simple, ratio image respecté,
// Publish limité 2/24h (RLS), live realtime, Admin bar (Shift+A) clean all.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { createClient } from '@supabase/supabase-js';

// ---------------- CONFIG ----------------
const MODEL_URL = '/toilet.glb';
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '';
const BUCKET = 'stickers';
const TABLE = 'stickers';

// Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ---------------- SESSION / DOM ----------------
function getOrCreateSessionId() {
  const k = 'TOILET_SESSION_ID';
  let id = localStorage.getItem(k);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(k, id);
  }
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

// Admin footer bar (Shift + A)
const adminBar = document.getElementById('adminBar');
const adminTitle = document.getElementById('adminTitle');
const adminPassInput = document.getElementById('adminPassword');
const adminEnterBtn = document.getElementById('adminEnter');
const adminLockedRow = document.getElementById('adminLocked');
const adminUnlockedRow = document.getElementById('adminUnlocked');
const adminCloseBtn = document.getElementById('adminClose');
const adminCleanAllBtn = document.getElementById('adminCleanAll');

// ---------------- Three.js ----------------
let scene, camera, renderer, controls, modelRoot;
let stickerTexture = null;
let stickerMesh = null;
let stickerScale = parseFloat(sizeRange?.value ?? '0.35');
let stickerRotZ = 0;
let baseQuat = new THREE.Quaternion();

// garde l’axe du mur pour la colonne `axis`
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
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((j) => {
      CLIENT_IP = j.ip || null;
      return CLIENT_IP;
    })
    .catch(() => {
      CLIENT_IP = null;
      return CLIENT_IP;
    });
  return fetchIpPromise;
}

// ---------------- Boot ----------------
init();
animate();
bootstrapLive()
  .then(updatePublishLabel)
  .catch(console.warn);
fetchClientIp();

// ===========================================================
function init() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const w = innerWidth;
  const h = innerHeight;
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 150);
  camera.position.set(0, 1.55, 2.6);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9);
  hemi.position.set(0, 4, 0);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 1.3);
  dir.position.set(3.5, 6, 2.2);
  dir.castShadow = true;
  scene.add(dir);

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

  loadModel();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
}

function loadModel() {
  status('Loading 3D…');
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);

  loader.load(
    MODEL_URL,
    (gltf) => {
      modelRoot = gltf.scene;
      modelRoot.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      scene.add(modelRoot);
      centerOrbit(modelRoot);
      status('✅ Ready — pick a file, click a wall, then Publish');
    },
    undefined,
    (e) => {
      console.error(e);
      status('❌ Model load error');
    }
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

// ===========================================================
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
      if (stickerMesh) {
        stickerMesh.scale.set(stickerScale, stickerScale, 1);
        saveSticker();
      }
    });
  }

  if (rotRange) {
    rotRange.addEventListener('input', () => {
      stickerRotZ = (parseFloat(rotRange.value) * Math.PI) / 180;
      if (stickerMesh) {
        applyStickerRotation();
        saveSticker();
      }
    });
  }

  if (removeBtn) removeBtn.addEventListener('click', removeLocalSticker);
  if (publishBtn) publishBtn.addEventListener('click', publishSticker);

  // Admin bar actions
  if (adminEnterBtn) {
    adminEnterBtn.addEventListener('click', () => {
      const v = adminPassInput.value || '';
      if (v === ADMIN_PASSWORD && ADMIN_PASSWORD !== '') {
        unlockAdminBar();
      } else {
        alert('Wrong password');
      }
    });
  }
  if (adminCloseBtn) adminCloseBtn.addEventListener('click', () => lockAdminBar(true));
  if (adminCleanAllBtn) adminCleanAllBtn.addEventListener('click', deleteAllStickers);
}

// ---------------- Collage au click simple robuste ----------------
function installClickToPlace() {
  let movedSinceDown = false;

  renderer.domElement.addEventListener('pointerdown', () => {
    movedSinceDown = false;
  });

  controls.addEventListener('change', () => {
    movedSinceDown = true;
  });

  renderer.domElement.addEventListener('click', (e) => {
    if (movedSinceDown) return; // drag → ignore
    tryPlaceStickerFromPointer(e); // click simple → colle
  });
}

// ===========================================================
// PLACE
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
  if (Math.abs(n.y) > 0.6) {
    status('⛔ Place on a wall');
    return;
  }
  n = snappedWallNormal(n);

  const EPS = 0.006;
  const p = hit.point.clone().add(n.clone().multiplyScalar(EPS));

  // mémorise l’axe du mur pour la colonne `axis`
  lastWallNormal.copy(n);

  placeOrMoveSticker(p, n);
  saveSticker();
}

function snappedWallNormal(n) {
  const v = n.clone();
  v.y = 0;
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
    stickerScale = d.scale ?? 0.35;
    if (sizeRange) sizeRange.value = String(stickerScale);
    stickerRotZ = d.rotZ ?? 0;
    if (rotRange) rotRange.value = String((stickerRotZ * 180) / Math.PI);
    stickerMesh.scale.set(stickerScale, stickerScale, 1);
    if (d.baseQuat) {
      baseQuat.fromArray(d.baseQuat);
      applyStickerRotation();
    } else {
      const qF = new THREE.Quaternion().fromArray(d.quaternion);
      const qR = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), stickerRotZ);
      baseQuat.copy(qF).multiply(qR.invert());
      applyStickerRotation();
    }
    if (d.axis) lastWallNormal.fromArray(d.axis);
    scene.add(stickerMesh);
  } catch (e) {
    console.warn('Load sticker error', e);
  }
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

// ===========================================================
// PUBLISH (limité par RLS 2/24h)
async function publishSticker() {
  if (!stickerMesh || !fileInput?.files?.[0]) {
    status('⚠️ Pick a file and place it first');
    return;
  }
  try {
    lockPublish(false);
    status('Uploading…');

    const ip = await fetchClientIp();
    const file = fileInput.files[0];
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = `users/${SESSION_ID}/${Date.now()}.${ext}`;

    const up = await supabase.storage.from(BUCKET).upload(path, file, {
      upsert: true,
      contentType: file.type
    });
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
    if (m.includes('violates row-level security') || m.includes('quota_ok')) {
      status('⛔ Limit reached: 2 stickers / 24h');
    } else if (m.includes('Bucket')) {
      status('⛔ Storage policy issue');
    } else if (m.includes('JWT') || m.includes('Unauthorized')) {
      status('❌ Auth (check VITE_SUPABASE_URL / VITE_SUPABASE_ANON)');
    } else {
      status('❌ Publish error');
    }
    cooldownPublish();
  } finally {
    lockPublish(true);
  }
}

// ===========================================================
// LIVE
async function bootstrapLive() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: true })
    .limit(500);

  if (!error && Array.isArray(data)) {
    data.forEach(addLiveFromRow);
  }

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

// ===========================================================
// CLEAN ALL (admin) — DB + Storage récursif
async function deleteAllStickers() {
  if (!confirm('Delete ALL stickers for everyone?')) return;
  try {
    // 1) Delete DB
    const del = await supabase.from(TABLE).delete().not('id', 'is', null);
    if (del.error) throw del.error;

    // 2) Purge Storage récursive
    const keys = await listAllStorageKeysRecursive('');
    while (keys.length) {
      const chunk = keys.splice(0, 100);
      const rem = await supabase.storage.from(BUCKET).remove(chunk);
      if (rem.error) throw rem.error;
    }

    // 3) Reset scène
    liveStickers.forEach((mesh) => scene.remove(mesh));
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
    // Dans Supabase Storage SDK v2, les dossiers n’ont pas d’extension, on détecte via metadata
    if (item && item.name && item.metadata && item.metadata.size >= 0) {
      // fichier
      all.push(full);
    } else if (item && item.name) {
      // dossier
      const sub = await listAllStorageKeysRecursive(full);
      all.push(...sub);
    }
  }
  return all;
}

// ===========================================================
// ADMIN BAR (Shift + A)
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
  if (adminOpen) {
    if (adminUnlocked) showAdminUnlocked();
    else showAdminLocked();
  }
}
function lockAdminBar(hide = false) {
  adminUnlocked = false;
  adminTitle.textContent = 'Admin';
  adminLockedRow.hidden = false;
  adminUnlockedRow.hidden = true;
  if (hide) {
    adminOpen = false;
    adminBar.setAttribute('aria-hidden', 'true');
  }
}
function unlockAdminBar() {
  adminUnlocked = true;
  showAdminUnlocked();
}
function showAdminLocked() {
  adminTitle.textContent = 'Admin';
  adminLockedRow.hidden = false;
  adminUnlockedRow.hidden = true;
  adminPassInput.value = '';
  adminPassInput.focus();
}
function showAdminUnlocked() {
  adminTitle.textContent = 'Admin connected';
  adminLockedRow.hidden = true;
  adminUnlockedRow.hidden = false;
}

// ===========================================================
// Helpers
function loadTex(url, cb) {
  if (textureCache.has(url)) {
    cb(textureCache.get(url));
    return;
  }
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textureCache.set(url, t);
    cb(t);
  });
}
function status(txt) {
  if (statusEl) statusEl.textContent = txt;
}

// Compte le nombre de stickers publiés par cette session sur 24h glissantes
async function getTodayCount() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const res = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .eq('session_id', SESSION_ID);
  return res?.count ?? 0;
}

// Met à jour le label + état du bouton Publish
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
  } catch (e) {
    console.warn('updatePublishLabel error', e);
  }
}

function lockPublish(enabled) {
  if (publishBtn) publishBtn.disabled = !enabled;
}

// Petit cooldown lorsqu’un publish échoue
function cooldownPublish() {
  if (!publishBtn) return;
  if (publishBtn.textContent === 'Blocked') return;
  publishBtn.disabled = true;
  let t = 10;
  const iv = setInterval(() => {
    publishBtn.textContent = `Retry in ${t}s`;
    if (--t <= 0) {
      clearInterval(iv);
      updatePublishLabel();
      publishBtn.disabled = false;
    }
  }, 1000);
}

// ===========================================================
// 🔊 AMBIENT SOUND (loop + mute toggle)
let audio, audioCtx;
const audioToggle = document.getElementById('audioToggle');
const LS_AUDIO_KEY = 'toilet-audio-muted';

// Charger le son dès que la scène est prête
function initAmbientSound() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  audio = new Audio('/public/ambient.mp3'); // <- mets ton son ici
  audio.loop = true;
  audio.volume = 0.25;
  const track = audioCtx.createMediaElementSource(audio);
  track.connect(audioCtx.destination);

  const muted = localStorage.getItem(LS_AUDIO_KEY) === 'true';
  if (!muted) {
    audio.play().catch(() => {});
  }
  updateAudioIcon(muted);
}

// Basculer mute / unmute
function toggleAudio() {
  const muted = localStorage.getItem(LS_AUDIO_KEY) === 'true';
  const newMuted = !muted;
  localStorage.setItem(LS_AUDIO_KEY, String(newMuted));
  updateAudioIcon(newMuted);

  if (newMuted) {
    audio.pause();
  } else {
    audio.play().catch(() => {});
  }
}

// Met à jour l'icône du bouton
function updateAudioIcon(muted) {
  if (!audioToggle) return;
  audioToggle.textContent = muted ? '🔇' : '🔊';
}

// Événement bouton
if (audioToggle) {
  audioToggle.addEventListener('click', toggleAudio);
}

// Lancer après init
window.addEventListener('DOMContentLoaded', () => {
  // Certains navigateurs bloquent l’autoplay → le démarrage au premier clic
  setTimeout(() => {
    initAmbientSound();
  }, 1500);
});

// ===========================================================
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
