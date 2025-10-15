// main.js — ToiletSticker (360 Orbit + fix + Supabase + anti-drag click)

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { createClient } from '@supabase/supabase-js'

// ---------- CONFIG ----------
const MODEL_URL = '/toilet.glb'
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON
)
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

// ---------- Three.js ----------
let scene, camera, renderer, controls, modelRoot
let stickerTexture = null, stickerMesh = null
let stickerScale = parseFloat(sizeRange.value)
let stickerRotZ = 0
let baseQuat = new THREE.Quaternion()

const LS_KEY = 'toilet-sticker-save'
const liveStickers = new Map()
const textureCache = new Map()

// ---------- Boot ----------
init()
animate()
bootstrapLive().then(updatePublishLabel).catch(console.warn)

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

  const hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 0.9)
  hemi.position.set(0,4,0); scene.add(hemi)
  const dir = new THREE.DirectionalLight(0xffffff, 1.3)
  dir.position.set(3.5,6,2.2); dir.castShadow = true; scene.add(dir)

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableZoom = false
  controls.enablePan  = false
  controls.rotateSpeed = 0.55
  controls.enableDamping = true
  controls.dampingFactor = 0.08

  // 🔓 360° complet autour du point fixe (vertical & horizontal)
  const EPS = 1e-3
  controls.minPolarAngle = EPS                  // ~0 rad
  controls.maxPolarAngle = Math.PI - EPS        // ~π rad
  controls.minAzimuthAngle = -Infinity
  controls.maxAzimuthAngle =  Infinity

  addUIEvents()
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

  // 🔒 distance fixe (on reste sur un anneau autour du centre)
  controls.minDistance = r * 0.9
  controls.maxDistance = r * 0.9

  // ⚠️ NE PAS réécrire min/max polar ici (on garde le 360° défini dans init)
  controls.update()
}

function findFloorY(root, c, box){
  const from = new THREE.Vector3(c.x, box.max.y + 0.5, c.z)
  const rc = new THREE.Raycaster(from, new THREE.Vector3(0,-1,0))
  const hits = rc.intersectObjects(root.children, true)
  return hits.length ? hits[0].point.y : box.min.y
}

// ===========================================================
// UI EVENTS + CLICK GUARD
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

  // --- Click-vs-Drag guard ---
  let downX=0, downY=0, downT=0, moved=false, isOrbiting=false
  controls.addEventListener('start', ()=>isOrbiting=true)
  controls.addEventListener('end',   ()=>isOrbiting=false)

  renderer.domElement.addEventListener('pointerdown', e=>{
    downX=e.clientX; downY=e.clientY; downT=performance.now(); moved=false
  })
  renderer.domElement.addEventListener('pointermove', e=>{
    if (moved) return
    const dx=e.clientX-downX, dy=e.clientY-downY
    if (dx*dx+dy*dy>36) moved=true // >6px
  })
  renderer.domElement.addEventListener('pointerup', e=>{
    const dt=performance.now()-downT
    const dx=e.clientX-downX, dy=e.clientY-downY
    const dist2=dx*dx+dy*dy
    if (isOrbiting || moved || dist2>36 || dt>300) return // pas un "vrai" clic
    tryPlaceStickerFromPointer(e)
  })
}

// pose au clic court
function tryPlaceStickerFromPointer(ev){
  if (!stickerTexture) return
  const rect=renderer.domElement.getBoundingClientRect()
  const mouse=new THREE.Vector2(
    ((ev.clientX-rect.left)/rect.width)*2-1,
    -((ev.clientY-rect.top)/rect.height)*2+1
  )
  const ray=new THREE.Raycaster()
  ray.setFromCamera(mouse,camera)
  const hits=ray.intersectObjects(scene.children,true)
  if(!hits.length)return
  const hit=hits[0]
  let n=new THREE.Vector3(0,0,1)
  if(hit.face?.normal){
    n.copy(hit.face.normal)
    hit.object.updateMatrixWorld()
    n.transformDirection(hit.object.matrixWorld).normalize()
  }
  if(Math.abs(n.y)>0.6){status('⛔ Place sur un mur');return}
  n=snappedWallNormal(n)
  const EPS=0.006
  const p=hit.point.clone().add(n.clone().multiplyScalar(EPS))
  placeOrMoveSticker(p,n)
  saveSticker()
}

