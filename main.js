// -------- imports -------------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader }  from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { createClient } from '@supabase/supabase-js';

// -------- env / constants ----------------------------------------
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
const SUPABASE_BUCKET = import.meta.env.VITE_SUPABASE_BUCKET || 'stickers';
const ADMIN_PASSWORD = (import.meta.env.VITE_ADMIN_PASS ?? '').trim();

// table
const TABLE = 'stickers';

// model path (mets ton GLB sous /public)
const MODEL_URL = '/toilet.glb';

// decoder Draco (mets les fichiers draco dans /public/draco/)
const DRACO_PATH = '/draco/';

// canvas & UI
const canvas     = document.getElementById('c');
const fileInput  = document.getElementById('file');
const sizeRange  = document.getElementById('size');
const rotRange   = document.getElementById('rotation');
const removeBtn  = document.getElementById('remove');
const publishBtn = document.getElementById('publish');
const statusEl   = document.getElementById('status');

// admin UI
const adminForm     = document.getElementById('adminForm');
const adminPass     = document.getElementById('adminPassword');
const adminEnter    = document.getElementById('adminEnter');
const adminBar      = document.getElementById('adminBar');
const adminCloseBtn = document.getElementById('adminClose');
const adminCleanBtn = document.getElementById('adminClean');

// sessions
const SESSION_ID = (() => {
  const k = 'toilet.session';
  let v = localStorage.getItem(k);
  if (!v) { v = crypto.randomUUID(); localStorage.setItem(k, v); }
  return v;
})();
let CLIENT_IP = null;

// supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: false },
});

// local state
let renderer, scene, camera, controls;
let room, raycaster, mouseNDC = new THREE.Vector2();
let stickerMesh = null;
let stickerTexture = null;
let stickerScale = parseFloat(sizeRange.value);
let stickerRotZ = 0;
let dragging = false;
let adminUnlocked = false;

const baseQuat = new THREE.Quaternion(); // orientation de ref au moment du collage
const lastWallNormal = new THREE.Vector3(0, 0, 1);
const textureCache = new Map();

const LS_KEY = 'toilet.preview.image';

// -------- helpers UI ---------------------------------------------
function status(msg) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.opacity = 1;
  clearTimeout(status._t);
  status._t = setTimeout(() => statusEl.style.opacity = 0, 2500);
}

function lockPublish(enabled) {
  if (!publishBtn) return;
  publishBtn.disabled = !enabled;
  publishBtn.style.opacity = enabled ? 1 : 0.5;
  publishBtn.style.cursor  = enabled ? 'pointer' : 'not-allowed';
}

function cooldownPublish(ms=1200) {
  if (!publishBtn) return;
  publishBtn.disabled = true;
  publishBtn.style.opacity = 0.5;
  setTimeout(() => updatePublishLabel(), ms);
}

function loadTex(url, onLoad) {
  if (textureCache.has(url)) return onLoad(textureCache.get(url));
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    textureCache.set(url, t);
    onLoad(t);
  });
}

// -------- init 3D -------------------------------------------------
init();
async function init() {
  // renderer
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  // scene & camera
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 100);
  camera.position.set(0.2, 1.55, 0.2);
  scene.add(camera);

  // lights
  const amb = new THREE.AmbientLight(0xffffff, 0.9);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff, 0.25);
  dir.position.set(1.5, 2.5, 1.2);
  scene.add(dir);

  // controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.1;
  controls.maxDistance = 2.2;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI; // 360 vertical
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.8;
  controls.target.set(0, 1.4, 0); // centre approximatif de la cabine

  // raycaster
  raycaster = new THREE.Raycaster();

  // load GLB
  await loadRoom();

  // events
  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointerdown', () => dragging = false, { passive: true });
  canvas.addEventListener('pointermove', () => { dragging = true; }, { passive: true });
  canvas.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKey);

  sizeRange.addEventListener('input', () => {
    stickerScale = parseFloat(sizeRange.value);
    if (stickerMesh) stickerMesh.scale.setScalar(stickerScale);
  });
  rotRange.addEventListener('input', () => {
    stickerRotZ = THREE.MathUtils.degToRad(parseFloat(rotRange.value));
    if (stickerMesh) stickerMesh.rotation.z = stickerRotZ;
  });

  fileInput.addEventListener('change', onChooseFile);
  removeBtn.addEventListener('click', removeLocalSticker);
  publishBtn.addEventListener('click', onPublish);

  // admin form
  if (adminForm) {
    adminForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (adminPass?.value ?? '').trim();
      if (!ADMIN_PASSWORD) { alert('No admin password configured.'); return; }
      if (v === ADMIN_PASSWORD) unlockAdminBar();
      else alert('❌ Wrong password');
    });
  }
  adminCloseBtn?.addEventListener('click', () => lockAdminBar());
  adminCleanBtn?.addEventListener('click', onAdminCleanAll);

  // ip
  try { await fetchClientIp(); } catch {}

  // label
  await updatePublishLabel();

  // preview si image stockée
  const dataUrl = localStorage.getItem(LS_KEY);
  if (dataUrl) createStickerPreviewFromDataURL(dataUrl);

  animate();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

