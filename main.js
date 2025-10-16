// ---------- Imports via CDN (ESM) ----------
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'https://unpkg.com/three@0.160.0/examples/jsm/libs/meshopt_decoder.module.js';

// ---------- Supabase ----------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || window.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env?.VITE_SUPABASE_ANON_KEY || window.VITE_SUPABASE_ANON_KEY;
const ADMIN_KEY = import.meta.env?.VITE_ADMIN_KEY || window.VITE_ADMIN_KEY; // pour purge
const sb = (SUPABASE_URL && SUPABASE_ANON_KEY) ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ---------- DOM ----------
const canvas = document.getElementById('c');
const fileInput = document.getElementById('file');
const sizeInput = document.getElementById('size');
const rotInput  = document.getElementById('rot');
const btnRemove = document.getElementById('remove');
const btnPublish= document.getElementById('publish');
const toast     = document.getElementById('toast');
const adminDialog = document.getElementById('adminDialog');
const adminPwd = document.getElementById('adminPassword');
const adminClose = document.getElementById('adminClose');
const adminPurge = document.getElementById('adminPurge');

// ---------- Three base ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d0f);

const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.01, 100);
camera.position.set(0.0, 1.55, 1.6);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
// 360° mais position fixe
controls.enablePan = false;
controls.minDistance = 1.5;
controls.maxDistance = 1.9;
controls.target.set(0, 1.4, 0);

// lights douces
const hemi = new THREE.HemisphereLight(0xffffff, 0x1b1e22, 0.45);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.5);
dir.position.set(1,1,0.5);
scene.add(dir);

// sol invisible pour raycasts ratés
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8,8), new THREE.MeshBasicMaterial({visible:false}));
floor.rotation.x = -Math.PI/2;
floor.position.y = 0;
scene.add(floor);

// ---------- Model ----------
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
loader.setDRACOLoader(draco);
loader.setMeshoptDecoder(MeshoptDecoder);

// NOTE: mets ton modèle dans /public comme /toilet.glb
const MODEL_URL = '/toilet.glb';

let modelRoot = null;
await new Promise((resolve, reject)=>{
  loader.load(MODEL_URL, (gltf)=>{
    modelRoot = gltf.scene;
    // normalise taille/centre
    const box = new THREE.Box3().setFromObject(modelRoot);
    const c = box.getCenter(new THREE.Vector3());
    const s = box.getSize(new THREE.Vector3()).length();
    const scale = 3.0 / s;
    modelRoot.scale.setScalar(scale);
    modelRoot.position.sub(c.multiplyScalar(scale));
    scene.add(modelRoot);
    resolve();
  }, undefined, (e)=>reject(e));
}).catch(e=>{
  notify("Model load error — vérifie que /toilet.glb est bien dans public/ ou le chemin.");
  console.error(e);
});

// ---------- Sticker state ----------
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hover = null; // preview mesh
let hoverTex = null;
let hoverQuat = new THREE.Quaternion();
let hoverPos  = new THREE.Vector3();
let stickerNormal = new THREE.Vector3(0,0,1);
let publishCount = 0; // server count
let sessionId = getSessionId();

// plane unit pour stickers (échelle via sizeInput)
const baseGeo = new THREE.PlaneGeometry(1,1,1,1);

function makeStickerMaterial(tex){
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide
  });
}

function newHover(texture){
  if (hover) { scene.remove(hover); hover.geometry.dispose(); if(hover.material.map) hover.material.map.dispose(); hover.material.dispose(); hover=null; }
  const mat = makeStickerMaterial(texture);
  hover = new THREE.Mesh(baseGeo, mat);
  hover.scale.setScalar(Number(sizeInput.value));
  scene.add(hover);
}

// ---------- Supabase helpers ----------
async function fetchCountLeft(){
  if (!sb) return {left:2, blocked:false};
  const { data, error } = await sb
    .rpc('quota_left', { p_session: sessionId, p_limit: 2 }); // crée cette RPC si tu veux sinon on compte côté client
  if (error || !data) {
    // fallback simple: count in last 24h
    const since = new Date(Date.now()-24*3600e3).toISOString();
    const { data:rows } = await sb.from('stickers')
      .select('id', {count:'exact', head:true})
      .eq('session_id', sessionId)
      .gt('created_at', since);
    const used = rows?.length ?? 0;
    return {left: Math.max(0, 2-used), blocked: used>=2};
  }
  return {left:data, blocked: data<=0};
}