// ===========================================================
// STICKERS (orientation locale stable)
// ===========================================================
function snappedWallNormal(n){
  const v=n.clone(); v.y=0
  if(v.lengthSq()<1e-6)return new THREE.Vector3(0,0,1)
  v.normalize()
  return Math.abs(v.x)>Math.abs(v.z)
    ? new THREE.Vector3(Math.sign(v.x)||1,0,0)
    : new THREE.Vector3(0,0,Math.sign(v.z)||1)
}

function makeStickerQuaternion(normal){
  const n=normal.clone().normalize()
  const worldUp=Math.abs(n.y)>0.9?new THREE.Vector3(1,0,0):new THREE.Vector3(0,1,0)
  const tangent=worldUp.clone().cross(n).normalize()
  const bitangent=n.clone().cross(tangent).normalize()
  const m=new THREE.Matrix4().makeBasis(tangent,bitangent,n)
  return new THREE.Quaternion().setFromRotationMatrix(m)
}

function placeOrMoveSticker(point, normal){
  if(stickerMesh){
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
  }
  const geom=new THREE.PlaneGeometry(1,1)
  const mat =new THREE.MeshBasicMaterial({ map:stickerTexture, transparent:true })
  stickerMesh=new THREE.Mesh(geom,mat)
  stickerMesh.position.copy(point)
  stickerMesh.scale.set(stickerScale,stickerScale,1)
  baseQuat=makeStickerQuaternion(normal)
  stickerMesh.quaternion.copy(baseQuat)
  applyStickerRotation()
  scene.add(stickerMesh)
  status('Sticker placed ✓ — Publish to share')
}

function applyStickerRotation(){
  if(!stickerMesh)return
  stickerMesh.quaternion.copy(baseQuat)
  stickerMesh.rotateOnAxis(new THREE.Vector3(0,0,1),stickerRotZ)
}

function saveSticker(){
  if(!stickerMesh)return
  const d={
    position:stickerMesh.position.toArray(),
    quaternion:stickerMesh.quaternion.toArray(),
    baseQuat:baseQuat.toArray(),
    scale:stickerScale,
    rotZ:stickerRotZ
  }
  localStorage.setItem(LS_KEY,JSON.stringify(d))
}

function loadSticker(texture){
  const raw=localStorage.getItem(LS_KEY); if(!raw||!texture)return
  try{
    const d=JSON.parse(raw)
    const geom=new THREE.PlaneGeometry(1,1)
    const mat =new THREE.MeshBasicMaterial({ map:texture, transparent:true })
    stickerMesh=new THREE.Mesh(geom,mat)
    stickerMesh.position.fromArray(d.position)
    stickerScale=d.scale??0.35; sizeRange.value=String(stickerScale)
    stickerRotZ =d.rotZ ??0;    rotRange.value =String((stickerRotZ*180)/Math.PI)
    stickerMesh.scale.set(stickerScale,stickerScale,1)
    if(d.baseQuat){ baseQuat.fromArray(d.baseQuat); applyStickerRotation() }
    else{ const qF=new THREE.Quaternion().fromArray(d.quaternion)
          const qR=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),stickerRotZ)
          baseQuat.copy(qF).multiply(qR.invert()); applyStickerRotation() }
    scene.add(stickerMesh)
  }catch(e){console.warn('Load sticker error',e)}
}

function removeLocalSticker(){
  if(stickerMesh){
    scene.remove(stickerMesh)
    stickerMesh.geometry?.dispose()
    stickerMesh.material?.dispose()
    stickerMesh=null
  }
  localStorage.removeItem(LS_KEY)
  status('Sticker removed')
}

