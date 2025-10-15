// 3D + Live stickers (Supabase)
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { createClient } from '@supabase/supabase-js'

// ====== CONFIG ======
const MODEL_URL = '/toilet.glb'

// Vite → ajoute ces 2 variables dans Vercel : VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)
const BUCKET = 'stickers'       // crée ce bucket public dans Supabase Storage
const TABLE  = 'stickers'       // crée cette table (SQL plus bas)

const SESSION_ID = crypto.randomUUID() // simple identifiant client

// ====== UI ======
const container     = document.getElementById('scene')
const statusEl      = document.getElementById('status')
const fileInput     = document.getElementById('stickerInput')
const scaleInput    = document.getElementById('scale')
const rotInput      = document.getElementById('rotation')
const exposureInput = document.getElementById('exposure')
const centerBtn     = document.getElementById('centerOrbit')
const removeBtn     = document.getElementById('removeBtn')
const resetBtn      = document.getElementById('resetBtn')
const publishBtn    = document.getElementById('publishBtn')
const liveInfo      = document.getElementById('liveInfo')

const LS_KEY = 'toilet-sticker-save'

// ====== THREE ======
let scene, camera, renderer, controls, modelRoot
let stickerTexture = null, stickerMesh = null
let stickerScale = parseFloat(scaleInput.value)
let stickerRotZ = 0
let stickerAxis = new THREE.Vector3(0, 0, 1)
let baseQuat = new THREE.Quaternion()
const textureCache = new Map() // url -> THREE.Texture
const liveStickers = new Map() // id -> mesh

init()
animate()
bootstrapLive()

// -------------------- Init --------------------
function init() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111111)

  const W = window.innerWidth, H = window.innerHeight
  camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100)
  camera.position.set(0, 1.6, 2.8)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(W, H)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = parseFloat(exposureInput.value)
  renderer.physicallyCorrectLights = true
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  scene.add(new THREE.AmbientLight(0x222222, 0.6))
  const hemi = new THREE.HemisphereLight(0xffffff, 0x2b2b2b, 0.9); hemi.position.set(0,4,0); scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 1.6); dir.position.set(3.5,6,2.5); dir.castShadow = true; scene.add(dir)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom = false; controls.enablePan = false; controls.rotateSpeed = 0.5
  controls.minPolarAngle = Math.PI * 0.12; controls.maxPolarAngle = Math.PI * 0.48

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h)
  })

  // UI
  exposureInput.addEventListener('input', () => renderer.toneMappingExposure = parseFloat(exposureInput.value))
  centerBtn.addEventListener('click', () => modelRoot && centerCameraOrbit(modelRoot))

  scaleInput.addEventListener('input', () => {
    stickerScale = parseFloat(scaleInput.value)
    if (stickerMesh) { stickerMesh.scale.set(stickerScale, stickerScale, 1); saveSticker() }
  })
  rotInput.addEventListener('input', () => {
    stickerRotZ = (parseFloat(rotInput.value) * Math.PI) / 180
    if (stickerMesh) { applyStickerRotation(); saveSticker() }
  })
  removeBtn.addEventListener('click', () => { removeLocalSticker() })
  resetBtn.addEventListener('click', () => {
    scaleInput.value = '0.35'; rotInput.value = '0'; exposureInput.value = '1.2'
    renderer.toneMappingExposure = 1.2; stickerScale = 0.35; stickerRotZ = 0
    if (stickerMesh) { stickerMesh.scale.set(stickerScale, stickerScale, 1); applyStickerRotation() }
    localStorage.removeItem(LS_KEY); statusEl.textContent = 'Réinitialisé'
  })

  publishBtn.addEventListener('click', publishSticker)

  // Upload
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0]; if (!file) return
    const url = URL.createObjectURL(file)
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 8
        stickerTexture = tex
        statusEl.textContent = '🖼 Sticker prêt — clique un mur'
        if (!stickerMesh) loadSticker(stickerTexture)
      },
      undefined,
      () => statusEl.textContent = '❌ Sticker load error'
    )
  })

  // Click pour placer
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2()
  renderer.domElement.addEventListener('click', (ev) => {
    if (!stickerTexture) return
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
    ray.setFromCamera(mouse, camera)
    const hits = ray.intersectObjects(scene.children, true)
    if (!hits.length) return
    const hit = hits[0]

    let normal = new THREE.Vector3(0,0,1)
    if (hit.face?.normal) {
      normal.copy(hit.face.normal)
      hit.object.updateMatrixWorld()
      normal.transformDirection(hit.object.matrixWorld).normalize()
    }
    if (Math.abs(normal.y) > 0.6) { statusEl.textContent = '⛔ Place sur un mur'; return }
    normal = snappedWallNormal(normal)

    const EPS = 0.006
    const point = hit.point.clone().add(normal.clone().multiplyScalar(EPS))
    placeOrMoveSticker(point, normal)
    saveSticker()
  })

  loadModel()
}

