// main.js — ToiletSticker (version IP-quota + admin modal + purge + clear mine)
// ATTENTION: pour production, move admin actions to a server (this client-side admin check is only for quick prototyping).

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { createClient } from '@supabase/supabase-js'

// ---------- CONFIG ----------
const MODEL_URL = '/toilet.glb'
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || '' // pour prototype
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON)
const BUCKET = 'stickers'
const TABLE  = 'stickers'

// ---------- SESSION persistée ----------
function getOrCreateSessionId() {
  const KEY = 'TOILET_SESSION_ID'
  let id = localStorage.getItem(KEY)
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id) }
  return id
}
const SESSION_ID = getOrCreateSessionId()

// ---------- DOM ----------
const container  = document.getElementById('scene')
const statusEl   = document.getElementById('status')
const fileInput  = document.getElementById('stickerInput')
const sizeRange  = document.getElementById('sizeRange')
const rotRange   = document.getElementById('rotRange')
const removeBtn  = document.getElementById('removeBtn')
const publishBtn = document.getElementById('publishBtn')
const clearMineBtn = document.getElementById('clearMine')

// admin modal
const adminModal = document.getElementById('adminModal')
const adminPassInput = document.getElementById('adminPassword')
const adminSubmit = document.getElementById('adminSubmit')
const adminCancel = document.getElementById('adminCancel')

// ---------- Three.js ----------
let scene, camera, renderer, controls, modelRoot
let stickerTexture = null, stickerMesh = null
let stickerScale = parseFloat(sizeRange.value)
let stickerRotZ = 0
let baseQuat = new THREE.Quaternion()

const LS_KEY = 'toilet-sticker-save'
const liveStickers = new Map()
const textureCache = new Map()

// client ip cache (promise)
let CLIENT_IP = null
let fetchIpPromise = null
function fetchClientIp() {
  if (CLIENT_IP) return Promise.resolve(CLIENT_IP)
  if (fetchIpPromise) return fetchIpPromise
  fetchIpPromise = fetch('https://api.ipify.org?format=json').then(r=>{
    if(!r.ok) throw new Error('ip fetch failed')
    return r.json()
  }).then(j => {
    CLIENT_IP = j.ip || null
    return CLIENT_IP
  }).catch(e=>{
    console.warn('Could not fetch IP:', e)
    CLIENT_IP = null
    return null
  })
  return fetchIpPromise
}

// ---------- Boot ----------
init()
animate()
bootstrapLive().then(updatePublishLabel).catch(console.warn)
fetchClientIp().then(ip=>console.log('client ip', ip))

// ===========================================================
// INIT
// ===========================================================
function init() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const w = innerWidth, h = innerHeight
  camera = new THREE.PerspectiveCamera(60, w/h, 0.1, 150)
  camera.position.set(0, 1.55, 2.6)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setSize(w, h)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.shadowMap.enabled = true
  container.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9); hemi.position.set(0,4,0); scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 1.3); dir.position.set(3.5,6,2.2); dir.castShadow = true; scene.add(dir)

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
  installSimpleClickGuard()   // reliable click guard
  installAdminHotkey()        // secret sequence listener

  loadModel()

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(innerWidth, innerHeight)
  })
}

// ===========================================================
// MODEL
// ===========================================================
function loadModel(){
  status('Loading 3D…')
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/')
  loader.setDRACOLoader(draco)
  loader.setMeshoptDecoder(MeshoptDecoder)

  loader.load(MODEL_URL, (gltf)=>{
    modelRoot = gltf.scene
    modelRoot.traverse(o => { if (o.isMesh){ o.castShadow = true; o.receiveShadow = true } })
    scene.add(modelRoot)
    centerOrbit(modelRoot)
    status('✅ Ready — pick a file, place, then Publish')
  }, undefined, (e)=>{ console.error(e); status('❌ Model load error') })
}

