// main.js — Toilet Sticker 3D
// Auteur : Néo Abric
// Version finale avec limite 2/24h, live sync Supabase et admin secret.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { createClient } from '@supabase/supabase-js'

// ---------------- CONFIG ----------------
const MODEL_URL = '/toilet.glb'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || ''
const BUCKET = 'stickers'
const TABLE = 'stickers'

// Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

// ---------------- SESSION / DOM ----------------
function getOrCreateSessionId() {
  const k = 'TOILET_SESSION_ID'
  let id = localStorage.getItem(k)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(k, id)
  }
  return id
}
const SESSION_ID = getOrCreateSessionId()

// Elements HTML
const container = document.getElementById('scene')
const statusEl = document.getElementById('status')
const fileInput = document.getElementById('stickerInput')
const sizeRange = document.getElementById('sizeRange')
const rotRange = document.getElementById('rotRange')
const removeBtn = document.getElementById('removeBtn')
const publishBtn = document.getElementById('publishBtn')

// Admin bar
const adminBar = document.getElementById('adminBar')
const adminTitle = document.getElementById('adminTitle')
const adminPassInput = document.getElementById('adminPassword')
const adminEnterBtn = document.getElementById('adminEnter')
const adminLockedRow = document.getElementById('adminLocked')
const adminUnlockedRow = document.getElementById('adminUnlocked')
const adminCloseBtn = document.getElementById('adminClose')
const adminCleanAllBtn = document.getElementById('adminCleanAll')

// ---------------- Three.js ----------------
let scene, camera, renderer, controls, modelRoot
let stickerTexture = null, stickerMesh = null
let stickerScale = parseFloat(sizeRange?.value ?? '0.35')
let stickerRotZ = 0
let baseQuat = new THREE.Quaternion()
let lastWallNormal = new THREE.Vector3(0, 0, 1)

const LS_KEY = 'toilet-sticker-save'
const liveStickers = new Map()
const textureCache = new Map()
let CLIENT_IP = null, fetchIpPromise = null

function fetchClientIp() {
  if (CLIENT_IP) return Promise.resolve(CLIENT_IP)
  if (fetchIpPromise) return fetchIpPromise
  fetchIpPromise = fetch('https://api.ipify.org?format=json')
    .then(r => r.json())
    .then(j => (CLIENT_IP = j.ip))
    .catch(() => (CLIENT_IP = null))
  return fetchIpPromise
}

// ---------------- Boot ----------------
init()
animate()
bootstrapLive().then(updatePublishLabel)
fetchClientIp().then(updatePublishLabel)

// ===========================================================
function init() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const w = innerWidth, h = innerHeight
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 150)
  camera.position.set(0, 1.55, 2.6)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.shadowMap.enabled = true
  container.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9)
  hemi.position.set(0, 4, 0)
  scene.add(hemi)

  const dir = new THREE.DirectionalLight(0xffffff, 1.3)
  dir.position.set(3.5, 6, 2.2)
  dir.castShadow = true
  scene.add(dir)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom = false
  controls.enablePan = false
  controls.rotateSpeed = 0.55
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  const EPS = 1e-3
  controls.minPolarAngle = EPS
  controls.maxPolarAngle = Math.PI - EPS
  controls.minAzimuthAngle = -Infinity
  controls.maxAzimuthAngle = Infinity

  addUIEvents()
  installAdminHotkey()
  installClickToPlace()
  loadModel()

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })

  if (publishBtn) {
    publishBtn.textContent = 'Checking…'
    publishBtn.disabled = true
    publishBtn.style.opacity = 0.5
    publishBtn.style.cursor = 'wait'
  }
}

// ---------------- Model ----------------
function loadModel() {
  status('Loading 3D…')
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(draco)
  loader.setMeshoptDecoder(MeshoptDecoder)

  loader.load(MODEL_URL, (gltf) => {
    modelRoot = gltf.scene
    modelRoot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
    scene.add(modelRoot)
    centerOrbit(modelRoot)
    status('✅ Ready — pick a file, click a wall, then Publish')
  }, undefined, (e) => { console.error(e); status('❌ Model load error') })
}

