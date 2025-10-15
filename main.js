// main.js — Toilet Sticker (Three.js + Supabase)
// - Orbit 360° fixe (sans pan/zoom), click guard, ratio image respecté
// - Publish 2/24h (RLS côté Supabase), compteur affiché
// - Live fetch + realtime
// - Clear mine, Clean all (purge récursive du bucket)
// - Admin footer bar (Shift + A)

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { createClient } from '@supabase/supabase-js'

// ---------------- CONFIG ----------------
const MODEL_URL = '/toilet.glb'
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '' // client-side prototype
const BUCKET = 'stickers'
const TABLE  = 'stickers'

// Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)

// ---------------- SESSION / DOM ----------------
function getOrCreateSessionId(){
  const k='TOILET_SESSION_ID'
  let id = localStorage.getItem(k)
  if(!id){ id=crypto.randomUUID(); localStorage.setItem(k,id) }
  return id
}
const SESSION_ID = getOrCreateSessionId()

const container   = document.getElementById('scene')
const statusEl    = document.getElementById('status')
const fileInput   = document.getElementById('stickerInput')
const sizeRange   = document.getElementById('sizeRange')
const rotRange    = document.getElementById('rotRange')
const removeBtn   = document.getElementById('removeBtn')
const publishBtn  = document.getElementById('publishBtn')
const clearMineBtn= document.getElementById('clearMine')

// Admin footer bar (Shift + A)
const adminBar       = document.getElementById('adminBar')
const adminTitle     = document.getElementById('adminTitle')
const adminPassInput = document.getElementById('adminPassword')
const adminEnterBtn  = document.getElementById('adminEnter')
const adminLockedRow   = document.getElementById('adminLocked')
const adminUnlockedRow = document.getElementById('adminUnlocked')
const adminCloseBtn    = document.getElementById('adminClose')
const adminCleanAllBtn = document.getElementById('adminCleanAll')

// ---------------- Three.js ----------------
let scene, camera, renderer, controls, modelRoot
let stickerTexture = null, stickerMesh = null
let stickerScale = parseFloat(sizeRange.value)
let stickerRotZ  = 0
let baseQuat = new THREE.Quaternion()

const LS_KEY = 'toilet-sticker-save'
const liveStickers = new Map()
const textureCache = new Map()

// IP (pour message côté client ; la policy RLS peut fallback sur header x-forwarded-for)
let CLIENT_IP = null, fetchIpPromise = null
function fetchClientIp(){
  if (CLIENT_IP) return Promise.resolve(CLIENT_IP)
  if (fetchIpPromise) return fetchIpPromise
  fetchIpPromise = fetch('https://api.ipify.org?format=json')
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(j => (CLIENT_IP = j.ip || null))
    .catch(()=> (CLIENT_IP = null))
  return fetchIpPromise
}

// ---------------- Boot ----------------
init()
animate()
bootstrapLive().then(updatePublishLabel).catch(console.warn)
fetchClientIp()