function centerOrbit(root, eyeH=1.2){
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

function findFloorY(root, c, box){
  const from = new THREE.Vector3(c.x, box.max.y + 0.5, c.z)
  const rc = new THREE.Raycaster(from, new THREE.Vector3(0,-1,0))
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}

// ===========================================================
// UI
// ===========================================================
function addUIEvents(){
  fileInput.addEventListener('change', (e)=>{
    const f = e.target.files?.[0]; if (!f) return
    const url = URL.createObjectURL(f)
    new THREE.TextureLoader().load(url, (t)=>{
      t.colorSpace = THREE.SRGBColorSpace
      t.anisotropy = 8
      stickerTexture = t
      status('🖼 Sticker prêt — clique un mur')
      if (!stickerMesh) loadSticker(stickerTexture)
    })
  })

  sizeRange.addEventListener('input', ()=>{
    stickerScale = parseFloat(sizeRange.value)
    if (stickerMesh){ stickerMesh.scale.set(stickerScale, stickerScale, 1); saveSticker() }
  })

  rotRange.addEventListener('input', ()=>{
    stickerRotZ = (parseFloat(rotRange.value)*Math.PI)/180
    if (stickerMesh){ applyStickerRotation(); saveSticker() }
  })

  removeBtn.addEventListener('click', removeLocalSticker)
  publishBtn.addEventListener('click', publishSticker)
  clearMineBtn.addEventListener('click', deleteMyStickers)

  // admin modal events
  adminCancel.addEventListener('click', closeAdminModal)
  adminSubmit.addEventListener('click', () => {
    const v = adminPassInput.value || ''
    if (v === ADMIN_PASSWORD && ADMIN_PASSWORD !== '') {
      closeAdminModal()
      openAdminConsole()
    } else {
      alert('Wrong admin password (client-side check).')
    }
  })
}

// ===========================================================
// CLICK GUARD (simple & reliable)
// ===========================================================
function installSimpleClickGuard(){
  let downX=0, downY=0, downT=0, moved=false, isOrbiting=false
  const px = Math.max(6, 6 * (window.devicePixelRatio || 1))
  const px2 = px*px
  const maxDuration = 300

  controls.addEventListener('start', ()=>{ isOrbiting = true })
  controls.addEventListener('end',   ()=>{ isOrbiting = false })

  renderer.domElement.addEventListener('pointerdown', e=>{
    if (e.button !== 0) return
    downX=e.clientX; downY=e.clientY; downT=performance.now(); moved=false
  })
  renderer.domElement.addEventListener('pointermove', e=>{
    if (moved) return
    const dx=e.clientX-downX, dy=e.clientY-downY
    if (dx*dx+dy*dy > px2) moved = true
  })
  renderer.domElement.addEventListener('pointerup', e=>{
    if (e.button !== 0) return
    const dt = performance.now() - downT
    const dx = e.clientX - downX, dy = e.clientY - downY
    const dist2 = dx*dx + dy*dy
    if (isOrbiting || moved || dist2 > px2 || dt > maxDuration) return
    tryPlaceStickerFromPointer(e)
  })
}

// ===========================================================
// PLACE LOGIC (respects image ratio + orientation)
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
  if(!hits.length)return
  const hit=hits[0]
  let n=new THREE.Vector3(0,0,1)
  if(hit.face?.normal){
    n.copy(hit.face.normal)
    hit.object.updateMatrixWorld()
    n.transformDirection(hit.object.matrixWorld).normalize()
  }
  if(Math.abs(n.y)>0.6){ status('⛔ Place sur un mur'); return }
  n = snappedWallNormal(n)
  const EPS=0.006
  const p=hit.point.clone().add(n.clone().multiplyScalar(EPS))
  placeOrMoveSticker(p,n)
  saveSticker()
}

function snappedWallNormal(n){
  const v=n.clone(); v.y=0
  if(v.lengthSq()<1e-6) return new THREE.Vector3(0,0,1)
  v.normalize()
  return Math.abs(v.x)>Math.abs(v.z) ? new THREE.Vector3(Math.sign(v.x)||1,0,0) : new THREE.Vector3(0,0,Math.sign(v.z)||1)
}

function makeStickerQuaternion(normal){
  const n=normal.clone().normalize()
  const worldUp=Math.abs(n.y)>0.9?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0)
  const tangent=worldUp.clone().cross(n).normalize()
  const bitangent=n.clone().cross(tangent).normalize()
  const m=new THREE.Matrix4().makeBasis(tangent,bitangent,n)
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