function centerOrbit(root, eyeH = 1.2) {
  const box = new THREE.Box3().setFromObject(root)
  const c = box.getCenter(new THREE.Vector3())
  const floor = findFloorY(root, c, box)
  const ext = new THREE.Vector3().subVectors(box.max, box.min)
  const r = Math.max(ext.x, ext.z) * 0.6
  controls.target.set(c.x, floor + eyeH, c.z)
  camera.position.set(c.x, floor + eyeH + 0.4, c.z + r)
  controls.minDistance = r * 0.9
  controls.maxDistance = r * 0.9
  controls.update()
}

function findFloorY(root, c, box) {
  const from = new THREE.Vector3(c.x, box.max.y + 0.5, c.z)
  const rc = new THREE.Raycaster(from, new THREE.Vector3(0, -1, 0))
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}

// ===========================================================
// 🎛 UI + STICKER LOGIC
function addUIEvents() {
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0]; if (!f) return
      const url = URL.createObjectURL(f)
      new THREE.TextureLoader().load(url, (t) => {
        t.colorSpace = THREE.SRGBColorSpace
        t.anisotropy = 8
        stickerTexture = t
        status('🖼 Sticker ready — click a wall')
        if (!stickerMesh) loadSticker(stickerTexture)
      })
    })
  }
  if (sizeRange) sizeRange.addEventListener('input', () => {
    stickerScale = parseFloat(sizeRange.value)
    if (stickerMesh) { stickerMesh.scale.set(stickerScale, stickerScale, 1); saveSticker() }
  })
  if (rotRange) rotRange.addEventListener('input', () => {
    stickerRotZ = (parseFloat(rotRange.value) * Math.PI) / 180
    if (stickerMesh) { applyStickerRotation(); saveSticker() }
  })
  if (removeBtn) removeBtn.addEventListener('click', removeLocalSticker)
  if (publishBtn) publishBtn.addEventListener('click', publishSticker)
}

// ===========================================================
// CLICK
function installClickToPlace() {
  let movedSinceDown = false
  renderer.domElement.addEventListener('pointerdown', () => (movedSinceDown = false))
  controls.addEventListener('change', () => (movedSinceDown = true))
  renderer.domElement.addEventListener('click', (e) => {
    if (movedSinceDown) return
    tryPlaceStickerFromPointer(e)
  })
}

// ===========================================================
// PLACE
function tryPlaceStickerFromPointer(ev) {
  if (!stickerTexture || !modelRoot) return
  const rect = renderer.domElement.getBoundingClientRect()
  const mouse = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  )
  const ray = new THREE.Raycaster()
  ray.setFromCamera(mouse, camera)
  const hits = ray.intersectObjects([modelRoot], true)
  if (!hits.length) return
  const hit = hits[0]
  let n = hit.face?.normal.clone() || new THREE.Vector3(0, 0, 1)
  hit.object.updateMatrixWorld()
  n.transformDirection(hit.object.matrixWorld).normalize()
  if (Math.abs(n.y) > 0.6) { status('⛔ Place on a wall'); return }
  const EPS = 0.006
  const p = hit.point.clone().add(n.clone().multiplyScalar(EPS))
  lastWallNormal.copy(n)
  placeOrMoveSticker(p, n)
  saveSticker()
}

