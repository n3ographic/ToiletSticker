// Toilet Sticker 3D — Orbit centered + Draco support
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const MODEL_URL = '/toilet.glb' // ⚠️ fichier (sans accents) dans /public

// DOM
const container     = document.getElementById('scene')
const statusEl      = document.getElementById('status')
const fileInput     = document.getElementById('stickerInput')
const scaleInput    = document.getElementById('scale')
const rotInput      = document.getElementById('rotation')
const exposureInput = document.getElementById('exposure')
const centerOrbBtn  = document.getElementById('centerOrbit')
const removeBtn     = document.getElementById('removeBtn')
const resetBtn      = document.getElementById('resetBtn')

const LS_KEY = 'toilet-sticker-orbit-draco'

// Scene state
let scene, camera, renderer, controls
let modelRoot = null

// Sticker state
let stickerTexture = null
let stickerMesh = null
let stickerScale = parseFloat(scaleInput.value)
let stickerRotZ = 0
let stickerAxis = new THREE.Vector3(0, 0, 1)
let baseQuat = new THREE.Quaternion()

// ---------- Helpers ----------
function snappedWallNormal(worldNormal) {
  const n = worldNormal.clone(); n.y = 0
  if (n.lengthSq() < 1e-6) return new THREE.Vector3(0, 0, 1)
  n.normalize()
  return Math.abs(n.x) > Math.abs(n.z)
    ? new THREE.Vector3(Math.sign(n.x) || 1, 0, 0)
    : new THREE.Vector3(0, 0, Math.sign(n.z) || 1)
}
function getRoomBox(root) {
  root.updateMatrixWorld(true)
  return new THREE.Box3().setFromObject(root)
}
function findFloorY(root, center, box) {
  const from = new THREE.Vector3(center.x, box.max.y + 0.5, center.z)
  const down = new THREE.Vector3(0, -1, 0)
  const rc = new THREE.Raycaster(from, down)
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}
function centerCameraOrbit(root, eyeH = 1.2) {
  const box = getRoomBox(root)
  const center = box.getCenter(new THREE.Vector3())
  const floorY = findFloorY(root, center, box)
  const extent = new THREE.Vector3().subVectors(box.max, box.min)
  const radius = Math.max(extent.x, extent.z) * 0.6
  const target = new THREE.Vector3(center.x, floorY + eyeH, center.z)

  camera.position.set(center.x, floorY + eyeH + 0.4, center.z + radius)
  camera.lookAt(target)
  controls.target.copy(target)
  controls.enableZoom = false
  controls.enablePan  = false
  controls.minDistance = radius * 0.9
  controls.maxDistance = radius * 0.9
  controls.minPolarAngle = Math.PI * 0.12
  controls.maxPolarAngle = Math.PI * 0.48
  controls.update()
  statusEl.textContent = '📍 Camera centered (Orbit)'
}

// ---------- Init ----------
init()
animate()