async function loadRoom() {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath(DRACO_PATH);
  loader.setDRACOLoader(draco);

  return new Promise((res, rej) => {
    loader.load(MODEL_URL, (gltf) => {
      room = gltf.scene;
      room.traverse((o) => {
        if (o.isMesh) {
          o.material.side = THREE.DoubleSide;
          o.material.depthWrite = true;
          o.castShadow = false;
          o.receiveShadow = true;
        }
      });
      scene.add(room);
      res();
    }, undefined, rej);
  });
}

// -------- Orbit vs Click (collage) -------------------------------
function onPointerUp(e) {
  // s’il y a eu une rotation (drag), ne colle pas
  if (dragging) return;

  // pas d’image chargée
  if (!stickerMesh) { status('Choose an image first.'); return; }

  // raycast vers les murs
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouseNDC, camera);
  const hits = raycaster.intersectObject(room, true);
  if (!hits.length) return;

  const hit = hits[0];
  const p = hit.point.clone();
  const n = hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld) || new THREE.Vector3(0,0,1);

  // Orienter sticker vers la normale (plan du mur)
  // baseQuat = rotation qui aligne Z local sur la normale du mur
  const zAxis = new THREE.Vector3(0,0,1);
  const q = new THREE.Quaternion().setFromUnitVectors(zAxis, n);
  baseQuat.copy(q);
  lastWallNormal.copy(n);

  // Appliquer base + rotation Z utilisateur
  const zRot = new THREE.Quaternion().setFromAxisAngle(zAxis, stickerRotZ);
  const finalQ = q.clone().multiply(zRot);

  stickerMesh.position.copy(p);
  stickerMesh.quaternion.copy(finalQ);
  stickerMesh.scale.setScalar(stickerScale);

  status('Sticker placed (preview).');
}

// -------- Image → preview plane (respect ratio) -------------------
function onChooseFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataURL = reader.result;
    localStorage.setItem(LS_KEY, dataURL);
    createStickerPreviewFromDataURL(dataURL);
  };
  reader.readAsDataURL(file);
}

function createStickerPreviewFromDataURL(dataUrl) {
  // Crée une texture pour inspecter width/height
  const img = new Image();
  img.onload = () => {
    const ratio = img.width / img.height;
    const w = 0.5; // base width plane
    const h = w / ratio;

    const g = new THREE.PlaneGeometry(w, h);
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;

    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
    if (stickerMesh) scene.remove(stickerMesh);
    stickerMesh = new THREE.Mesh(g, m);
    stickerMesh.scale.setScalar(stickerScale);
    scene.add(stickerMesh);

    // petite avance devant la camera pour prévisualiser
    const ahead = camera.getWorldDirection(new THREE.Vector3());
    stickerMesh.position.copy(camera.position).add(ahead.multiplyScalar(0.6));
    stickerMesh.quaternion.copy(new THREE.Quaternion()); // face caméra au début
    stickerRotZ = 0;
    rotRange.value = '0';

    status('Image loaded. Click a wall to stick.');
  };
  img.src = dataUrl;
}

// -------- Publish -------------------------------------------------
async function onPublish() {
  try {
    // Vérifie quota
    const c = await getTodayCount();
    if (c >= 2) {
      status('🚫 Limit reached: 2 stickers / 24h');
      await updatePublishLabel();
      return;
    }

    if (!stickerMesh || !stickerMesh.material?.map) {
      status('No sticker to publish.');
      return;
    }

    // 1) uploader l’image au storage
    const dataUrl = localStorage.getItem(LS_KEY);
    if (!dataUrl) { status('Missing image data.'); return; }

    // DataURL → Blob
    const blob = await (await fetch(dataUrl)).blob();
    const fileName = `${SESSION_ID}/${crypto.randomUUID()}.webp`;
    const up = await supabase.storage.from(SUPABASE_BUCKET).upload(fileName, blob, {
      contentType: 'image/webp',
      upsert: false
    });
    if (up.error) throw up.error;

    const pub = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName);
    const image_url = pub.data.publicUrl;

    // 2) position/orientations/scales
    const pos = [stickerMesh.position.x, stickerMesh.position.y, stickerMesh.position.z];
    const quat = [stickerMesh.quaternion.x, stickerMesh.quaternion.y, stickerMesh.quaternion.z, stickerMesh.quaternion.w];
    const bq   = [baseQuat.x, baseQuat.y, baseQuat.z, baseQuat.w];
    const axis = [0, 0, 1];
    const rotz = THREE.MathUtils.radToDeg(stickerRotZ);

    // 3) insert
    const ins = await supabase.from(TABLE).insert({
      session_id: SESSION_ID,
      client_ip : CLIENT_IP,
      image_url,
      position  : pos,
      quaternion: quat,
      base_quat : bq,
      scale     : stickerScale,
      axis,
      rotz
    }).select('id');

    if (ins.error) {
      console.error(ins.error);
      status('❌ Publish error');
      return;
    }

    // clear preview local
    removeLocalSticker();

    status('✅ Published!');
    cooldownPublish();
  } catch (e) {
    console.error(e);
    status('❌ Publish failed');
  }
}