async function publishSticker(){
  if (!sb || !hover) return;
  const { left, blocked } = await fetchCountLeft();
  if (blocked) {
    btnPublish.disabled = true;
    btnPublish.textContent = 'Blocked';
    notify('Limit reached: 2 stickers / 24h');
    return;
  }
  // construire payload (ratio du sticker)
  const s = hover.scale.x;
  const rotZ = Number(rotInput.value) * Math.PI/180;
  const pos = hoverPos.clone();
  const quat= hoverQuat.clone();

  // upload image (dataURL) dans storage? — pour faire simple on encode dans Supabase Storage public bucket "stickers"
  // Ici on suppose que hover.material.map.source.data est un <img>. On re-upload le fichier original depuis la File input.
  const file = fileInput.files?.[0];
  if (!file) { notify('Choose an image first.'); return; }

  const fileName = `users/${sessionId}/${crypto.randomUUID()}-${file.name}`;
  const { data:upErr, error:upError } = await sb.storage.from('stickers').upload(fileName, file, { upsert:false, contentType:file.type });
  if (upError) { console.error(upError); notify('Upload error'); return; }
  const { data:pub } = sb.storage.from('stickers').getPublicUrl(fileName);
  const imageUrl = pub.publicUrl;

  const payload = {
    session_id: sessionId,
    image_url: imageUrl,
    position: [pos.x, pos.y, pos.z],
    quaternion: [quat.x, quat.y, quat.z, quat.w],
    scale: s,
    rotz: rotZ,
    axis: [stickerNormal.x, stickerNormal.y, stickerNormal.z],
    base_quat: [0,0,0,1]
  };
  const { error } = await sb.from('stickers').insert(payload);
  if (error) { console.error(error); notify('Publish error'); return; }

  publishCount++;
  const leftNow = Math.max(0, 2-publishCount);
  btnPublish.textContent = leftNow>0 ? `Publish ${publishCount}/2` : 'Blocked';
  btnPublish.disabled = leftNow===0;
  notify('Sticker published ✅');
}

async function loadPersistedStickers(){
  if (!sb) return;
  const { data, error } = await sb.from('stickers').select('*').order('created_at');
  if (error) { console.error(error); return; }
  for (const row of data) {
    const tex = await loadTexture(row.image_url);
    const m = new THREE.Mesh(baseGeo, makeStickerMaterial(tex));
    m.position.fromArray(row.position);
    m.quaternion.fromArray(row.quaternion);
    m.scale.setScalar(row.scale || 1);
    scene.add(m);
  }
}

// ---------- Texture loader ----------
const texLoader = new THREE.TextureLoader();
function loadTexture(url){
  return new Promise((res, rej)=>{
    texLoader.load(url, (t)=>res(t), undefined, rej);
  });
}

// ---------- Events ----------
window.addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

canvas.addEventListener('pointermove', (e)=>{
  setMouse(e);
  updateHover();
});
canvas.addEventListener('click', ()=>{
  // poser = déjà fait au move; ici juste “valider” la dernière projection
  if (hover) notify('Sticker placé (non publié)');
});

function setMouse(e){
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

function updateHover(){
  if (!hover || !modelRoot) return;
  raycaster.setFromCamera(mouse, camera);
  // intersecte toute la scene (model + floor)
  const hits = raycaster.intersectObjects(modelRoot.children, true);
  const hit = hits[0] ?? raycaster.intersectObject(floor, true)[0];
  if (!hit) return;
  hoverPos.copy(hit.point);
  // normal + face orientation -> orienter le sticker
  stickerNormal = hit.face?.normal?.clone()?.applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize() || new THREE.Vector3(0,0,1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), stickerNormal);
  // rotation z utilisateur
  const qz = new THREE.Quaternion().setFromAxisAngle(stickerNormal, Number(rotInput.value) * Math.PI/180);
  hoverQuat.copy(q).multiply(qz);
  hover.position.copy(hoverPos);
  hover.quaternion.copy(hoverQuat);
}

fileInput.addEventListener('change', async ()=>{
  const file = fileInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const tex = await loadTexture(url);
  newHover(tex);
  updateHover();
});

sizeInput.addEventListener('input', ()=>{
  if (hover) hover.scale.setScalar(Number(sizeInput.value));
});

rotInput.addEventListener('input', ()=>{
  updateHover();
});

btnRemove.addEventListener('click', ()=>{
  if (hover) { scene.remove(hover); hover=null; }
});

btnPublish.addEventListener('click', publishSticker);

// admin
document.addEventListener('keydown', (e)=>{
  if (e.key.toLowerCase()==='a') adminDialog.showModal();
});
adminClose.addEventListener('click', ()=> adminDialog.close());
adminPurge.addEventListener('click', async (e)=>{
  e.preventDefault();
  if (!sb) return;
  if (adminPwd.value !== (ADMIN_KEY || 'letmein')) { notify('Wrong password'); return; }
  const { error } = await sb.from('stickers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) { notify('Error purging'); console.error(error); return; }
  // reload page
  location.reload();
});

// ---------- Helpers ----------
function notify(msg){
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(notify._t);
  notify._t = setTimeout(()=> toast.classList.remove('show'), 3000);
}

function getSessionId(){
  const k='toilet_sid';
  let v = localStorage.getItem(k);
  if (!v){ v = crypto.randomUUID(); localStorage.setItem(k, v); }
  return v;
}

// ---------- Boot ----------
(async function boot(){
  // compteur au démarrage
  if (sb){
    const { left, blocked } = await fetchCountLeft();
    publishCount = 2-left;
    btnPublish.textContent = blocked ? 'Blocked' : `Publish ${publishCount}/2`;
    btnPublish.disabled = blocked;
  }
  // stickers persistés
  await loadPersistedStickers();
  animate();
})();

function animate(){
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