function init() {
  // Scene + cam
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x111111)
  const w = window.innerWidth, h = window.innerHeight
  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100)
  camera.position.set(0, 1.65, 2.6)
  camera.lookAt(0, 1.4, 0)

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = parseFloat(exposureInput.value)
  renderer.physicallyCorrectLights = true
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  container.appendChild(renderer.domElement)

  // Lights
  scene.add(new THREE.AmbientLight(0x222222, 0.6))
  const hemi = new THREE.HemisphereLight(0xffffff, 0x2b2b2b, 0.9)
  hemi.position.set(0, 4, 0)
  scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 1.6)
  dir.position.set(3.5, 6, 2.5)
  dir.castShadow = true
  scene.add(dir)

  // Orbit controls
  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom = false
  controls.enablePan = false
  controls.rotateSpeed = 0.5
  controls.minPolarAngle = Math.PI * 0.12
  controls.maxPolarAngle = Math.PI * 0.48

  // Resize
  window.addEventListener('resize', () => {
    const W = window.innerWidth, H = window.innerHeight
    camera.aspect = W / H
    camera.updateProjectionMatrix()
    renderer.setSize(W, H)
  })

  // --- GLTF + DRACO loader ---
  statusEl.textContent = 'Loading model…'
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  // ✅ décodeur Draco en CDN (aucun fichier à inclure au déploiement)
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(draco)

  loader.load(
    MODEL_URL,
    (gltf) => {
      modelRoot = gltf.scene
      modelRoot.traverse(o => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true }
      })
      scene.add(modelRoot)
      centerCameraOrbit(modelRoot)
      statusEl.textContent = '✅ Model loaded — upload un sticker'
    },
    undefined,
    (err) => {
      console.error('GLTF load error:', err)
      statusEl.textContent = '❌ Model load error'
    }
  )

  // UI
  exposureInput.addEventListener('input', () => {
    renderer.toneMappingExposure = parseFloat(exposureInput.value)
  })
  centerOrbBtn.addEventListener('click', () => modelRoot && centerCameraOrbit(modelRoot))

  scaleInput.addEventListener('input', () => {
    stickerScale = parseFloat(scaleInput.value)
    if (stickerMesh) {
      stickerMesh.scale.set(stickerScale, stickerScale, 1)
      saveSticker()
    }
  })
  rotInput.addEventListener('input', () => {
    stickerRotZ = (parseFloat(rotInput.value) * Math.PI) / 180
    if (stickerMesh) {
      applyStickerRotation()
      saveSticker()
    }
  })
  removeBtn.addEventListener('click', () => {
    if (stickerMesh) {
      scene.remove(stickerMesh)
      stickerMesh.geometry?.dispose()
      stickerMesh.material?.dispose()
      stickerMesh = null
    }
    localStorage.removeItem(LS_KEY)
    statusEl.textContent = 'Sticker supprimé'
  })
  resetBtn.addEventListener('click', () => {
    scaleInput.value = '0.35'
    rotInput.value = '0'
    exposureInput.value = '1.2'
    renderer.toneMappingExposure = 1.2
    stickerScale = 0.35
    stickerRotZ = 0
    if (stickerMesh) {
      stickerMesh.scale.set(stickerScale, stickerScale, 1)
      applyStickerRotation()
    }
    localStorage.removeItem(LS_KEY)
    statusEl.textContent = 'Réinitialisé'
  })

  // Upload sticker
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const url = URL.createObjectURL(file)
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace
        tex.anisotropy = 8
        stickerTexture = tex
        statusEl.textContent = '🖼 Sticker prêt — clique un mur'
        if (!stickerMesh) loadSticker(stickerTexture)
      },
      undefined,
      () => statusEl.textContent = '❌ Sticker load error'
    )
  })

  // Click to place
  const raycaster = new THREE.Raycaster()
  const mouse = new THREE.Vector2()
  renderer.domElement.addEventListener('click', (event) => {
    if (!stickerTexture) return
    const rect = renderer.domElement.getBoundingClientRect()
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(scene.children, true)
    if (!hits.length) return
    const hit = hits[0]

    // normale locale -> world
    let normal = new THREE.Vector3(0, 0, 1)
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
}

// ---------- Stickers ----------
function placeOrMoveSticker(point, normal) {
  if (stickerMesh) {
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
  }
  const geom = new THREE.PlaneGeometry(1, 1)
  const mat  = new THREE.MeshBasicMaterial({ map: stickerTexture, transparent: true })
  stickerMesh = new THREE.Mesh(geom, mat)
  stickerMesh.position.copy(point)
  stickerMesh.scale.set(stickerScale, stickerScale, 1)

  const quatAlign = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
  baseQuat.copy(quatAlign)
  stickerAxis.copy(normal)
  applyStickerRotation()
  scene.add(stickerMesh)
  statusEl.textContent = 'Sticker placé ✓'
}

function applyStickerRotation() {
  if (!stickerMesh) return
  const rotQuat = new THREE.Quaternion().setFromAxisAngle(stickerAxis, stickerRotZ)
  stickerMesh.quaternion.copy(baseQuat).multiply(rotQuat)
}

// ---------- Save / Load ----------
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
  const raw = localStorage.getItem(LS_KEY)
  if (!raw || !texture) return
  try {
    const d = JSON.parse(raw)
    const geom = new THREE.PlaneGeometry(1, 1)
    const mat  = new THREE.MeshBasicMaterial({ map: texture, transparent: true })
    stickerMesh = new THREE.Mesh(geom, mat)
    stickerMesh.position.fromArray(d.position)
    stickerMesh.quaternion.fromArray(d.quaternion)
    stickerScale = d.scale ?? 0.35
    stickerRotZ  = d.rotZ ?? 0
    stickerAxis.fromArray(d.axis ?? [0, 0, 1])
    stickerMesh.scale.set(stickerScale, stickerScale, 1)
    scene.add(stickerMesh)
    statusEl.textContent = '🧷 Sticker restauré'
  } catch (e) { console.warn('Load error', e) }
}

// ---------- Loop ----------
function animate() {
  requestAnimationFrame(animate)
  controls?.update()
  renderer.render(scene, camera)
}
