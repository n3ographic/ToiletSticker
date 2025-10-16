// --- Imports (si tu es en Vite/ESM) ---
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// ------------- SCENE CORE -------------
let scene, camera, renderer, controls, clock;
let currentModel = null;

const WRAP = document.getElementById('scene-wrap');

initScene();
animate();

// ---- init
function initScene() {
  clock = new THREE.Clock();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0b);

  const width = WRAP.clientWidth;
  const height = WRAP.clientHeight;

  camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 2000);
  // Position safe : recule un peu
  camera.position.set(0.8, 1.5, 2.8);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.physicallyCorrectLights = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  WRAP.appendChild(renderer.domElement);

  // Lumières simples
  const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.7);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 5, 2);
  scene.add(dir);

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.8;
  controls.maxDistance = 4.5;
  controls.target.set(0, 1.2, 0);

  window.addEventListener('resize', onResize);
}

// ---- resize
function onResize() {
  const w = WRAP.clientWidth;
  const h = WRAP.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

// ---- render loop
function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer.render(scene, camera);
}

// ------------- GLTF LOADER -------------
const gltfLoader = new GLTFLoader();

// Draco
const draco = new DRACOLoader();
draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/'); // CDN fiable
gltfLoader.setDRACOLoader(draco);

// Meshopt
gltfLoader.setMeshoptDecoder(MeshoptDecoder);

// Charge un modèle (appelle la fonction avec ton URL)
export async function loadGLB(url) {
  try {
    console.log('[Model] loading:', url);

    // Retire modèle précédent
    if (currentModel) {
      scene.remove(currentModel);
      currentModel.traverse?.(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
      currentModel = null;
    }

    const gltf = await new Promise((resolve, reject) => {
      gltfLoader.load(
        url,
        resolve,
        (e) => {
          // progression : utile pour debug
          // console.log(`loading ${((e.loaded / e.total) * 100).toFixed(1)}%`);
        },
        (err) => reject(err)
      );
    });

    console.log('[Model] loaded OK:', url);

    currentModel = gltf.scene;
    scene.add(currentModel);

    // Auto-centre caméra sur la bbox du modèle (évite “caméra dans le mesh”)
    fitCameraToObject(currentModel);

  } catch (err) {
    console.error('[Model] load error:', url, err);

    // Fallback visuel pour vérifier la scène
    fallbackCube();
    // Message lisible à l’écran (optionnel)
    showToast('Model load error. Check URL/CORS/decoders.', 'error');
  }
}

// ---- centre/zoome caméra sur l’objet
function fitCameraToObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  if (!box.isEmpty()) {
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    // place l’objet autour du pivot (contrôles)
    controls.target.copy(center);

    // calcule une distance pour bien cadrer
    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim * 1.2 / Math.tan((camera.fov * Math.PI) / 360);
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();

    camera.position.copy(controls.target).add(dir.multiplyScalar(distance));
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
  }
}

// ---- Fallback cube (debug)
function fallbackCube() {
  // retire ancien cube si existant
  const old = scene.getObjectByName('fallbackCube');
  if (old) scene.remove(old);

  const g = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const m = new THREE.MeshStandardMaterial({ color: 0x44aa88, roughness: 0.5, metalness: 0.1 });
  const cube = new THREE.Mesh(g, m);
  cube.name = 'fallbackCube';
  cube.position.set(0, 1.2, 0);
  scene.add(cube);

  const grid = scene.getObjectByName('fallbackGrid') || new THREE.GridHelper(10, 20, 0x333333, 0x222222);
  grid.name = 'fallbackGrid';
  grid.position.y = 0;
  scene.add(grid);

  fitCameraToObject(cube);
}

// ---- petit toast (optionnel)
function showToast(text, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    Object.assign(el.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      padding: '8px 12px',
      borderRadius: '10px',
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      color: '#fff',
      background: 'rgba(20,20,20,.85)',
      zIndex: 10000
    });
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.background = kind === 'error' ? 'rgba(180,40,40,.9)' : 'rgba(20,20,20,.85)';
  el.style.opacity = '1';
  setTimeout(() => { el.style.opacity = '0'; }, 2500);
}