function makeStickerQuaternion(normal) {
  const n = normal.clone().normalize()
  const up = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const tangent = up.clone().cross(n).normalize()
  const bitangent = n.clone().cross(tangent).normalize()
  const m = new THREE.Matrix4().makeBasis(tangent, bitangent, n)
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

function createStickerMeshFromTexture(tex) {
  const img = tex.image
  const ratio = img ? (img.width / img.height) : 1
  const geom = new THREE.PlaneGeometry(1 * ratio, 1)
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  return new THREE.Mesh(geom, mat)
}

function placeOrMoveSticker(point, normal) {
  if (stickerMesh) {
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
  }
  stickerMesh = createStickerMeshFromTexture(stickerTexture)
  stickerMesh.position.copy(point)
  stickerMesh.scale.set(stickerScale, stickerScale, 1)
  baseQuat = makeStickerQuaternion(normal)
  stickerMesh.quaternion.copy(baseQuat)
  applyStickerRotation()
  scene.add(stickerMesh)
  status('Sticker placed ✓ — Publish to share')
}

function applyStickerRotation() {
  if (!stickerMesh) return
  stickerMesh.quaternion.copy(baseQuat)
  stickerMesh.rotateOnAxis(new THREE.Vector3(0, 0, 1), stickerRotZ)
}

function saveSticker() {
  if (!stickerMesh) return
  const d = {
    position: stickerMesh.position.toArray(),
    quaternion: stickerMesh.quaternion.toArray(),
    baseQuat: baseQuat.toArray(),
    scale: stickerScale,
    rotZ: stickerRotZ,
    axis: lastWallNormal.toArray()
  }
  localStorage.setItem(LS_KEY, JSON.stringify(d))
}

// ===========================================================
// PUBLISH
async function publishSticker() {
  if (!stickerMesh || !fileInput?.files?.[0]) return status('⚠️ Pick a file and place it first')
  try {
    lockPublish(false)
    status('Uploading…')
    const ip = await fetchClientIp()
    const file = fileInput.files[0]
    const ext = (file.name.split('.').pop() || 'png').toLowerCase()
    const path = `users/${SESSION_ID}/${Date.now()}.${ext}`
    const up = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type })
    if (up.error) throw up.error
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
    const image_url = pub.publicUrl
    const row = {
      session_id: SESSION_ID,
      client_ip: ip,
      image_url,
      position: stickerMesh.position.toArray(),
      quaternion: stickerMesh.quaternion.toArray(),
      scale: stickerScale,
      rotz: stickerRotZ,
      axis: lastWallNormal.toArray()
    }
    const ins = await supabase.from(TABLE).insert(row)
    if (ins.error) throw ins.error
    status('✅ Published')
    await updatePublishLabel()
  } catch (e) {
    console.error(e)
    const msg = String(e?.message || e)
    if (msg.includes('violates row-level security') || msg.includes('quota_ok'))
      status('⛔ Limit reached: 2 stickers / 24h')
    else status('❌ Publish error')
    cooldownPublish()
  } finally { lockPublish(true) }
}

// ===========================================================
// LIVE
async function bootstrapLive() {
  const { data } = await supabase.from(TABLE).select('*').order('created_at', { ascending: true }).limit(500)
  data?.forEach(addLiveFromRow)
  supabase
    .channel('stickers-live')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE },
      payload => addLiveFromRow(payload.new))
    .subscribe()
}

function addLiveFromRow(row) {
  if (!row?.id || liveStickers.has(row.id)) return
  new THREE.TextureLoader().load(row.image_url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace
    const g = new THREE.PlaneGeometry(1, 1)
    const m = new THREE.MeshBasicMaterial({ map: t, transparent: true })
    const mesh = new THREE.Mesh(g, m)
    mesh.position.fromArray(row.position)
    mesh.quaternion.fromArray(row.quaternion)
    mesh.scale.set(row.scale ?? 0.35, row.scale ?? 0.35, 1)
    scene.add(mesh)
    liveStickers.set(row.id, mesh)
  })
}

// ===========================================================
// ADMIN BAR (compatible Windows & Mac)
let adminOpen = false, adminUnlocked = false

function installAdminHotkey() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F2' || e.key.toLowerCase() === 'a') {
      if (document.activeElement.tagName === 'INPUT') return
      adminOpen ? lockAdminBar(false) : openAdminBar()
    }
  })
}

function openAdminBar() {
  adminOpen = true
  adminBar.style.display = 'block'
  adminBar.style.opacity = 1
  adminBar.style.pointerEvents = 'auto'
  if (adminUnlocked) unlockAdminBar()
  else lockAdminBar(false)
}