// ===========================================================
function init(){
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const w=innerWidth, h=innerHeight
  camera = new THREE.PerspectiveCamera(60, w/h, 0.1, 150)
  camera.position.set(0, 1.55, 2.6)

  renderer = new THREE.WebGLRenderer({ antialias:true })
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.shadowMap.enabled = true
  container.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9); hemi.position.set(0,4,0); scene.add(hemi)
  const dir  = new THREE.DirectionalLight(0xffffff, 1.3); dir.position.set(3.5,6,2.2); dir.castShadow=true; scene.add(dir)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom = false
  controls.enablePan  = false
  controls.rotateSpeed = 0.55
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  const EPS = 1e-3
  controls.minPolarAngle = EPS
  controls.maxPolarAngle = Math.PI - EPS
  controls.minAzimuthAngle = -Infinity
  controls.maxAzimuthAngle = Infinity

  addUIEvents()
  installSimpleClickGuard()
  installAdminHotkey()

  loadModel()

  window.addEventListener('resize', ()=>{
    camera.aspect = innerWidth/innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
}

function loadModel(){
  status('Loading 3D…')
  const loader = new GLTFLoader()
  const draco  = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(draco)
  loader.setMeshoptDecoder(MeshoptDecoder)

  loader.load(MODEL_URL, (gltf)=>{
    modelRoot = gltf.scene
    modelRoot.traverse(o => { if (o.isMesh){ o.castShadow=true; o.receiveShadow=true } })
    scene.add(modelRoot)
    centerOrbit(modelRoot)
    status('✅ Ready — pick a file, place, then Publish')
  }, undefined, (e)=>{ console.error(e); status('❌ Model load error') })
}

function centerOrbit(root, eyeH=1.2){
  const box = new THREE.Box3().setFromObject(root)
  const c   = box.getCenter(new THREE.Vector3())
  const floor = findFloorY(root, c, box)
  const ext = new THREE.Vector3().subVectors(box.max, box.min)
  const r = Math.max(ext.x, ext.z) * 0.6

  controls.target.set(c.x, floor + eyeH, c.z)
  camera.position.set(c.x, floor + eyeH + 0.4, c.z + r)

  controls.minDistance = r * 0.9
  controls.maxDistance = r * 0.9
  controls.update()
}

function findFloorY(root, c, box){
  const from = new THREE.Vector3(c.x, box.max.y + 0.5, c.z)
  const rc = new THREE.Raycaster(from, new THREE.Vector3(0,-1,0))
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}

// ===========================================================
function addUIEvents(){
  fileInput.addEventListener('change', (e)=>{
    const f = e.target.files?.[0]; if(!f) return
    const url = URL.createObjectURL(f)
    new THREE.TextureLoader().load(url, (t)=>{
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      stickerTexture = t
      status('🖼 Sticker ready — click a wall')
      if (!stickerMesh) loadSticker(stickerTexture)
    })
  })

  sizeRange.addEventListener('input', ()=>{
    stickerScale = parseFloat(sizeRange.value)
    if (stickerMesh){ stickerMesh.scale.set(stickerScale, stickerScale, 1); saveSticker() }
  })

  rotRange.addEventListener('input', ()=>{
    stickerRotZ = (parseFloat(rotRange.value) * Math.PI) / 180
    if (stickerMesh){ applyStickerRotation(); saveSticker() }
  })

  removeBtn.addEventListener('click', removeLocalSticker)
  publishBtn.addEventListener('click', publishSticker)
  clearMineBtn.addEventListener('click', deleteMyStickers)

  // Admin bar actions
  adminEnterBtn.addEventListener('click', ()=>{
    const v = adminPassInput.value || ''
    if (v === ADMIN_PASSWORD && ADMIN_PASSWORD !== '') unlockAdminBar()
    else alert('Wrong password')
  })
  adminCloseBtn.addEventListener('click', ()=> lockAdminBar(true))
  adminCleanAllBtn.addEventListener('click', deleteAllStickers)
}

// ---------------- Click guard: clic court, sans mouvement ----------------
function installSimpleClickGuard(){
  let downX=0, downY=0, downT=0, moved=false, isOrbiting=false
  const px = Math.max(6, 6*(window.devicePixelRatio||1))
  const px2 = px*px
  const maxDuration = 300

  controls.addEventListener('start', ()=>{ isOrbiting=true })
  controls.addEventListener('end',   ()=>{ isOrbiting=false })

  renderer.domElement.addEventListener('pointerdown', e=>{
    if (e.button!==0) return
    downX=e.clientX; downY=e.clientY; downT=performance.now(); moved=false
  })
  renderer.domElement.addEventListener('pointermove', e=>{
    if (moved) return
    const dx=e.clientX-downX, dy=e.clientY-downY
    if (dx*dx+dy*dy > px2) moved = true
  })
  renderer.domElement.addEventListener('pointerup', e=>{
    if (e.button!==0) return
    const dt = performance.now()-downT
    const dx=e.clientX-downX, dy=e.clientY-downY
    if (isOrbiting || moved || (dx*dx+dy*dy)>px2 || dt>maxDuration) return
    tryPlaceStickerFromPointer(e)
  })
}

// ===========================================================
// PLACE
function tryPlaceStickerFromPointer(ev){
  if (!stickerTexture || !modelRoot) return
  const rect=renderer.domElement.getBoundingClientRect()
  const mouse=new THREE.Vector2(
    ((ev.clientX-rect.left)/rect.width)*2-1,
    -((ev.clientY-rect.top)/rect.height)*2+1
  )
  const ray=new THREE.Raycaster()
  ray.setFromCamera(mouse,camera)
  const hits=ray.intersectObjects([modelRoot], true)
  if(!hits.length) return

  const hit = hits[0]
  let n = new THREE.Vector3(0,0,1)
  if (hit.face?.normal){
    n.copy(hit.face.normal)
    hit.object.updateMatrixWorld()
    n.transformDirection(hit.object.matrixWorld).normalize()
  }
  if (Math.abs(n.y)>0.6){ status('⛔ Place on a wall'); return }
  n = snappedWallNormal(n)

  const EPS=0.006
  const p = hit.point.clone().add(n.clone().multiplyScalar(EPS))
  placeOrMoveSticker(p, n)
  saveSticker()
}

function snappedWallNormal(n){
  const v=n.clone(); v.y=0
  if (v.lengthSq()<1e-6) return new THREE.Vector3(0,0,1)
  v.normalize()
  return Math.abs(v.x)>Math.abs(v.z)
    ? new THREE.Vector3(Math.sign(v.x)||1,0,0)
    : new THREE.Vector3(0,0,Math.sign(v.z)||1)
}

function makeStickerQuaternion(normal){
  const n=normal.clone().normalize()
  const worldUp = Math.abs(n.y)>0.9 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0)
  const tangent   = worldUp.clone().cross(n).normalize()
  const bitangent = n.clone().cross(tangent).normalize()
  const m = new THREE.Matrix4().makeBasis(tangent,bitangent,n)
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

function createStickerMeshFromTexture(tex){
  const img = tex.image
  const ratio = img ? (img.width / img.height) : 1
  const geom = new THREE.PlaneGeometry(1*ratio, 1)
  const mat  = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  return new THREE.Mesh(geom, mat)
}

function placeOrMoveSticker(point, normal){
  if(stickerMesh){
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

function applyStickerRotation(){
  if(!stickerMesh) return
  stickerMesh.quaternion.copy(baseQuat)
  stickerMesh.rotateOnAxis(new THREE.Vector3(0,0,1), stickerRotZ)
}

function saveSticker(){
  if(!stickerMesh) return
  const d = {
    position:   stickerMesh.position.toArray(),
    quaternion: stickerMesh.quaternion.toArray(),
    baseQuat:   baseQuat.toArray(),
    scale:      stickerScale,
    rotZ:       stickerRotZ
  }
  localStorage.setItem(LS_KEY, JSON.stringify(d))
}

function loadSticker(texture){
  const raw = localStorage.getItem(LS_KEY); if(!raw || !texture) return
  try{
    const d = JSON.parse(raw)
    stickerMesh = createStickerMeshFromTexture(texture)
    stickerMesh.position.fromArray(d.position)
    stickerScale = d.scale ?? 0.35; sizeRange.value = String(stickerScale)
    stickerRotZ  = d.rotZ  ?? 0;    rotRange.value  = String((stickerRotZ*180)/Math.PI)
    stickerMesh.scale.set(stickerScale, stickerScale, 1)
    if(d.baseQuat){ baseQuat.fromArray(d.baseQuat); applyStickerRotation() }
    else{
      const qF=new THREE.Quaternion().fromArray(d.quaternion)
      const qR=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), stickerRotZ)
      baseQuat.copy(qF).multiply(qR.invert()); applyStickerRotation()
    }
    scene.add(stickerMesh)
  }catch(e){ console.warn('Load sticker error', e) }
}

function removeLocalSticker(){
  if(stickerMesh){
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
    stickerMesh = null
  }
  localStorage.removeItem(LS_KEY)
  status('Sticker removed (local)')
}

// ===========================================================
// PUBLISH (client envoie client_ip ; RLS limite à 2/24h)
async function publishSticker(){
  if(!stickerMesh || !fileInput.files?.[0]) return status('⚠️ Pick a file and place it first')
  try{
    lockPublish(false)
    status('Uploading…')

    const ip   = await fetchClientIp()
    const file = fileInput.files[0]
    const ext  = (file.name.split('.').pop()||'png').toLowerCase()
    const path = `users/${SESSION_ID}/${Date.now()}.${ext}`

    const up = await supabase.storage.from(BUCKET).upload(path, file, { upsert:true, contentType:file.type })
    if (up.error) throw up.error

    const { data:pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
    const image_url = pub.publicUrl

    const row = {
      session_id: SESSION_ID,
      client_ip: ip,
      image_url,
      position:   stickerMesh.position.toArray(),
      quaternion: stickerMesh.quaternion.toArray(),
      base_quat:  baseQuat.toArray(),
      scale:      stickerScale,
      axis: [0,0,1],
      rotz: stickerRotZ
    }

    const ins = await supabase.from(TABLE).insert(row)
    if (ins.error) throw ins.error

    status('✅ Published')
    await updatePublishLabel()
  }catch(e){
    console.error(e)
    const m = String(e?.message || e)
    if (m.includes('violates row-level security') || m.includes('quota_ok'))
      status('⛔ Limit reached: 2 stickers / 24h')
    else if (m.includes('Bucket')) status('⛔ Storage policy issue')
    else status('❌ Publish error')
    cooldownPublish()
  }finally{
    lockPublish(true)
  }
}

// ===========================================================
// LIVE
async function bootstrapLive(){
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at',{ascending:true}).limit(500)
  if (!error) data?.forEach(addLiveFromRow)

  supabase
    .channel('stickers-live')
    .on('postgres_changes',{ event:'INSERT', schema:'public', table:TABLE }, payload=>{
      addLiveFromRow(payload.new)
      if (payload.new?.session_id === SESSION_ID) updatePublishLabel()
    })
    .subscribe()
}

function addLiveFromRow(row){
  if (!row?.id || liveStickers.has(row.id)) return
  loadTex(row.image_url, (tex)=>{
    const g = new THREE.PlaneGeometry(1,1) // legacy (carré) ; les nouveaux gardent ratio local
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    const mesh = new THREE.Mesh(g,m)
    mesh.position.fromArray(row.position)
    mesh.quaternion.fromArray(row.quaternion)
    const sc = row.scale ?? 0.35
    mesh.scale.set(sc, sc, 1)
    scene.add(mesh)
    liveStickers.set(row.id, mesh)
  })
}

// ===========================================================
// DELETE / PURGE
async function deleteMyStickers(){
  if (!confirm('Delete all stickers posted by your session?')) return
  try {
    const { data, error } = await supabase.from(TABLE).select('id').eq('session_id', SESSION_ID)
    if (error) throw error

    const del = await supabase.from(TABLE).delete().eq('session_id', SESSION_ID)
    if (del.error) throw del.error

    // Tentative de nettoyage Storage (dossier de la session)
    const listing = await supabase.storage.from(BUCKET).list(`users/${SESSION_ID}`, { limit: 1000 })
    if (!listing.error) {
      const keys = (listing.data || []).map(it => `users/${SESSION_ID}/${it.name}`)
      if (keys.length) await supabase.storage.from(BUCKET).remove(keys)
    }

    liveStickers.forEach(mesh => scene.remove(mesh))
    liveStickers.clear()
    status('🗑️ Your stickers deleted')
    await bootstrapLive()
  } catch (e) {
    console.error('deleteMyStickers', e)
    status('❌ Error deleting your stickers')
  }
}

// >>> Clean all avec purge récursive du bucket <<<
async function deleteAllStickers() {
  if (!confirm('Delete ALL stickers for everyone?')) return
  try {
    // 1) Delete DB rows (RLS doit autoriser le DELETE)
    const del = await supabase.from(TABLE).delete().neq('id', 0)
    if (del.error) throw del.error

    // 2) Récupérer toutes les clés storage (récursif)
    const keys = await listAllStorageKeysRecursive('') // racine

    // 3) Supprimer par paquets
    while (keys.length) {
      const chunk = keys.splice(0, 100)
      const rem = await supabase.storage.from(BUCKET).remove(chunk)
      if (rem.error) throw rem.error
    }

    // 4) Nettoyage scène
    liveStickers.forEach(mesh => scene.remove(mesh))
    liveStickers.clear()
    status('💥 All stickers purged')
  } catch (e) {
    console.error('deleteAllStickers error:', e)
    status('❌ Error purging all stickers')
  }
}

/** Liste récursivement toutes les paths du bucket. */
async function listAllStorageKeysRecursive(prefix) {
  const all = []
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 })
  if (error) throw error

  for (const item of data || []) {
    const full = prefix ? `${prefix}/${item.name}` : item.name
    // Si item.id → fichier ; sinon dossier
    if (item.id) {
      all.push(full)
    } else {
      const sub = await listAllStorageKeysRecursive(full)
      all.push(...sub)
    }
  }
  return all
}