// -------------------- Modèle (Meshopt + Draco) --------------------
function loadModel() {
  statusEl.textContent = 'Chargement du modèle…'
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(draco)
  loader.setMeshoptDecoder(MeshoptDecoder)

  loader.load(
    MODEL_URL,
    (gltf) => {
      modelRoot = gltf.scene
      modelRoot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      scene.add(modelRoot)
      centerCameraOrbit(modelRoot)
      statusEl.textContent = '✅ Modèle chargé — ajoute / publie ton sticker'
    },
    (xhr) => { if (xhr.total) statusEl.textContent = `Chargement… ${Math.round(xhr.loaded / xhr.total * 100)}%` },
    (err) => { console.error('Erreur GLB/GLTF:', err); statusEl.textContent = '❌ Model load error' }
  )
}

// -------------------- Caméra --------------------
function centerCameraOrbit(root, eyeH = 1.2) {
  const box = new THREE.Box3().setFromObject(root)
  const center = box.getCenter(new THREE.Vector3())
  const floorY = findFloorY(root, center, box)
  const extent = new THREE.Vector3().subVectors(box.max, box.min)
  const radius = Math.max(extent.x, extent.z) * 0.6
  const target = new THREE.Vector3(center.x, floorY + eyeH, center.z)
  camera.position.set(center.x, floorY + eyeH + 0.4, center.z + radius)
  controls.target.copy(target)
  controls.enableZoom = false; controls.enablePan = false
  controls.minDistance = radius * 0.9; controls.maxDistance = radius * 0.9
  controls.minPolarAngle = Math.PI * 0.12; controls.maxPolarAngle = Math.PI * 0.48
  controls.update()
}
function findFloorY(root, center, box) {
  const from = new THREE.Vector3(center.x, box.max.y + 0.5, center.z)
  const down = new THREE.Vector3(0, -1, 0)
  const rc = new THREE.Raycaster(from, down)
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}

// -------------------- Stickers (local) --------------------
function snappedWallNormal(n) {
  const v = n.clone(); v.y = 0
  if (v.lengthSq() < 1e-6) return new THREE.Vector3(0,0,1)
  v.normalize()
  return Math.abs(v.x) > Math.abs(v.z)
    ? new THREE.Vector3(Math.sign(v.x)||1,0,0)
    : new THREE.Vector3(0,0,Math.sign(v.z)||1)
}
function placeOrMoveSticker(point, normal) {
  if (stickerMesh) {
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
  }
  const geom = new THREE.PlaneGeometry(1,1)
  const mat  = new THREE.MeshBasicMaterial({ map: stickerTexture, transparent: true })
  stickerMesh = new THREE.Mesh(geom, mat)
  stickerMesh.position.copy(point)
  stickerMesh.scale.set(stickerScale, stickerScale, 1)
  const quatAlign = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), normal)
  baseQuat.copy(quatAlign); stickerAxis.copy(normal); applyStickerRotation()
  scene.add(stickerMesh)
  statusEl.textContent = 'Sticker placé ✓ — clique Publier pour le partager'
}
function applyStickerRotation() {
  if (!stickerMesh) return
  const rotQuat = new THREE.Quaternion().setFromAxisAngle(stickerAxis, stickerRotZ)
  stickerMesh.quaternion.copy(baseQuat).multiply(rotQuat)
}
function saveSticker() {
  if (!stickerMesh) return
  const d = {
    position: stickerMesh.position.toArray(),
    quaternion: stickerMesh.quaternion.toArray(),
    scale: stickerScale,
    rotZ: stickerRotZ,
    axis: stickerAxis.toArray()
  }
  localStorage.setItem(LS_KEY, JSON.stringify(d))
}
function loadSticker(texture) {
  const raw = localStorage.getItem(LS_KEY); if (!raw || !texture) return
  try {
    const d = JSON.parse(raw)
    const geom = new THREE.PlaneGeometry(1,1)
    const mat  = new THREE.MeshBasicMaterial({ map: texture, transparent: true })
    stickerMesh = new THREE.Mesh(geom, mat)
    stickerMesh.position.fromArray(d.position)
    stickerMesh.quaternion.fromArray(d.quaternion)
    stickerScale = d.scale ?? 0.35; stickerRotZ = d.rotZ ?? 0
    stickerAxis.fromArray(d.axis ?? [0,0,1])
    stickerMesh.scale.set(stickerScale, stickerScale, 1)
    scene.add(stickerMesh)
    statusEl.textContent = '🧷 Sticker restauré (local)'
  } catch(e){ console.warn('Load sticker error', e) }
}
function removeLocalSticker() {
  if (stickerMesh) {
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
    stickerMesh = null
  }
  localStorage.removeItem(LS_KEY)
  statusEl.textContent = 'Sticker local supprimé'
}