// ===========================================================
// SUPABASE (Storage + INSERT RLS quota 2/j + live)
// ===========================================================
async function publishSticker(){
  if(!stickerMesh||!fileInput.files?.[0])return status('⚠️ Pick a file and place it first')
  try{
    lockPublish(false)
    status('Uploading…')
    const file=fileInput.files[0]
    const ext=(file.name.split('.').pop()||'png').toLowerCase()
    const path=`users/${SESSION_ID}/${Date.now()}.${ext}`
    const { error:upErr }=await supabase.storage.from(BUCKET).upload(path,file,{ upsert:true, contentType:file.type })
    if(upErr)throw upErr
    const { data:pub }=supabase.storage.from(BUCKET).getPublicUrl(path)
    const image_url=pub.publicUrl
    const row={
      session_id:SESSION_ID,
      image_url,
      position:stickerMesh.position.toArray(),
      quaternion:stickerMesh.quaternion.toArray(),
      base_quat:baseQuat.toArray(), // optionnel si colonne ajoutée
      scale:stickerScale,
      axis:[0,0,1],
      rotz:stickerRotZ
    }
    const { error:insErr }=await supabase.from(TABLE).insert(row)
    if(insErr)throw insErr
    status('✅ Published')
    await updatePublishLabel()
  }catch(e){
    console.error(e)
    const msg=String(e?.message||e)
    if(msg.includes('violates row-level security')||msg.includes('quota_ok'))
      status('⛔ Limit reached: 2 stickers / 24h')
    else if(msg.includes('Bucket')) status('⛔ Storage bucket/policy issue')
    else status('❌ Publish error')
    cooldownPublish()
  }finally{ lockPublish(true) }
}

async function bootstrapLive(){
  const { data, error }=await supabase.from(TABLE)
    .select('*').order('created_at',{ascending:true}).limit(500)
  if(!error)data?.forEach(addLiveFromRow)
  supabase
    .channel('stickers-live')
    .on('postgres_changes',{ event:'INSERT', schema:'public', table:TABLE },payload=>{
      addLiveFromRow(payload.new)
      if(payload.new?.session_id===SESSION_ID)updatePublishLabel()
    })
    .subscribe()
}

function addLiveFromRow(row){
  if(!row?.id||liveStickers.has(row.id))return
  loadTex(row.image_url,(tex)=>{
    const g=new THREE.PlaneGeometry(1,1)
    const m=new THREE.MeshBasicMaterial({ map:tex, transparent:true })
    const mesh=new THREE.Mesh(g,m)
    mesh.position.fromArray(row.position)
    mesh.quaternion.fromArray(row.quaternion)
    mesh.scale.set(row.scale??0.35,row.scale??0.35,1)
    scene.add(mesh)
    liveStickers.set(row.id,mesh)
  })
}

// ===========================================================
// HELPERS
// ===========================================================
function loadTex(url,cb){
  if(textureCache.has(url))return cb(textureCache.get(url))
  new THREE.TextureLoader().load(url,(t)=>{
    t.colorSpace=THREE.SRGBColorSpace; t.anisotropy=8
    textureCache.set(url,t); cb(t)
  })
}
function status(txt){ statusEl.textContent=txt }

async function getTodayCount(){
  const since=new Date(Date.now()-24*60*60*1000).toISOString()
  const res=await supabase.from(TABLE)
    .select('id',{count:'exact',head:true})
    .gte('created_at',since)
    .eq('session_id',SESSION_ID)
  return res?.count??0
}
async function updatePublishLabel(){
  try{
    const c=await getTodayCount()
    publishBtn.textContent=`Publish ${Math.min(c,2)}/2`
  }catch{}
}
function lockPublish(enabled){ publishBtn.disabled=!enabled }
function cooldownPublish(){
  publishBtn.disabled=true
  let t=10
  const iv=setInterval(()=>{
    publishBtn.textContent=`Retry in ${t}s`
    if(--t<=0){clearInterval(iv);updatePublishLabel();publishBtn.disabled=false}
  },1000)
}

// ===========================================================
function animate(){ requestAnimationFrame(animate); controls.update(); renderer.render(scene,camera) }