function createStickerMeshFromTexture(tex){
  const img = tex.image
  const ratio = img ? (img.width / img.height) : 1
  const geom = new THREE.PlaneGeometry(1 * ratio, 1)
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
    position: stickerMesh.position.toArray(),
    quaternion: stickerMesh.quaternion.toArray(),
    baseQuat: baseQuat.toArray(),
    scale: stickerScale,
    rotZ: stickerRotZ
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
    stickerRotZ  = d.rotZ ?? 0;    rotRange.value  = String((stickerRotZ*180)/Math.PI)
    stickerMesh.scale.set(stickerScale, stickerScale, 1)
    if(d.baseQuat){ baseQuat.fromArray(d.baseQuat); applyStickerRotation() }
    else{
      const qF=new THREE.Quaternion().fromArray(d.quaternion)
      const qR=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),stickerRotZ)
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
    stickerMesh=null
  }
  localStorage.removeItem(LS_KEY)
  status('Sticker local removed')
}

// ===========================================================
// SUPABASE: publish with client_ip included
// ===========================================================
async function publishSticker(){
  if(!stickerMesh || !fileInput.files?.[0]) return status('⚠️ Pick a file and place it first')
  try{
    lockPublish(false)
    status('Uploading…')

    const ip = await fetchClientIp() // may be null
    const file = fileInput.files[0]
    const ext = (file.name.split('.').pop()||'png').toLowerCase()
    const path = `users/${SESSION_ID}/${Date.now()}.${ext}`

    const { error:upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert:true, contentType:file.type })
    if (upErr) throw upErr

    const { data:pub } = supabase.storage.from(BUCKET).getPublicUrl(path)
    const image_url = pub.publicUrl

    const row = {
      session_id: SESSION_ID,
      client_ip: ip,
      image_url,
      position: stickerMesh.position.toArray(),
      quaternion: stickerMesh.quaternion.toArray(),
      base_quat: baseQuat.toArray(),
      scale: stickerScale,
      axis: [0,0,1],
      rotz: stickerRotZ
    }

    const { error:insErr } = await supabase.from(TABLE).insert(row)
    if (insErr) throw insErr

    status('✅ Published')
    await updatePublishLabel()
  }catch(e){
    console.error(e)
    const msg = String(e?.message || e)
    if (msg.includes('violates row-level security') || msg.includes('quota_ok'))
      status('⛔ Limit reached: 2 stickers / 24h')
    else if (msg.includes('Bucket')) status('⛔ Storage bucket/policy issue')
    else status('❌ Publish error')
    cooldownPublish()
  }finally{ lockPublish(true) }
}

// ===========================================================
// LIVE bootstrap
// ===========================================================
async function bootstrapLive(){
  const { data, error } = await supabase.from(TABLE).select('*').order('created_at',{ascending:true}).limit(500)
  if (!error) data?.forEach(addLiveFromRow)

  supabase
    .channel('stickers-live')
    .on('postgres_changes',{ event:'INSERT', schema:'public', table:TABLE }, payload => {
      addLiveFromRow(payload.new)
      if (payload.new?.session_id === SESSION_ID) updatePublishLabel()
    })
    .subscribe()
}

function addLiveFromRow(row){
  if (!row?.id || liveStickers.has(row.id)) return
  loadTex(row.image_url, (tex) => {
    // If row was saved before ratio-support, the image may be square; we don't know ratio stored.
    const g = new THREE.PlaneGeometry(1,1)
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true })
    const mesh = new THREE.Mesh(g,m)
    mesh.position.fromArray(row.position)
    mesh.quaternion.fromArray(row.quaternion)
    mesh.scale.set(row.scale ?? 0.35, row.scale ?? 0.35, 1)
    scene.add(mesh)
    liveStickers.set(row.id, mesh)
  })
}

