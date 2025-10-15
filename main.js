// Toilet Sticker 3D — Orbit + Meshopt (+ Draco fallback) + stickers
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

// ⚠️ mets ton modèle optimisé ici (GLB binaire). S'il contient EXT_meshopt_compression, ce code le gère.
const MODEL_URL = '/toilet.glb'

// UI
const container     = document.getElementById('scene')
const statusEl      = document.getElementById('status')
const fileInput     = document.getElementById('stickerInput')
const scaleInput    = document.getElementById('scale')
const rotInput      = document.getElementById('rotation')
const exposureInput = document.getElementById('exposure')
const centerBtn     = document.getElementById('centerOrbit')
const removeBtn     = document.getElementById('removeBtn')
const resetBtn      = document.getElementById('resetBtn')

const LS_KEY = 'toilet-sticker-save'

// Three
let scene, camera, renderer, controls, modelRoot
let stickerTexture = null, stickerMesh = null
let stickerScale = parseFloat(scaleInput.value)
let stickerRotZ = 0
let stickerAxis = new THREE.Vector3(0, 0, 1)
let baseQuat = new THREE.Quaternion()

// -------------------- Init --------------------
init()
animate()

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
  controls.enableZoom = false
  controls.enablePan  = false
  controls.rotateSpeed = 0.5
  controls.minPolarAngle = Math.PI * 0.12
  controls.maxPolarAngle = Math.PI * 0.48

  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight
    camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h)
  })

  exposureInput.addEventListener('input', () => {
    renderer.toneMappingExposure = parseFloat(exposureInput.value)
  })
  centerBtn.addEventListener('click', () => modelRoot && centerCameraOrbit(modelRoot))
  removeBtn.addEventListener('click', () => {
    if (stickerMesh) {
      scene.remove(stickerMesh)
      stickerMesh.geometry?.dispose()
      stickerMesh.material?.dispose()
      stickerMesh = null
      localStorage.removeItem(LS_KEY)
      statusEl.textContent = 'Sticker supprimé'
    }
  })
  resetBtn.addEventListener('click', () => {
    scaleInput.value = '0.35'; rotInput.value = '0'; exposureInput.value = '1.2'
    renderer.toneMappingExposure = 1.2
    stickerScale = 0.35; stickerRotZ = 0
    if (stickerMesh) { stickerMesh.scale.set(stickerScale, stickerScale, 1); applyStickerRotation() }
    localStorage.removeItem(LS_KEY)
    statusEl.textContent = 'Réinitialisé'
  })

  scaleInput.addEventListener('input', () => {
    stickerScale = parseFloat(scaleInput.value)
    if (stickerMesh) { stickerMesh.scale.set(stickerScale, stickerScale, 1); saveSticker() }
  })
  rotInput.addEventListener('input', () => {
    stickerRotZ = (parseFloat(rotInput.value) * Math.PI) / 180
    if (stickerMesh) { applyStickerRotation(); saveSticker() }
  })

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

  // click pour placer
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

// -------------------- Chargement modèle (Meshopt + Draco) --------------------
function loadModel() {
  statusEl.textContent = 'Chargement du modèle…'

  const loader = new GLTFLoader()

  // Draco en secours (si jamais)
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(draco)

  // ✅ Meshopt (obligatoire pour EXT_meshopt_compression)
  loader.setMeshoptDecoder(MeshoptDecoder)

  loader.load(
    MODEL_URL,
    (gltf) => {
      modelRoot = gltf.scene
      modelRoot.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true } })
      scene.add(modelRoot)
      centerCameraOrbit(modelRoot)
      statusEl.textContent = '✅ Modèle chargé — ajoute ton sticker'
    },
    (xhr) => {
      if (xhr.total) statusEl.textContent = `Chargement… ${Math.round(xhr.loaded / xhr.total * 100)}%`
    },
    (err) => {
      console.error('Erreur GLB/GLTF:', err)
      statusEl.textContent = '❌ Model load error: ' + (err?.message || err)
    }
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
  controls.enableZoom = false
  controls.enablePan  = false
  controls.minDistance = radius * 0.9
  controls.maxDistance = radius * 0.9
  controls.minPolarAngle = Math.PI * 0.12
  controls.maxPolarAngle = Math.PI * 0.48
  controls.update()
}

function findFloorY(root, center, box) {
  const from = new THREE.Vector3(center.x, box.max.y + 0.5, center.z)
  const down = new THREE.Vector3(0, -1, 0)
  const rc = new THREE.Raycaster(from, down)
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}

// -------------------- Stickers --------------------
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
    stickerScale = d.scale ?? 0.35
    stickerRotZ  = d.rotZ ?? 0
    stickerAxis.fromArray(d.axis ?? [0,0,1])
    stickerMesh.scale.set(stickerScale, stickerScale, 1)
    scene.add(stickerMesh)
    statusEl.textContent = '🧷 Sticker restauré'
  } catch(e){ console.warn('Load sticker error', e) }
}

// -------------------- Loop --------------------
function animate() {
  requestAnimationFrame(animate)
  controls.update()
  renderer.render(scene, camera)
}