function lockAdminBar(hide = false) {
  adminUnlocked = false
  adminTitle.textContent = 'Admin'
  adminLockedRow.style.display = 'flex'
  adminUnlockedRow.style.display = 'none'
  if (hide) {
    adminOpen = false
    adminBar.style.opacity = 0
    adminBar.style.pointerEvents = 'none'
    setTimeout(() => (adminBar.style.display = 'none'), 300)
  }
}

function unlockAdminBar() {
  adminUnlocked = true
  adminTitle.textContent = 'Admin connecté'
  adminLockedRow.style.display = 'none'
  adminUnlockedRow.style.display = 'flex'
}

async function deleteAllStickers() {
  if (!confirm('⚠️ Supprimer TOUS les stickers ?')) return
  try {
    const del = await supabase.from(TABLE).delete().not('id', 'is', null)
    if (del.error) throw del.error
    liveStickers.forEach(mesh => scene.remove(mesh))
    liveStickers.clear()
    status('💥 Tous les stickers supprimés')
  } catch (err) {
    console.error(err)
    status('❌ Erreur suppression')
  }
}

if (adminEnterBtn) {
  adminEnterBtn.addEventListener('click', () => {
    const value = adminPassInput.value.trim()
    if (value === ADMIN_PASSWORD && ADMIN_PASSWORD !== '') unlockAdminBar()
    else alert('❌ Mot de passe incorrect')
  })
}
if (adminCloseBtn) adminCloseBtn.addEventListener('click', () => lockAdminBar(true))
if (adminCleanAllBtn) adminCleanAllBtn.addEventListener('click', deleteAllStickers)

// ===========================================================
// UTILS

function status(msg) {
  if (!statusEl) return
  statusEl.textContent = msg
  statusEl.style.opacity = 1
  clearTimeout(status._t)
  status._t = setTimeout(() => (statusEl.style.opacity = 0), 3000)
}

function lockPublish(enabled) {
  if (!publishBtn) return
  publishBtn.disabled = !enabled
  publishBtn.style.opacity = enabled ? 1 : 0.5
  publishBtn.style.cursor = enabled ? 'pointer' : 'not-allowed'
}

function cooldownPublish(ms = 1200) {
  if (!publishBtn) return
  publishBtn.disabled = true
  publishBtn.style.opacity = 0.5
  setTimeout(() => updatePublishLabel(), ms)
}

function loadTex(url, onLoad) {
  if (textureCache.has(url)) return onLoad(textureCache.get(url))
  new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    textureCache.set(url, t)
    onLoad(t)
  })
}

// ===========================================================
// QUOTA (2 stickers / 24h)

async function getTodayCount() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Priorité IP (cohérent avec RLS)
  if (CLIENT_IP) {
    const res = await supabase
      .from(TABLE)
      .select('id', { count: 'exact', head: true })
      .gte('created_at', since)
      .eq('client_ip', CLIENT_IP)
    if (!res.error && typeof res.count === 'number') return res.count
  }

  // Fallback par session si IP indispo
  const res2 = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .eq('session_id', SESSION_ID)

  return res2?.count ?? 0
}

async function updatePublishLabel() {
  try {
    if (!CLIENT_IP) { try { await fetchClientIp() } catch {} }

    const c = await getTodayCount()
    if (!publishBtn) return

    if (c >= 2) {
      publishBtn.textContent = 'Blocked'
      publishBtn.disabled = true
      publishBtn.style.opacity = 0.5
      publishBtn.style.cursor = 'not-allowed'
    } else {
      publishBtn.textContent = `Publish ${c}/2`
      publishBtn.disabled = false
      publishBtn.style.opacity = 1
      publishBtn.style.cursor = 'pointer'
    }
  } catch {
    if (publishBtn) {
      publishBtn.textContent = 'Publish'
      publishBtn.disabled = false
      publishBtn.style.opacity = 1
      publishBtn.style.cursor = 'pointer'
    }
  }
}

// ===========================================================
// RENDER LOOP

function animate() {
  requestAnimationFrame(animate)
  controls?.update()
  renderer?.render(scene, camera)
}