// -------------------- Supabase: upload + publish + realtime --------------------
async function publishSticker() {
  if (!stickerMesh || !fileInput.files?.[0]) { statusEl.textContent = '⚠️ Choisis d’abord une image et place-la'; return }

  try {
    statusEl.textContent = '⬆️ Upload du sticker…'
    const file = fileInput.files[0]
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    const filename = `${SESSION_ID}-${Date.now()}.${ext}`
    const path = `users/${SESSION_ID}/${filename}`

    // Upload vers Storage
    const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type })
    if (upErr) throw upErr

    // URL publique
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
    const image_url = pub.publicUrl

    // Données de placement
    const row = {
      session_id: SESSION_ID,
      image_url,
      position: stickerMesh.position.toArray(),
      quaternion: stickerMesh.quaternion.toArray(),
      scale: stickerScale,
      axis: stickerAxis.toArray(),
      rotz: stickerRotZ
    }

    const { error: insErr } = await supabase.from(TABLE).insert(row)
    if (insErr) throw insErr

    statusEl.textContent = '✅ Publié ! (visible par tous)'
  } catch (e) {
    console.error(e)
    statusEl.textContent = '❌ Publish error'
  }
}

async function bootstrapLive() {
  try {
    // 1) Charge tous les stickers existants
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: true })
      .limit(500)

    if (error) throw error
    data?.forEach(addLiveStickerFromRow)

    // 2) Listen realtime (INSERT)
    supabase
      .channel('stickers-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE }, payload => {
        addLiveStickerFromRow(payload.new)
      })
      .subscribe((status) => {
        liveInfo.textContent = status === 'SUBSCRIBED' ? 'Live ON' : 'Live…'
      })

  } catch (e) {
    console.error('Live bootstrap error', e)
    liveInfo.textContent = 'Live OFF'
  }
}

function addLiveStickerFromRow(row) {
  // évite de dupliquer si déjà présent
  if (liveStickers.has(row.id)) return

  loadTextureCached(row.image_url, (tex) => {
    const geom = new THREE.PlaneGeometry(1,1)
    const mat  = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.fromArray(row.position)
    mesh.quaternion.fromArray(row.quaternion)
    mesh.scale.set(row.scale ?? 0.35, row.scale ?? 0.35, 1)
    scene.add(mesh)
    liveStickers.set(row.id, mesh)
  })
}

function loadTextureCached(url, onReady){
  if (textureCache.has(url)) return onReady(textureCache.get(url))
  new THREE.TextureLoader().load(
    url,
    (t) => { t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; textureCache.set(url, t); onReady(t) },
    undefined,
    (e) => console.warn('Texture load failed', url, e)
  )
}

// -------------------- Loop --------------------
function animate(){ requestAnimationFrame(animate); controls.update(); renderer.render(scene, camera) }
