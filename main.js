// ===== CONFIG =====
const MODEL_URL = '/toilet.glb'; // mets l’URL correcte (HTTPS public)
const DRACO_CDN = 'https://www.gstatic.com/draco/v1/decoders/';

// ===== Imports (Vite/Three r18x) =====
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ===== Globals =====
let scene, camera, renderer, controls;
let raycaster, mouseNDC = new THREE.Vector2();
let modelRoot = null;

let currentSticker = null;
let stickerTexture = null;
let naturalRatio = 1; // w/h original
let pointerDown = false;
let moved = false;

const wrap = document.getElementById('scene-wrap');
const fileInput = document.getElementById('fileInput');
const sizeEl = document.getElementById('size');
const rotzEl = document.getElementById('rotz');
const removeBtn = document.getElementById('removeBtn');
const publishBtn = document.getElementById('publishBtn');

// ===== Init =====
initScene();
loadModel(MODEL_URL);
bindUI();
animate();

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0b);

  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 2000);
  camera.position.set(0.8, 1.5, 2.8);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.physicallyCorrectLights = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  wrap.appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.7);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 5, 2);
  scene.add(dir);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  // orbit 360 sur tous les axes
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = Math.PI;

  raycaster = new THREE.Raycaster();

  window.addEventListener('resize', onResize);

  // Click vs drag guard
  renderer.domElement.addEventListener('pointerdown', () => {
    pointerDown = true; moved = false;
  });
  renderer.domElement.addEventListener('pointermove', () => {
    if (pointerDown) moved = true;
  });
  renderer.domElement.addEventListener('pointerup', onPointerUp);
}

function onResize() {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// ===== Model loading =====
const gltfLoader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath(DRACO_CDN);
gltfLoader.setDRACOLoader(draco);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

async function loadModel(url) {
  try {
    const { scene: gltfScene } = await new Promise((resolve, reject) => {
      gltfLoader.load(url, resolve, undefined, reject);
    });

    if (modelRoot) scene.remove(modelRoot);
    modelRoot = gltfScene;
    scene.add(modelRoot);

    fitCameraToObject(modelRoot);
    toast('Model loaded');
  } catch (e) {
    console.error('[Model] load error', e);
    fallbackCube();
    toast('Model load error (URL/CORS/decoders)', true);
  }
}

function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  controls.target.copy(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const distance = maxDim * 1.2 / Math.tan((camera.fov * Math.PI) / 360);
  const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
  camera.position.copy(controls.target).add(dir.multiplyScalar(distance));
  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
}

function fallbackCube() {
  const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const m = new THREE.MeshStandardMaterial({ color: 0x44aa88 });
  const cube = new THREE.Mesh(g, m);
  cube.position.set(0, 1.2, 0);
  scene.add(cube);
  fitCameraToObject(cube);
}

// ===== Stickers =====
function onPointerUp(e) {
  if (moved) { pointerDown = false; return; }
  pointerDown = false;

  if (!stickerTexture) return;

  // Raycast
  const rect = renderer.domElement.getBoundingClientRect();
  mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouseNDC, camera);
  const target = modelRoot ?? scene;
  const hits = raycaster.intersectObject(target, true);
  if (!hits.length) return;

  const hit = hits[0];
  const point = hit.point.clone();
  const normal = hit.face?.normal?.clone()?.transformDirection(hit.object.matrixWorld)
              ?? new THREE.Vector3(0, 0, 1);

  placeSticker(point, normal);
}

function placeSticker(point, normal) {
  // Nettoie ancien sticker “temporaire”
  if (currentSticker) {
    scene.remove(currentSticker);
    currentSticker.geometry?.dispose();
    // material/texture non disposés pour pouvoir publier ensuite si besoin
    currentSticker = null;
  }

  // ratio respecté (taille slider = largeur)
  const baseW = parseFloat(sizeEl.value); // mètres
  const baseH = baseW / naturalRatio;

  const geo = new THREE.PlaneGeometry(baseW, baseH);
  const mat = new THREE.MeshBasicMaterial({ map: stickerTexture, transparent: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);

  // Orientation sur la surface
  const up = new THREE.Vector3(0, 1, 0);
  const lookAt = new THREE.Matrix4();
  const quat = new THREE.Quaternion().setFromUnitVectors(up, normal.clone().normalize());
  lookAt.makeRotationFromQuaternion(quat);
  mesh.quaternion.setFromRotationMatrix(lookAt);

  // Rotation Z utilisateur (autour de la normale)
  mesh.rotateOnWorldAxis(normal, THREE.MathUtils.degToRad(parseFloat(rotzEl.value)));

  mesh.position.copy(point);
  currentSticker = mesh;
  scene.add(mesh);
}

// ===== UI =====
function bindUI() {
  fileInput.addEventListener('change', onPickImage);
  sizeEl.addEventListener('input', () => {
    if (!currentSticker) return;
    const w = parseFloat(sizeEl.value);
    const h = w / naturalRatio;
    currentSticker.geometry.dispose();
    currentSticker.geometry = new THREE.PlaneGeometry(w, h);
  });
  rotzEl.addEventListener('input', () => {
    if (!currentSticker) return;
    const n = getStickerNormal(currentSticker);
    currentSticker.setRotationFromQuaternion(new THREE.Quaternion()); // reset
    // réaligne vers la normale
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, n);
    currentSticker.quaternion.premultiply(q);
    // applique la rot Z
    currentSticker.rotateOnWorldAxis(n, THREE.MathUtils.degToRad(parseFloat(rotzEl.value)));
  });

  removeBtn.addEventListener('click', () => {
    if (!currentSticker) return;
    scene.remove(currentSticker);
    currentSticker.geometry?.dispose();
    currentSticker.material?.dispose();
    currentSticker = null;
  });

  publishBtn.addEventListener('click', () => {
    // Version “qui marchait” sans back-end : on garde la forme.
    if (!currentSticker) { toast('Place un sticker avant de publier'); return; }
    toast('Publish OK (offline demo)');
  });
}

function getStickerNormal(mesh) {
  // la normale locale du plan est +Z; en world :
  const n = new THREE.Vector3(0, 0, 1);
  n.applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
  return n.normalize();
}

function onPickImage(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const img = new Image();
  img.onload = () => {
    naturalRatio = img.width / img.height;
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    stickerTexture = tex;
    toast('Image chargée — clique sur un mur pour coller');
  };
  img.onerror = () => toast('Erreur image', true);
  img.src = URL.createObjectURL(file);
}

// ===== Toast =====
let toastEl = null;
function toast(text, isError = false) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  toastEl.style.background = isError ? 'rgba(180,40,40,.9)' : 'rgba(20,20,20,.9)';
  toastEl.style.opacity = '1';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => (toastEl.style.opacity = '0'), 2200);
}