// ===========================================================
// DELETE / PURGE helpers
// ===========================================================
async function deleteMyStickers(){
  if (!confirm('Delete all stickers posted by your session? This cannot be undone for those items.')) return
  try {
    // 1) get rows to delete (to know storage path)
    const { data, error } = await supabase.from(TABLE).select('id, image_url').eq('session_id', SESSION_ID)
    if (error) throw error

    // 2) delete DB rows
    const { error:delErr } = await supabase.from(TABLE).delete().eq('session_id', SESSION_ID)
    if (delErr) throw delErr

    // 3) attempt to delete storage objects referenced
    if (Array.isArray(data)) {
      for (const r of data) {
        // infer path from url - naive approach: publicUrl contains /object/.. or /storage/v1/object/public/...
        try {
          const url = new URL(r.image_url)
          const pathname = url.pathname
          // try to extract last part after '/' — if files saved under users/..., we can remove via that key
          const parts = pathname.split('/')
          const filename = parts.slice(-1)[0]
          // list and remove any object matching filename under users/<session>
          // We try a safe approach: list all objects under users/<SESSION_ID> and remove those with filename
          const listing = await supabase.storage.from(BUCKET).list(`users/${SESSION_ID}`, { limit: 1000 })
          if (listing.error) continue
          for (const item of listing.data || []) {
            if (item.name === filename) {
              await supabase.storage.from(BUCKET).remove([`users/${SESSION_ID}/${item.name}`]).catch(()=>{})
            }
          }
        } catch(e){}
      }
    }

    // UI cleanup
    liveStickers.forEach(mesh => scene.remove(mesh))
    liveStickers.clear()
    status('🗑️ Your stickers deleted')
    await bootstrapLive()
  } catch (e) {
    console.error('deleteMyStickers', e)
    status('❌ Error deleting your stickers')
  }
}

// Admin: open modal by secret hotkey; if unlocked -> delete all rows & storage
async function deleteAllStickers() {
  if (!confirm('Delete ALL stickers for everyone? This is irreversible.')) return
  try {
    // 1) fetch all rows to find storage paths
    const { data, error } = await supabase.from(TABLE).select('id, image_url')
    if (error) throw error

    // 2) delete DB rows
    const { error:delErr } = await supabase.from(TABLE).delete().neq('id', 0)
    if (delErr) throw delErr

    // 3) try to clear bucket files (list root and remove)
    // Warning: this will attempt to list and delete many files; adapt if you have more than the API limits.
    const toDelete = []
    let offset = 0; const limit = 1000
    while (true) {
      const listRes = await supabase.storage.from(BUCKET).list('', { limit, offset })
      if (listRes.error) break
      const items = listRes.data || []
      if (!items.length) break
      for (const it of items) {
        // remove file path relative to bucket
        toDelete.push(it.name)
      }
      if (items.length < limit) break
      offset += items.length
    }
    // remove by chunks
    while (toDelete.length) {
      const chunk = toDelete.splice(0, 100)
      await supabase.storage.from(BUCKET).remove(chunk).catch(()=>{})
    }

    liveStickers.forEach(mesh => scene.remove(mesh))
    liveStickers.clear()
    status('💥 All stickers purged')
  } catch (e) {
    console.error('deleteAllStickers', e)
    status('❌ Error purging all stickers')
  }
}

// ===========================================================
// Admin modal & hotkey
// ===========================================================
function installAdminHotkey() {
  const seq = 'opensesame'
  let buf = ''
  window.addEventListener('keydown', (e) => {
    if (e.key && e.key.length === 1) {
      buf += e.key.toLowerCase()
      if (!seq.startsWith(buf)) buf = buf.slice(-seq.length)
      if (buf.endsWith(seq)) {
        openAdminModal()
        buf = ''
      }
    }
  })
}

function openAdminModal(){
  adminModal.setAttribute('aria-hidden', 'false')
  adminPassInput.value = ''
  adminPassInput.focus()
}
function closeAdminModal(){
  adminModal.setAttribute('aria-hidden', 'true')
}

function openAdminConsole(){
  // reveal admin actions in UI — simple approach: confirm and run purge
  if (!confirm('Admin unlocked — purge entire DB now?')) return
  deleteAllStickers()
}

// ===========================================================
// HELPERS: textures, status, counters
// ===========================================================
function loadTex(url, cb){
  if (textureCache.has(url)) return cb(textureCache.get(url))
  new THREE.TextureLoader().load(url, (t)=>{
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8
    textureCache.set(url,t); cb(t)
  })
}
function status(txt){ if(statusEl) statusEl.textContent = txt }

async function getTodayCount(){
  const since = new Date(Date.now()-24*60*60*1000).toISOString()
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
    if (--t<=0){ clearInterval(iv); updatePublishLabel(); publishBtn.disabled = false }
  }, 1000)
}

// ===========================================================
function animate(){ requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera) }