// -------- Quota (2 / 24h) ----------------------------------------
async function fetchClientIp() {
  try {
    const r = await fetch('https://api.ipify.org?format=json');
    const j = await r.json();
    CLIENT_IP = j?.ip ?? null;
  } catch { CLIENT_IP = null; }
}

async function getTodayCount() {
  const since = new Date(Date.now() - 24*60*60*1000).toISOString();

  if (CLIENT_IP) {
    const r = await supabase
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .eq('client_ip', CLIENT_IP);
    if (!r.error && typeof r.count === 'number') return r.count;
  }

  const r2 = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .eq('session_id', SESSION_ID);

  return r2?.count ?? 0;
}

async function updatePublishLabel() {
  try {
    if (!CLIENT_IP) { try { await fetchClientIp(); } catch {} }
    const c = await getTodayCount();
    if (!publishBtn) return;

    if (c >= 2) {
      publishBtn.textContent = 'Blocked';
      publishBtn.disabled = true;
      publishBtn.style.opacity = 0.5;
      publishBtn.style.cursor  = 'not-allowed';
      return;
    }
    publishBtn.textContent = `Publish ${c}/2`;
    publishBtn.disabled = false;
    publishBtn.style.opacity = 1;
    publishBtn.style.cursor  = 'pointer';
  } catch {
    publishBtn.textContent = 'Publish';
    publishBtn.disabled = false;
    publishBtn.style.opacity = 1;
    publishBtn.style.cursor  = 'pointer';
  }
}

// -------- Remove preview -----------------------------------------
function removeLocalSticker() {
  try {
    if (stickerMesh) {
      scene.remove(stickerMesh);
      stickerMesh.geometry?.dispose?.();
      stickerMesh.material?.dispose?.();
      stickerMesh = null;
    }
    stickerTexture = null;
    baseQuat.identity();
    lastWallNormal.set(0,0,1);
    localStorage.removeItem(LS_KEY);

    if (fileInput) fileInput.value = '';
    if (sizeRange) sizeRange.value = (sizeRange.min ?? 0.35);
    if (rotRange)  rotRange.value  = 0;
    stickerScale = parseFloat(sizeRange?.value ?? '0.35');
    stickerRotZ  = 0;

    status('🧽 Preview cleared');
    updatePublishLabel();
  } catch (e) {
    console.error('removeLocalSticker error:', e);
    status('❌ Clear error');
  }
}
// exposer pour onclick inline si jamais
window.removeLocalSticker = removeLocalSticker;

// -------- Admin ---------------------------------------------------
function onKey(e) {
  if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
    openAdminForm();
  }
}
function openAdminForm() {
  if (!adminForm) return;
  adminForm.style.display = 'grid';
  adminPass?.focus();
}
function closeAdminForm() {
  if (!adminForm) return;
  adminForm.style.display = 'none';
  if (adminPass) adminPass.value = '';
}
function unlockAdminBar() {
  adminUnlocked = true;
  closeAdminForm();
  if (adminBar) adminBar.style.display = 'flex';
  status('🔓 Admin connected');
}
function lockAdminBar() {
  adminUnlocked = false;
  if (adminBar) adminBar.style.display = 'none';
  status('🔒 Admin closed');
}

async function onAdminCleanAll() {
  if (!adminUnlocked) return;
  if (!confirm('Delete ALL stickers?')) return;
  try {
    // si vous avez une RPC sécurisée, préférez-la
    const del = await supabase.from(TABLE).delete().neq('id','00000000-0000-0000-0000-000000000000');
    if (del.error) throw del.error;

    status('🧹 All stickers deleted');
  } catch (e) {
    console.error('deleteAllStickers error:', e);
    status('❌ Error purging all stickers');
  }
}

// -------- render loop --------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}