// ===========================================================
// ADMIN BAR (Shift + A)
let adminOpen=false, adminUnlocked=false

function installAdminHotkey(){
  window.addEventListener('keydown', (e)=>{
    if (e.key.toLowerCase()==='a' && e.shiftKey) toggleAdminBar()
  })
}
function toggleAdminBar(){
  adminOpen = !adminOpen
  adminBar.setAttribute('aria-hidden', adminOpen?'false':'true')
  if (adminOpen){
    if (adminUnlocked) showAdminUnlocked()
    else showAdminLocked()
  }
}
function lockAdminBar(hide=false){
  adminUnlocked=false
  adminTitle.textContent='Admin'
  adminLockedRow.hidden=false
  adminUnlockedRow.hidden=true
  if(hide){ adminOpen=false; adminBar.setAttribute('aria-hidden','true') }
}
function unlockAdminBar(){ adminUnlocked=true; showAdminUnlocked() }
function showAdminLocked(){
  adminTitle.textContent='Admin'
  adminLockedRow.hidden=false
  adminUnlockedRow.hidden=true
  adminPassInput.value=''; adminPassInput.focus()
}
function showAdminUnlocked(){
  adminTitle.textContent='Admin connected'
  adminLockedRow.hidden=true
  adminUnlockedRow.hidden=false
}

// ===========================================================
// Helpers
function loadTex(url, cb){
  if (textureCache.has(url)) return cb(textureCache.get(url))
  new THREE.TextureLoader().load(url, (t)=>{
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    textureCache.set(url,t)
    cb(t)
  })
}
function status(txt){ if(statusEl) statusEl.textContent = txt }

async function getTodayCount(){
  const since = new Date(Date.now() - 24*60*60*1000).toISOString()
  const res = await supabase.from(TABLE)
    .select('id', { count:'exact', head:true })
    .gte('created_at', since)
    .eq('session_id', SESSION_ID)
  return res?.count ?? 0
}
async function updatePublishLabel(){
  try{
    const c = await getTodayCount()
    publishBtn.textContent = `Publish ${Math.min(c,2)}/2`
  }catch{}
}
function lockPublish(enabled){ publishBtn.disabled = !enabled }
function cooldownPublish(){
  publishBtn.disabled = true
  let t=10
  const iv=setInterval(()=>{
    publishBtn.textContent = `Retry in ${t}s`
    if(--t<=0){ clearInterval(iv); updatePublishLabel(); publishBtn.disabled=false }
  },1000)
}

// ===========================================================
function animate(){ requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera) }
