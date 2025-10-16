// ---------------------------------------------
// Imports
// ---------------------------------------------
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// (Optionnel) si tu enregistres dans Supabase :
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------
// Supabase (optionnel)
// ---------------------------------------------
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
const supabase = (SUPABASE_URL && SUPABASE_ANON)
  ? createClient(SUPABASE_URL, SUPABASE_ANON)
  : null;

// Nom de la table & colonnes attendues si tu utilises Supabase.
// Adapte ici aux colonnes réelles de ta table :
const TABLE = 'stickers'; // table Postgres
// Colonnes suggérées :
// id (uuid default gen_random_uuid())
// image_url text NOT NULL
// position double precision[] NOT NULL (3 éléments)
// quaternion double precision[] NOT NULL (4 éléments)
// scale double precision NOT NULL
// rotz double precision NOT NULL
// created_at timestamptz default now()
// session_id text NULL, client_ip text NULL (si tu limites les envois)

// ---------------------------------------------
// DOM
// ---------------------------------------------
const fileInput   = document.getElementById('fileInput');     // <input type="file" id="fileInput">
const sizeRange   = document.getElementById('size');          // <input type="range" id="size">
const rotRange    = document.getElementById('rotation');      // <input type="range" id="rotation">
const btnRemove   = document.getElementById('remove');        // <button id="remove">
const btnPublish  = document.getElementById('publish');       // <button id="publish">

// ---------------------------------------------
// Three.js setup
// ---------------------------------------------
let renderer, scene, camera, controls;
let room = null;

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
const stickerGroup = new THREE.Group(); // contient l’aperçu + les stickers
sceneInit();

async function sceneInit() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111111);
  scene.add(stickerGroup);

  // Caméra & contrôles orbit
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 200);
  camera.position.set(0, 1.6, 2.4);
  scene.add(camera);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.6;
  controls.maxDistance = 3.5;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.7;
  // Permet un 360 complet
  controls.minPolarAngle = 0;         // 0 = regarde tout en haut
  controls.maxPolarAngle = Math.PI;   // π = tout en bas

  // Lights douces
  const amb = new THREE.AmbientLight(0xffffff, 0.85);
  scene.add(amb);

  // Charge la salle
  try {
    await loadRoom('/toilet.glb'); // <-- adapte le chemin si besoin
  } catch (e) {
    console.error('[Room load error]', e);
  }

  // UI events
  bindUI();

  // Loop
  tick();
}

function tick() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------
// Chargement GLB (Meshopt + Draco prêts)
// ---------------------------------------------
async function loadRoom(glbPath) {
  const loader = new GLTFLoader();

  // Draco si besoin (mets les fichiers dans /public/draco/)
  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);

  // Meshopt — le point qui corrige ton erreur
  await MeshoptDecoder.ready;
  loader.setMeshoptDecoder(MeshoptDecoder);

  await new Promise((resolve, reject) => {
    loader.load(
      glbPath,
      (gltf) => {
        room = gltf.scene;
        room.traverse((o) => {
          if (o.isMesh) {
            // qualité minimale pour ne pas voir à travers en rasant
            o.material.side = THREE.DoubleSide;
            o.material.depthWrite = true;
            o.receiveShadow = true;
          }
        });
        scene.add(room);
        resolve();
      },
      undefined,
      (err) => reject(err)
    );
  });
}

// ---------------------------------------------
// Sticker preview & placement
// ---------------------------------------------
let preview = null;          // Mesh en aperçu
let previewTexture = null;
let currentImageDataURL = null;
let previewScale = 0.35;     // taille de base (modifiée par slider)
let previewRotZ = 0.0;       // rotation dans le plan
let clickGuard = false;      // évite le collage lors d’un drag

// Respecte le ratio de l’image : plane width=1 height = 1/aspect
function createStickerMesh(texture) {
  const aspect = texture.image.width / texture.image.height;
  const W = 1;
  const H = 1 / aspect;
  const geo = new THREE.PlaneGeometry(W, H);
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.FrontSide });
  const m = new THREE.Mesh(geo, mat);
  m.userData.isSticker = true;
  return m;
}

// Appelé en pointermove pour déplacer l’aperçu sur la surface
function updatePreviewFromRay(ev) {
  if (!preview || !room) return;
  const rect = renderer.domElement.getBoundingClientRect();

  mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObject(room, true);
  if (hits.length === 0) return;

  const hit = hits[0];
  const point = hit.point.clone();
  const normal = hit.face?.normal?.clone() || new THREE.Vector3(0, 0, 1);
  normal.transformDirection(hit.object.matrixWorld);

  // Place au contact
  preview.position.copy(point);

  // Oriente la face du sticker sur la surface
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1), // normale locale du sticker
    normal.normalize()
  );
  preview.quaternion.copy(q);

  // Applique la rotation dans le plan (Z local)
  const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), previewRotZ);
  preview.quaternion.multiply(rot);

  // Applique l’échelle
  preview.scale.setScalar(previewScale);
}

// Colle définitivement (clone le mesh d’aperçu)
function commitSticker() {
  if (!preview) return;
  const mesh = preview.clone(true);
  mesh.material = preview.material.clone(); // propre copie
  mesh.userData.isSticker = true;
  stickerGroup.add(mesh);

  // (Optionnel) enregistre dans Supabase
  if (supabase) {
    void saveStickerSupabase(mesh, currentImageDataURL);
  }
}

// ---------------------------------------------
// UI bindings
// ---------------------------------------------
function bindUI() {
  // Fichier => texture d’aperçu
  fileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    currentImageDataURL = await readAsDataURL(file);

    const tex = await createTextureFromDataURL(currentImageDataURL);
    previewTexture = tex;

    if (!preview) {
      preview = createStickerMesh(tex);
      stickerGroup.add(preview);
    } else {
      preview.material.map = tex;
      preview.material.needsUpdate = true;
      // récrée la géométrie pour ratio exact
      const aspect = tex.image.width / tex.image.height;
      preview.geometry.dispose();
      preview.geometry = new THREE.PlaneGeometry(1, 1 / aspect);
    }
  });

  // Taille
  sizeRange?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value); // supposons 0..1
    previewScale = THREE.MathUtils.lerp(0.15, 0.8, v);
    if (preview) preview.scale.setScalar(previewScale);
  });

  // Rotation
  rotRange?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value); // supposons 0..1
    previewRotZ = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(-180, 180, v));
    if (preview) {
      // recompute orientation avec la nouvelle rotZ
      const fakeMove = { clientX: lastPointer.x, clientY: lastPointer.y };
      updatePreviewFromRay(fakeMove);
    }
  });

  // Pointer events — on colle UNIQUEMENT si c’est un clic, pas un drag
  renderer.domElement.addEventListener('pointerdown', (e) => {
    mouseDownPos.set(e.clientX, e.clientY);
    clickGuard = false;
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    lastPointer.set(e.clientX, e.clientY);
    if (!clickGuard && mouseDownPos.distanceTo(lastPointer) > 6) {
      // petit seuil pour distinguer drag vs click
      clickGuard = true;
    }
    updatePreviewFromRay(e);
  });

  renderer.domElement.addEventListener('pointerup', () => {
    if (preview && !clickGuard) {
      commitSticker();
    }
  });

  // Remove = enlève uniquement l’aperçu courant (pas les collés)
  btnRemove?.addEventListener('click', () => {
    if (preview) {
      stickerGroup.remove(preview);
      preview.geometry?.dispose?.();
      preview.material?.map?.dispose?.();
      preview.material?.dispose?.();
      preview = null;
      previewTexture = null;
      currentImageDataURL = null;
      fileInput.value = '';
    }
  });

  // Publish (si Supabase est configuré, sinon bouton ignoré)
  btnPublish?.addEventListener('click', async () => {
    if (!supabase) return; // rien si pas de DB
    const allStickers = stickerGroup.children.filter(m => m.userData.isSticker && m !== preview);
    if (allStickers.length === 0) return;
    btnPublish.disabled = true;
    try {
      await Promise.all(allStickers.map(m => saveStickerSupabase(m, null)));
      notify('Stickers published ✨');
    } catch (err) {
      console.error(err);
      notify('Publish error', true);
    } finally {
      btnPublish.disabled = false;
    }
  });
}

const mouseDownPos = new THREE.Vector2();
const lastPointer   = new THREE.Vector2();

// Helpers DOM
function readAsDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function createTextureFromDataURL(dataURL) {
  return new Promise((resolve, reject) => {
    const loader = new THREE.TextureLoader();
    loader.load(
      dataURL,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        resolve(tex);
      },
      undefined,
      (err) => reject(err)
    );
  });
}

function notify(msg, error = false) {
  console[error ? 'error' : 'log']('[UI]', msg);
  // Tu peux brancher un toast ici si tu veux.
}

// ---------------------------------------------
// Sauvegarde Supabase (optionnel)
// ---------------------------------------------
async function saveStickerSupabase(mesh, dataURLIfAny) {
  if (!supabase) return;

  // Récupère les infos du mesh
  const pos = mesh.position.toArray();
  const quat = mesh.quaternion.toArray();
  const scale = mesh.scale.x; // uniforme
  // Déduis l’angle autour de la normale locale (Z) pour info visuelle
  const eul = new THREE.Euler().setFromQuaternion(mesh.quaternion, 'XYZ');
  const rotz = eul.z;

  // Stockage de l’image : si tu veux uploader dans Storage,
  // remplace image_url par une URL Storage.
  // Ici, si dataURL fourni, on l’écrit tel quel, sinon laisse null/chaine vide.
  const image_url = dataURLIfAny || ''; // adapte: upload -> URL

  // INSERT — adapte les colonnes & types à ta table
  const { error } = await supabase
    .from(TABLE)
    .insert([{
      image_url,
      position: pos,
      quaternion: quat,
      scale,
      rotz
    }]);

  if (error) {
    console.error('[Supabase insert error]', error);
    throw error;
  }
}
