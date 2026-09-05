import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Environment, type StaticMeshSpec } from './environment';
import { Race, type RoutePoint } from './race';
import { Input } from './input';
import { TutorialProgress } from './tutorial';
import { Sound } from './audio';
import { getJSON } from './data-loader';
import { getProjectileContact } from './projectile-contact';
import './style.css';

interface Stage {
  metadata: {name:string;origin: number[];source?:string;sourceDate?:string;status?:string;license?:string;attribution?:string;[key:string]:unknown};
  chunks: {id:string;url:string;bounds?:number[]}[];
  route: RoutePoint[];
  routeStatus?:string;
}
type Phase = 'loading'|'title'|'tutorial'|'countdown'|'race'|'free'|'paused'|'results'|'error';
type Item = 'paint'|'bomb';
type Pickup = {mesh:THREE.Group;at:THREE.Vector3;item:Item;availableAt:number};
type Projectile = {mesh:THREE.Mesh;body:RAPIER.RigidBody;collider:RAPIER.Collider;ownerId:number;previous:THREE.Vector3;item:Item;age:number;color:number};
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = '<canvas id="world" aria-label="MachiShiftの3D走行画面"></canvas><div id="ui"></div>';
const ui = document.querySelector<HTMLDivElement>('#ui')!;
const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const sound = new Sound();
const input = new Input();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa4cce3);
scene.fog = new THREE.Fog(0xb4d0df, 270, 1000);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, .15, 1800);
let renderer: THREE.WebGLRenderer;
let world: RAPIER.World;
let environment: Environment;
let race: Race;
let stage: Stage;
let phase: Phase = 'loading', previousPhase: Phase = 'race';
let elapsed = 0, countdown = 3.6, previousTick = 4, accumulator = 0, lastFrame = 0, uiClock = 0;
const tutorialState = new TutorialProgress();
let tutorialStep = 0;
let inventory: Item[] = [], selected = 0, thrownCount = 0, paintHits = 0, bombHits = 0, recoveries = 0;
const aiInventory = new Map<number, Item[]>();
const aiNextThrow = new Map<number, number>();
let pickups: Pickup[] = [], projectiles: Projectile[] = [];
let toastText = '', toastUntil = 0;
let autoDrive = false, stressStarted = false, stressUntil = 0;
let stressNextBurst=0, stressBurstCount=0, raceCycle=0, memorySampleAt=0;
const memorySamples:Record<string,unknown>[]=[];
let frameTimes: number[] = [], measuredFrames: number[] = [];
let measurement: Record<string,unknown>|null = null;
let frameBefore = performance.now(), initializedAt = 0;
let lastBoost = false, lastLap = 1;
let finishedCount = 0;
let qaVisible = new URLSearchParams(location.search).has('qa');
const fx: {mesh:THREE.Mesh;age:number;duration:number;scale:number}[] = [];
const routeMarkers = new THREE.Group();
const directionMarker = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.5, 3),new THREE.MeshBasicMaterial({color:0xceff48}));
const aimMarker = new THREE.Mesh(new THREE.RingGeometry(.35,.55,32),new THREE.MeshBasicMaterial({color:0xceff48,side:THREE.DoubleSide,depthTest:false}));
aimMarker.visible = false; aimMarker.renderOrder = 100;
const aimTrajectory=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xceff48,transparent:true,opacity:.8}));
aimTrajectory.visible=false;
let aimClock=0;
let aimObjectId:string|null=null;
const raycaster = new THREE.Raycaster();
const cameraTarget = new THREE.Vector3();
const cameraDesired = new THREE.Vector3();
const up = new THREE.Vector3(0,1,0);
let loadedMeshes: THREE.Mesh[] = [];
let cullClock=0;
const unloadedChunks = new Set<string>();
const escape = (s:unknown) => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const clock = (t:number) => `${Math.floor(t/60).toString().padStart(2,'0')}:${(t%60).toFixed(2).padStart(5,'0')}`;
const $ = <T extends HTMLElement = HTMLElement>(selector:string) => ui.querySelector<T>(selector);
const bind = (id:string,fn:()=>void) => $<HTMLButtonElement>(id)?.addEventListener('click',fn);
const safeStorage = { get(key:string) { try{return localStorage.getItem(key);}catch{return null;} }, set(key:string,value:string) {try{localStorage.setItem(key,value);}catch{/* Private mode: preference need not persist. */}} };
let renderQuality:'high'|'low' = safeStorage.get('machishift-quality')==='low' ? 'low' : 'high';
function applyRenderQuality(){
  renderer.setPixelRatio(renderQuality==='low' ? .5 : 1);
  renderer.shadowMap.enabled=renderQuality==='high';
  renderer.shadowMap.needsUpdate=true;
  const materials=new Set<THREE.Material>();
  scene.traverse(object=>{if(object instanceof THREE.Mesh)for(const material of Array.isArray(object.material)?object.material:[object.material])materials.add(material);});
  for(const material of materials)material.needsUpdate=true;
}


function footer() {
  return `<div class="footer"><span>岐阜駅北口 · PLATEAU 2024年度モデル · <button id="credits">出典・再現範囲</button></span><span>非公式ゲーム / 地理精度の受入検証中</span></div>`;
}
function showLoading(progress:number,text:string) {
  ui.innerHTML=`<div class="modal"><div class="dialog"><p class="eyebrow">MACHISHIFT / GIFU</p><h1>街を読み込んでいます</h1><div class="loading" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><div style="width:${progress}%"></div></div><p role="status">${escape(text)}</p></div></div>`;
}
function showError(error:unknown) {
  phase='error';
  const message = error instanceof Error ? error.message : String(error);
  const graphics=/WebGL|描画コンテキスト/.test(message);
  ui.innerHTML=`<div class="modal"><div class="dialog"><p class="eyebrow">MACHISHIFT</p><h1>${graphics?'3D描画を開始できませんでした':'街を読み込めませんでした'}</h1><p>${graphics?'WebGL2とGPUアクセラレーションが有効なPCブラウザーで開いてください。':'接続をご確認のうえ、もう一度お試しください。'}</p><p class="fine">${escape(message)}</p><button id="retry" class="primary">再試行 <span>↻</span></button></div></div>`;
  bind('#retry',()=>location.reload());
  console.error(error);
}
function showTitle() {
  phase='title'; input.clear();
  ui.innerHTML=`<div class="menu"><div class="menu-inner"><p class="eyebrow">STREET RACING / GIFU 01</p><h1 class="logo">Machi<span>Shift</span></h1><div class="location">岐阜駅北口</div><p class="description">街を走る。色を残す。道をひらく。<br>爆弾とペイントで、次の一周を変えよう。</p><div class="mode-buttons"><button class="primary" id="start">レースを始める <span>→</span></button><button class="secondary" id="free">自由走行</button></div><div class="menu-meta"><span>6台 / 3周</span><span>${(race.routeLength/1000).toFixed(2)} km / 周</span><span>昼・晴れ</span></div><span class="status-tag">実データを使用 / 再現・受入検証中</span><div class="help-bar"><button class="ghost" id="tutorial">操作を練習する</button><button class="ghost" id="controls">操作方法</button><button class="ghost" id="sound">音 ${sound.enabled?'ON':'OFF'}</button><button class="ghost" id="quality" title="軽量は3Dの描画解像度を半分にし、影を省きます。">${renderQuality==='high'?'描画を軽量にする':'描画を高品質にする'}</button></div></div></div>${footer()}`;
  bind('#start',()=>{ sound.unlock(); safeStorage.get('machishift-tutorial')==='done' ? beginRace() : beginTutorial(); });
  bind('#free',()=>{sound.unlock();reset('free');phase='free';renderHUD();toast('自由走行 · 近くの補給ポイントでアイテムを拾おう');});
  bind('#tutorial',()=>{sound.unlock();beginTutorial();});
  bind('#controls',()=>showControls('title'));
  bind('#sound',()=>{sound.enabled=!sound.enabled;showTitle();});
  bind('#quality',()=>{renderQuality=renderQuality==='high'?'low':'high';safeStorage.set('machishift-quality',renderQuality);applyRenderQuality();showTitle();});
  bind('#credits',showCredits);
}
function reset(mode:'race'|'free') {
  if(stressStarted)finishStress('interrupted-by-reset');
  raceCycle++;
  clearProjectiles();environment.removeChunk('stress');environment.reset();
  for(const chunk of unloadedChunks)environment.reloadChunk(chunk);unloadedChunks.clear();loadedMeshes=environment.meshes;
  race.reset(mode); elapsed=0; accumulator=0; input.clear();
  inventory=[];selected=0;thrownCount=0;paintHits=0;bombHits=0;recoveries=0;autoDrive=false;stressStarted=false;
  aiInventory.clear();aiNextThrow.clear();
  for(const p of pickups){p.availableAt=0;p.mesh.visible=true;}
  for(const f of fx){scene.remove(f.mesh);f.mesh.geometry.dispose();(f.mesh.material as THREE.Material).dispose();}fx.length=0;
  lastLap=1;lastBoost=false;finishedCount=0;toastText=''; camera.position.copy(new THREE.Vector3(...race.route[0]).add(new THREE.Vector3(0,8,-12)));
}
function beginRace() { reset('race'); countdown=3.6;previousTick=4;phase='countdown';renderHUD(); }
function beginTutorial() {reset('free');phase='tutorial';tutorialState.reset();tutorialStep=0;inventory=['paint','bomb'];renderHUD();}
const lessons = [
  ['走り出そう','W / ↑、または RT を押して加速。カートを前へ走らせよう。'],
  ['曲がってみよう','A・D / ←・→、または左スティック。光る案内に沿って進もう。'],
  ['ドリフトで加速','走りながら Shift（パッド A）とハンドルを操作。ゲージをため、離すとブースト。'],
  ['アイテムを構えよう','Space（パッド RB）を押し続ける。マウス / 右スティックで狙おう。'],
  ['投げて街を変えよう','Space / RB を離して投げる。ペイントは当たった場所に残る。'],
  ['困ったら復帰','R（パッド Y）で直前の安全な場所へ。周回は進まない。'],
];
function renderHUD() {
  ui.innerHTML=`<div class="hud-top"><div class="race-info"><div class="small-logo">Machi<span>Shift</span></div><div class="lapline"><span class="label" id="lap">LAP <strong>1 <small>/ 3</small></strong></span><span class="time" id="time">00:00.00</span></div></div><div class="ranking"><div class="rank"><strong id="rank">6</strong><small> / 6</small></div><button id="pause" class="pause-btn" aria-label="一時停止">Ⅱ</button></div></div><div class="navigation"><span class="arrow" id="nav-arrow">↑</span><span><b id="nav-text">スタートへ</b><br><small id="nav-distance">ルートの光を追おう</small></span></div><div class="minimap"><div class="map-label">GIFU / NORTH STATION</div><canvas id="map" width="330" height="330" aria-label="コースと6台の位置"></canvas></div><div class="speed-panel"><span class="speed-number" id="speed">0</span><span class="speed-unit">km/h</span><div class="drift-track"><div class="drift-fill" id="drift-fill"></div></div><span class="drift-label" id="drift-label">SHIFT + ハンドルでドリフト</span></div><div class="item-panel"><div class="item-icon" id="item-icon">＋</div><div><b id="item-title">アイテムを拾おう</b><small id="item-action">コース上の補給ポイントへ</small><small id="item-other"></small></div></div><div class="controls-ribbon"><kbd>WASD</kbd> 走行　<kbd>Shift</kbd> ドリフト　<kbd>Space</kbd> 構える・離して投げる　<kbd>E</kbd> 切替　<kbd>R</kbd> 復帰</div><div id="center" class="center-message"></div><div id="toast" class="toast" role="status"></div><div id="lesson"></div><div id="aim-ui"></div><div id="hazards" aria-label="有効な路面ペイント"></div><div id="grip-status" role="status"></div><div id="boost"></div>${footer()}${qaVisible?'<details id="qa"><summary>検証パネル</summary><button id="auto">自動走行を開始</button><button id="stress">指定負荷を実行</button><button id="reload-chunks">区画表示を再読込</button><button id="save-report">計測を保存</button><pre id="diagnostics" aria-label="実行状態の検証記録"></pre></details>':''}`;
  bind('#pause',pause);bind('#credits',showCredits);
  bind('#auto',()=>{autoDrive=!autoDrive;$<HTMLButtonElement>('#auto')!.textContent=autoDrive?'自動走行を停止':'自動走行を開始';});
  bind('#stress',startStress);
  bind('#reload-chunks',()=>{
    for(const c of stage.chunks) environment.unloadChunk(c.id);
    for(const c of stage.chunks) environment.reloadChunk(c.id);
    unloadedChunks.clear();loadedMeshes=environment.meshes;
    toast('区画を解放・再構築 · 破壊・塗装状態を復元');
  });
  bind('#save-report',saveReport);
  updateHUD();
}
function toast(text:string,seconds=3.5) {toastText=text;toastUntil=performance.now()/1000+seconds;}
function pause() {
  if(!['race','free','tutorial','countdown'].includes(phase))return;
  previousPhase=phase;phase='paused';input.clear();showPause();
}
function showPause() {
  ui.insertAdjacentHTML('beforeend',`<div class="modal" id="pause-modal"><div class="dialog"><p class="eyebrow">PAUSED</p><h2>ひと休み</h2><button id="resume" class="primary">走行に戻る <span>→</span></button><button id="restart" class="secondary">新しいレース</button><button id="help" class="secondary">操作方法</button><button id="back-title" class="ghost">タイトルへ</button></div></div>`);
  bind('#resume',resume);bind('#restart',beginRace);bind('#help',()=>showControls('paused'));bind('#back-title',showTitle);
}
function resume(){phase=previousPhase;input.clear();renderHUD();}
function showControls(returnTo:Phase) {
  const prior = ui.innerHTML;
  ui.innerHTML=`<div class="modal"><div class="dialog"><p class="eyebrow">CONTROLS</p><h2>走る・狙う・街を変える</h2><table><thead><tr><th>操作</th><th>キーボード</th><th>ゲームパッド</th></tr></thead><tbody><tr><td>加速 / ブレーキ</td><td>W / S または ↑ / ↓</td><td>RT / LT</td></tr><tr><td>ハンドル</td><td>A / D または ← / →</td><td>左スティック</td></tr><tr><td>ドリフト</td><td>Shift + ハンドル</td><td>A + 左スティック</td></tr><tr><td>構える / 投げる</td><td>Space を押す / 離す</td><td>RB を押す / 離す</td></tr><tr><td>照準</td><td>構えてマウスを動かす</td><td>右スティック</td></tr><tr><td>アイテム切替</td><td>E</td><td>X</td></tr><tr><td>復帰</td><td>R</td><td>Y</td></tr><tr><td>一時停止</td><td>Esc</td><td>Start</td></tr></tbody></table><p>ペイントは縞模様で表示されます。警告の残り秒数が出ている間は、表示された半径内で全車のグリップが低下します。効果は8秒、色はレース終了まで残ります。爆弾で仮設柵を壊すと通り抜けられます。</p><button id="close-help" class="primary">戻る</button></div></div>`;
  bind('#close-help',()=>{if(returnTo==='title')showTitle();else{ui.innerHTML=prior;renderHUD();phase='paused';showPause();}});
}
function showCredits() {
  const returnTo=phase;
  if(['race','free','tutorial','countdown'].includes(phase)){previousPhase=phase;phase='paused';}
  ui.innerHTML=`<div class="modal"><div class="dialog"><p class="eyebrow">SOURCES & STAGE</p><h2>岐阜駅北口の再現範囲</h2><p>街の形状は、国土交通省 Project PLATEAUの岐阜市2024年度CityGMLを切り出し、メートル単位に変換して使用しています。</p><p>${escape(stage.metadata.attribution ?? '国土交通省 Project PLATEAU「3D都市モデル（岐阜市）」を加工して作成')}</p><p><a href="https://www.geospatial.jp/ckan/dataset/plateau-21201-gifu-shi-2024" target="_blank" rel="noreferrer">岐阜市データセット</a> · <a href="https://www.mlit.go.jp/plateau/site-policy/" target="_blank" rel="noreferrer">利用条件</a></p><p>公開年度と測量・撮影年は異なります。原典年月は素材台帳で管理し、不明なものは未確認としています。道路端・段差・建物低層部の現地照合は未実施です。現在の街との一致や測量精度を保証する状態には達していません。</p><p>光るルート案内、補給ポイント、黄色い破壊用柵はゲーム用の仮設物です。実在の設備とは区別して管理しています。現実の構造性能や爆発挙動を再現するものではありません。</p><p>カート・画面・効果音は本ゲーム用の独自制作。実在施設、自治体、データ提供者の公式ゲームではありません。</p><p class="fine">ライブラリ: Three.js (MIT)、Rapier (Apache-2.0)。詳細な出典・加工履歴・未確認事項はリポジトリ内の台帳をご覧ください。</p><button id="close-credits" class="primary">戻る</button></div></div>`;
  $('#close-credits')!.insertAdjacentHTML('beforebegin', `<table id="source-dates"><caption>採用する街の基準時点</caption><tbody><tr><th>採用版</th><td>${escape(stage.metadata.edition)}</td></tr><tr><th>道路・広場・橋・地形・建物・設備の測量／撮影年月</th><td>${escape(stage.metadata.surveyDate ?? '不明（原典は属性ごとに時点が異なり、各地物との対応は未確認）')}</td></tr><tr><th>現地補修年月</th><td>未実施</td></tr><tr><th>表現する時点</th><td>採用した公開原典の時点。現在の街との一致は未確認</td></tr></tbody></table>`);
  bind('#close-credits',()=>{if(returnTo==='title')showTitle();else if(returnTo==='results')showResults();else{phase='paused';renderHUD();showPause();}});
}
function showResults() {
  if(phase!=='results')sound.cue('finish');phase='results';finishedCount=race.vehicles.filter(v=>v.finished).length;
  const order=[...race.vehicles].sort((a,b)=>a.rank-b.rank);
  ui.innerHTML=`<div class="modal"><div class="dialog"><p class="eyebrow">RACE COMPLETE / GIFU</p><h1>街に、足跡を残した。</h1><div class="result-rank">${race.player.rank}<span style="font-size:1.5rem"> / 6</span></div><p>3周の記録 <strong>${clock(race.player.finishTime??race.elapsed)}</strong></p>${order.map(v=>`<div class="result-row ${v.id===0?'player':''}"><span>${v.rank}</span><span>${escape(v.name)}</span><span>${v.finished?clock(v.finishTime??0):'走行中'}</span></div>`).join('')}<p class="fine">自分のペイント命中 ${paintHits} / 投擲 ${thrownCount} / 街の破壊箇所 ${environment.stats.destroyed}</p><button id="again" class="primary">もう一度走る <span>↻</span></button><button id="result-free" class="secondary">自由走行へ</button><button id="result-title" class="ghost">タイトルへ</button></div></div>${footer()}`;
  bind('#again',beginRace);bind('#result-free',()=>{reset('free');phase='free';renderHUD();});bind('#result-title',showTitle);bind('#credits',showCredits);
}
function updateHUD() {
  if(!race)return;
  const player=race.player;
  const assign=(id:string,text:string)=>{const el=$(id);if(el)el.textContent=text;};
  assign('#speed',Math.round(Math.abs(player.speed)*3.6).toString());
  if($('#lap'))$('#lap')!.innerHTML=phase==='free'||phase==='tutorial'?'FREE RUN':`LAP <strong>${player.lap} <small>/ 3</small></strong>`;
  assign('#rank',player.rank.toString());assign('#time',clock(race.elapsed));
  const next=new THREE.Vector3(...race.route[player.checkpoint%race.route.length]);
  const pos=new THREE.Vector3().copy(player.body.translation());
  const diff=next.clone().sub(pos);const angle=Math.atan2(diff.x,diff.z)-player.heading;
  const normalized=Math.atan2(Math.sin(angle),Math.cos(angle));
  assign('#nav-arrow',Math.abs(normalized)>.32?(normalized>0?'↰':'↱'):'↑');
  assign('#nav-text',Math.abs(normalized)>1.5?'ルートに戻ろう':Math.abs(normalized)>.32?(normalized>0?'左へ':'右へ'):'この先へ');
  assign('#nav-distance',`${Math.round(Math.hypot(diff.x,diff.z))} m · 光る案内へ`);
  if($('#drift-fill'))$('#drift-fill')!.style.width=`${Math.min(100,player.driftCharge*100)}%`;
  assign('#drift-label',player.boost>0?'BOOST!':player.driftCharge>.2?'離すとブースト':input.device==='ゲームパッド'?'A + ハンドルでドリフト':'SHIFT + ハンドルでドリフト');
  if($('#boost'))$('#boost')!.className=player.boost>0?'boost-glow':'';
  const item=inventory[selected];
  assign('#item-icon',item==='paint'?'◈':item==='bomb'?'✹':'＋');
  assign('#item-title',item==='paint'?'ブルーペイント':item==='bomb'?'インパクトボム':'アイテムを拾おう');
  assign('#item-action',item?(input.device==='ゲームパッド'?'RB を構えて、離して投げる':'Space を構えて、離して投げる'):'コース上の補給ポイントへ');
  assign('#item-other',inventory.length>1?`${input.device==='ゲームパッド'?'X':'E'} で切替 · ${inventory.length}個`:'');
  assign('#toast',performance.now()/1000<toastUntil?toastText:'');
  if($('#center'))$('#center')!.innerHTML=phase==='countdown'?`<div class="countdown">${Math.ceil(countdown)>0?Math.ceil(countdown):'GO'}</div>`:'';
  if($('#aim-ui'))$('#aim-ui')!.innerHTML=input.aiming&&item?'<div class="aim-text">軌道の先へ · 離して投げる</div>':'';
  const lesson = $('#lesson');
  const lessonKey = phase==='tutorial' ? String(tutorialStep) : '';
  // Keep the interactive button stable between lesson changes, including focus
  // and a pointer press spanning multiple HUD refreshes.
  if(lesson && lesson.dataset.step!==lessonKey) {
    lesson.dataset.step=lessonKey;
    lesson.innerHTML=phase==='tutorial'?`<div class="tutorial"><div class="steps">${lessons.map((_,i)=>`<i class="${i<=tutorialStep?'done':''}"></i>`).join('')}</div><h2>${tutorialStep+1}. ${lessons[tutorialStep][0]}</h2><p>${lessons[tutorialStep][1]}</p><button class="ghost" id="skip-lesson">練習をスキップしてレースへ</button></div>`:'';
    bind('#skip-lesson',beginRace);
  }
  drawMap();
  updateHazardLabels(pos);
  updateDiagnostics();
}
function updateDiagnostics(){
  if(qaVisible && $('#diagnostics'))$('#diagnostics')!.textContent=JSON.stringify(diagnostics(),null,2);
}
function updateHazardLabels(playerPosition:THREE.Vector3){
  const zones=environment.activeGripZones;
  const nearby=zones.filter(z=>z.center.distanceTo(playerPosition)<45).sort((a,b)=>a.center.distanceToSquared(playerPosition)-b.center.distanceToSquared(playerPosition)).slice(0,6);
  const labels=nearby.flatMap(zone=>{
    const point=zone.center.clone().add(new THREE.Vector3(0,.5,0)),projected=point.clone().project(camera);
    if(projected.z<-1||projected.z>1||Math.abs(projected.x)>.88||Math.abs(projected.y)>.8||!environment.hasLineOfSight(camera.position,point))return [];
    return [`<span class="hazard-label" style="left:${(projected.x+1)*50}%;top:${(1-projected.y)*50}%">⚠ グリップ低下<br><small>半径 ${zone.radius.toFixed(1)} m · あと ${Math.max(0,zone.expiresAt-elapsed).toFixed(1)} 秒</small></span>`];
  });
  const overlay=$('#hazards');if(overlay)overlay.innerHTML=labels.join('');
  const status=$('#grip-status');if(status){
    const affected=environment.gripAt(playerPosition,elapsed)<1;
    status.textContent=affected?'⚠ GRIP ↓ · 全車共通':'';
  }
}
function drawMap() {
  const map=$<HTMLCanvasElement>('#map');if(!map)return;
  const ctx=map.getContext('2d')!;const size=330;
  const xs=race.route.map(p=>p[0]),zs=race.route.map(p=>p[2]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minZ=Math.min(...zs),maxZ=Math.max(...zs);
  const scale=(size-50)/Math.max(maxX-minX,maxZ-minZ);
  const point=(x:number,z:number)=>[size/2+(x-(minX+maxX)/2)*scale,size/2+(z-(minZ+maxZ)/2)*scale];
  ctx.clearRect(0,0,size,size);ctx.strokeStyle='#526777';ctx.lineWidth=14;ctx.lineJoin='round';ctx.beginPath();
  race.route.forEach((p,i)=>{const [x,z]=point(p[0],p[2]);i?ctx.lineTo(x,z):ctx.moveTo(x,z);});ctx.closePath();ctx.stroke();ctx.strokeStyle='#c6e9f6';ctx.lineWidth=3;ctx.stroke();
  for(const v of [...race.vehicles].reverse()) {if(race.mode==='free'&&v.id!==0)continue;const p=v.body.translation();const [x,z]=point(p.x,p.z);ctx.fillStyle=v.id===0?'#ceff48':`#${new THREE.Color(v.color).getHexString()}`;ctx.beginPath();ctx.arc(x,z,v.id===0?10:6,0,Math.PI*2);ctx.fill();if(v.id===0){ctx.strokeStyle='#152535';ctx.lineWidth=3;ctx.stroke();}}
  const [sx,sz]=point(race.route[0][0],race.route[0][2]);ctx.fillStyle='#fff';ctx.fillRect(sx-4,sz-4,8,8);
}
function addRaceObjects() {
  scene.add(routeMarkers);scene.add(directionMarker);scene.add(aimMarker);scene.add(aimTrajectory);
  const ringGeometry=new THREE.RingGeometry(.9,1.2,24);const ringMaterial=new THREE.MeshBasicMaterial({color:0xccff65,transparent:true,opacity:.65,side:THREE.DoubleSide});
  for(let distance=12;distance<race.routeLength;distance+=18) {
    const point=race.sampleRoute(distance);
    const mesh=new THREE.Mesh(ringGeometry,ringMaterial);mesh.rotation.x=-Math.PI/2;mesh.position.copy(point).add(new THREE.Vector3(0,.08,0));routeMarkers.add(mesh);
  }
  let i=0;
  for(let distance=16;distance<race.routeLength;distance+=90) {
    const at=race.sampleRoute(distance===106?76:distance),item:Item=i++%2?'bomb':'paint';
    const group=new THREE.Group();const color=item==='paint'?0x55c9ff:0xffb85a;
    const body=new THREE.Mesh(item==='paint'?new THREE.CylinderGeometry(.57,.57,1.3,8):new THREE.IcosahedronGeometry(.95,0),new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.2,metalness:.25,roughness:.3}));
    if(item==='paint'){
      const stripe=new THREE.Mesh(new THREE.TorusGeometry(.59,.055,4,8),new THREE.MeshBasicMaterial({color:0xffffff}));stripe.rotation.x=Math.PI/2;body.add(stripe);
      const lid=new THREE.Mesh(new THREE.CylinderGeometry(.64,.64,.14,8),new THREE.MeshStandardMaterial({color:0xf3f7ff,roughness:.35}));lid.position.y=.7;body.add(lid);
    }else{
      const band=new THREE.Mesh(new THREE.TorusGeometry(1.08,.085,6,12),new THREE.MeshBasicMaterial({color:0x17293b}));band.rotation.z=.65;body.add(band);
    }
    group.add(body);const ring=new THREE.Mesh(new THREE.TorusGeometry(1.45,.09,6,40),new THREE.MeshBasicMaterial({color}));ring.rotation.x=Math.PI/2;ring.position.y=-.5;group.add(ring);
    group.position.copy(at).add(new THREE.Vector3(0,1.7,0));scene.add(group);pickups.push({mesh:group,at,item,availableAt:0});
  }
  // Race infrastructure is deliberately tagged game_added, separate from source geometry.
  // The training fence is on the straight after the first bend. Its earlier
  // 32m placement pinched the racing line; source geometry stays unchanged.
  for(const distance of [72,race.routeLength*.31,race.routeLength*.62]) {
    const at=race.sampleRoute(distance),ahead=race.sampleRoute(distance+2),heading=Math.atan2(ahead.x-at.x,ahead.z-at.z);
    const side=new THREE.Vector3(Math.cos(heading),0,-Math.sin(heading));
    const center=at.clone().addScaledVector(side,4.5).add(new THREE.Vector3(0,1,0));
    environment.addBreakable({id:`game:fence:${Math.round(distance)}`,position:center.toArray() as RoutePoint,size:[5,1.8,.22],rotationY:heading,color:0xf2c450,chunkId:'game-added',kind:'fence',verification:'game_added'});
  }
  const shortcutAt=race.sampleRoute(115),shortcutNext=race.sampleRoute(117);
  environment.addBreakable({id:'game:shortcut-gate',position:shortcutAt.clone().add(new THREE.Vector3(0,1,0)).toArray() as RoutePoint,size:[7,1.8,.22],rotationY:Math.atan2(shortcutNext.x-shortcutAt.x,shortcutNext.z-shortcutAt.z),color:0xf2c450,chunkId:'game-added',kind:'fence',verification:'game_added'});
}
function launch() {
  if(!['race','free','tutorial'].includes(phase)||!inventory.length)return;
  const item=inventory.splice(selected,1)[0];selected=Math.min(selected,Math.max(0,inventory.length-1));
  launchFor(race.player,item,input.aimOffset);
  if(phase==='tutorial')tutorialState.record('throw');
  thrownCount++;sound.cue(item==='paint'?'paint':'tick');
}
function launchFor(player:Race['player'],item:Item,offset=0) {
  const heading=player.heading+offset;
  const direction=new THREE.Vector3(Math.sin(heading),.1,Math.cos(heading));
  const position=new THREE.Vector3().copy(player.body.translation()).add(new THREE.Vector3(0,.65,0)).addScaledVector(direction,2.2);
  const body=world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x,position.y,position.z).setCcdEnabled(true));
  const collider=world.createCollider(RAPIER.ColliderDesc.ball(.23).setDensity(.15).setRestitution(.3),body);
  const speed=25+Math.max(0,player.speed)*.65;body.setLinvel({x:direction.x*speed,y:3.8,z:direction.z*speed},true);
  const mesh=new THREE.Mesh(item==='bomb'?new THREE.IcosahedronGeometry(.32,1):new THREE.SphereGeometry(.27,12,8),new THREE.MeshStandardMaterial({color:item==='paint'?0x168aff:0xffa442,emissive:item==='paint'?0x064eaa:0x5e2600,emissiveIntensity:.6,roughness:.3}));
  scene.add(mesh);mesh.position.copy(position);projectiles.push({mesh,body,collider,ownerId:player.id,previous:position,item,age:0,color:0x168aff});
}
function clearProjectiles(){for(const p of projectiles){scene.remove(p.mesh);p.mesh.geometry.dispose();(p.mesh.material as THREE.Material).dispose();world.removeRigidBody(p.body);}projectiles=[];}
function updateProjectiles(dt:number) {
  for(let i=projectiles.length-1;i>=0;i--) {
    const p=projectiles[i];p.age+=dt;const now=new THREE.Vector3().copy(p.body.translation());const delta=now.clone().sub(p.previous);const distance=delta.length();
    const contact=getProjectileContact(world,p.collider);
    raycaster.set(p.previous,delta.clone().normalize());raycaster.far=distance+.35;
    const hit=distance>0?raycaster.intersectObjects(environment.paintTargets,false)[0]:null;
    const stopped=new THREE.Vector3().copy(p.body.linvel()).length()<2&&p.age>.2;
    const impact=Boolean(contact)||Boolean(hit)||stopped||p.age>(p.item==='bomb'?1.6:3);
    if(impact) {
      if(p.item==='paint'){
        const result=contact
          ? environment.paintCollider(contact.targetColliderHandle,contact.point,contact.normal,p.color)
          : environment.paintRay(p.previous,delta.lengthSq()>.001?delta:new THREE.Vector3(0,-1,0),p.color,hit?distance+.8:3);
        if(result && p.ownerId===0){paintHits++;toast('ペイント命中 · 色は次の周回にも残る',2);}
      }else{
        const normal=hit?.face?hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize():up;
        const point=contact?contact.point.clone().addScaledVector(contact.normal,.15):hit?hit.point.clone().addScaledVector(normal,.15):now;
        detonate(point);if(p.ownerId===0)bombHits++;
      }
      scene.remove(p.mesh);p.mesh.geometry.dispose();(p.mesh.material as THREE.Material).dispose();world.removeRigidBody(p.body);projectiles.splice(i,1);
    }else{p.mesh.position.copy(now);p.mesh.rotation.x+=dt*5;p.previous.copy(now);}
  }
}
function detonate(point:THREE.Vector3) {
  const result=environment.explode(point,12);
  for(const v of race.vehicles){if(race.mode==='free'&&v.id!==0)continue;const pos=new THREE.Vector3().copy(v.body.translation());const delta=pos.clone().sub(point),distance=delta.length();if(distance<12&&environment.hasLineOfSight(point,pos)){delta.y=.25;delta.normalize();v.body.applyImpulse(delta.multiplyScalar((1-distance/12)*v.body.mass()*9),true);}}
  const mesh=new THREE.Mesh(new THREE.IcosahedronGeometry(1,2),new THREE.MeshBasicMaterial({color:0xffd177,transparent:true,opacity:.7,wireframe:true}));mesh.position.copy(point);scene.add(mesh);fx.push({mesh,age:0,duration:.65,scale:12});sound.cue('blast');
  if(result.destroyed.length)toast(`柵が壊れた · ${result.fragments}個の破片に変化`,2.5);
}
function recover(){if(!['race','free','tutorial'].includes(phase))return;if(race.recover()){recoveries++;if(phase==='tutorial')tutorialState.record('recover');toast('直前の安全な位置へ復帰しました',2);}else toast('復帰先に車両があります。少し待ってお試しください。',2);}
function tutorial(dt:number,control:ReturnType<Input['sample']>){
  if(phase!=='tutorial')return;
  const v=race.player;
  // Early experimentation must not leave the later aim/throw lesson without an item.
  if((tutorialStep===3||tutorialStep===4)&&inventory.length===0){inventory=['paint'];selected=0;toast('練習用のペイントを補充しました',2);}
  if(tutorialState.update(dt,{active:phase==='tutorial',speed:v.speed,steer:control.steer,boost:v.boost,aiming:input.aiming})) {
    tutorialStep=tutorialState.step;sound.cue('pickup');
    if(tutorialState.complete){safeStorage.set('machishift-tutorial','done');beginRace();toast('準備完了。3周のレースを始めよう！');}
  }
}
function updateCamera(dt:number) {
  if(!race)return;
  const player=race.player,position=new THREE.Vector3().copy(player.body.translation());
  if(phase==='title') {
    const focus=race.sampleRoute(40);const a=performance.now()*.00002;
    cameraDesired.set(focus.x+Math.sin(a)*48,focus.y+28,focus.z+Math.cos(a)*48);camera.position.lerp(cameraDesired,1-Math.exp(-dt*2));camera.lookAt(focus.x,focus.y+4,focus.z);return;
  }
  const forward=new THREE.Vector3(Math.sin(player.heading),0,Math.cos(player.heading));
  cameraTarget.copy(position).add(new THREE.Vector3(0,1.4,0));
  cameraDesired.copy(position).addScaledVector(forward,-(input.aiming?7.5:9.5)).add(new THREE.Vector3(0,input.aiming?3.4:4.7,0));
  const arm=cameraDesired.clone().sub(cameraTarget),len=arm.length();raycaster.set(cameraTarget,arm.normalize());raycaster.far=len;
  const hit=raycaster.intersectObjects(loadedMeshes,false)[0];if(hit)cameraDesired.copy(cameraTarget).addScaledVector(arm,Math.max(1,hit.distance-.5));
  cameraDesired.y=Math.max(position.y+1.2,cameraDesired.y);
  camera.position.lerp(cameraDesired,1-Math.exp(-dt*8));
  const lookAt=cameraTarget.clone().addScaledVector(forward,5);camera.lookAt(lookAt);
  const fov=65+(player.boost>0?5:0)+Math.min(6,Math.abs(player.speed)/6);camera.fov=THREE.MathUtils.lerp(camera.fov,fov,1-Math.exp(-dt*4));camera.updateProjectionMatrix();
  directionMarker.position.set(...race.route[player.checkpoint%race.route.length]);directionMarker.position.y+=5;directionMarker.rotation.z=Math.PI;directionMarker.rotation.y=elapsed;
  if(input.aiming&&inventory.length){
    aimTrajectory.visible=true;aimClock+=dt;
    if(aimClock>.07){aimClock=0;predictAim(position);}
  }else{aimMarker.visible=false;aimTrajectory.visible=false;}
}
function predictAim(position:THREE.Vector3){
  const player=race.player,h=player.heading+input.aimOffset,d=new THREE.Vector3(Math.sin(h),.1,Math.cos(h));
  const origin=position.clone().add(new THREE.Vector3(0,.65,0)).addScaledVector(d,2.2);
  const speed=25+Math.max(0,player.speed)*.65;
  const maxTime=inventory[selected]==='bomb'?1.6:3;
  const points=[origin];let hit:THREE.Intersection|undefined;
  const targets=environment.paintTargets;
  for(let i=1;i<=32;i++){
    const t=i*maxTime/32;
    const next=origin.clone().add(new THREE.Vector3(d.x*speed*t,3.8*t-4.905*t*t,d.z*speed*t));
    const previous=points.at(-1)!,delta=next.clone().sub(previous);
    raycaster.set(previous,delta.clone().normalize());raycaster.far=delta.length()+.23;
    hit=raycaster.intersectObjects(targets,false)[0];
    if(hit){points.push(hit.point);break;}points.push(next);
  }
  aimTrajectory.geometry.dispose();aimTrajectory.geometry=new THREE.BufferGeometry().setFromPoints(points);
  aimObjectId=hit?.object.userData.objectId??null;
  aimMarker.visible=true;const target=points.at(-1)!;
  const normal=hit?.face?hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize():up.clone();
  aimMarker.position.copy(target).addScaledVector(normal,.04);aimMarker.lookAt(target.clone().add(normal));
}
function diagnostics(){
  const values=measuredFrames.length?measuredFrames:frameTimes;const sorted=[...values].sort((a,b)=>a-b);const p=(q:number)=>sorted[Math.floor((sorted.length-1)*q)]??0;
  return {phase,tutorialStep,aimObjectId,selectedItem:inventory[selected]??null,aimOffset:input.aimOffset,routeDistance:race.path.nearest(new THREE.Vector3().copy(race.player.body.translation())).distance,shortcut:environment.getState().filter(piece=>piece.objectId==='game:shortcut-gate'),aimPoint:aimMarker.visible?aimMarker.position.toArray():null,renderQuality,renderResolution:[canvas.width,canvas.height],sampledAtMilliseconds:performance.now(),elapsed:Math.round(elapsed*100)/100,courseMeters:race.routeLength,vehicles:race.vehicles.map(v=>({id:v.id,lap:v.lap,rank:v.rank,checkpoint:v.checkpoint,finished:v.finished,position:v.body.translation(),speed:v.speed,heading:v.heading,driftCharge:v.driftCharge,boost:v.boost})),...environment.stats,inventory,thrownCount,paintHits,bombHits,recoveries,autoDrive,loadMilliseconds:initializedAt,frameMilliseconds:{count:values.length,p50:p(.5),p95:p(.95),p99:p(.99),over100:values.filter(t=>t>100).length},measurement,memory:memorySamples.at(-1)??null,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures};
}
function startStress(){
  if(phase!=='race'||race.mode!=='race'||race.vehicles.some(v=>v.finished)) {toast('6台が走行中のレースで負荷試験を開始してください');return;}
  environment.removeChunk('stress');stressStarted=true;measuredFrames=[];stressUntil=elapsed+60;
  const pos=new THREE.Vector3().copy(race.player.body.translation());
  const paintsBefore=environment.stats.paintEvents;let paintAttempts=0;
  while(environment.stats.paintEvents-paintsBefore<200&&paintAttempts<400){const i=paintAttempts++;const origin=pos.clone().add(new THREE.Vector3((i%10-5)*.5,6,(Math.floor(i/10)%20)*.4+1));environment.paintRay(origin,new THREE.Vector3(0,-1,0),i%2?0x168aff:0xf1469e,30);}
  stressBurstCount=0;stressBurst();
  const gl=renderer.getContext();const ext=gl.getExtension('WEBGL_debug_renderer_info');
  measurement={started:new Date().toISOString(),startedElapsed:elapsed,durationTargetSeconds:60,resolution:[canvas.width,canvas.height],userAgent:navigator.userAgent,gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):'not exposed',activeVehicleCount:race.vehicles.length,paintAttempts,addedPaintEvents:environment.stats.paintEvents-paintsBefore,conditions:'real stage + explicitly game-added 100-part fixtures; 3 blasts every5s; actual counts sampled',startStats:environment.stats,acceptance:'REFERENCE_ONLY_UNTIL_TARGET_HARDWARE_CONFIRMED'};
  toast('負荷試験を開始 · 60秒のフレーム時間を記録',5);
}
function stressBurst(){
  environment.removeChunk('stress');stressBurstCount++;stressNextBurst=elapsed+5;
  const pos=new THREE.Vector3().copy(race.player.body.translation());
  for(let i=0;i<10;i++)environment.addBreakable({id:`game:stress:${stressBurstCount}:${i}`,position:[pos.x+(i-5)*1.5,pos.y+2,pos.z+12],size:[1.5,1.5,.3],chunkId:'stress',verification:'game_added',parts:Array.from({length:10},(_,j)=>({offset:[((j%5)-2)*.3,Math.floor(j/5)*.6,0] as RoutePoint,size:[.28,.55,.25] as RoutePoint}))});
  scene.updateMatrixWorld(true);
  for(const dx of [-5,0,5])detonate(pos.clone().add(new THREE.Vector3(dx,1,12)));
}
function finishStress(reason:string){
  stressStarted=false;measurement={...measurement,finished:new Date().toISOString(),completion:reason,actualSimulationSeconds:elapsed-Number(measurement?.startedElapsed??elapsed),burstCount:stressBurstCount,endStats:environment.stats};
  toast(reason==='completed'?'60秒の負荷計測が完了。検証パネルから保存できます。':'負荷計測は途中で終了しました。実行時間と状態を記録しています。',5);
}
function sampleMemory(now:number){
  if(now-memorySampleAt<1000)return;memorySampleAt=now;
  const heap=(performance as Performance&{memory?:{usedJSHeapSize:number;totalJSHeapSize:number;jsHeapSizeLimit:number}}).memory;
  memorySamples.push({wallMilliseconds:now,raceCycle,phase,simulationSeconds:elapsed,stress:stressStarted,heapBytes:heap?{used:heap.usedJSHeapSize,total:heap.totalJSHeapSize,limit:heap.jsHeapSizeLimit}:null,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,...environment.stats});
  if(memorySamples.length>10000)memorySamples.shift();
}
function saveReport(){const content=JSON.stringify({recordedAt:new Date().toISOString(),stage:stage.metadata,...diagnostics(),rawFrameMilliseconds:measuredFrames.length?measuredFrames:frameTimes,memorySamples,heapScope:'Chromium performance.memory where available; null is unsupported, not zero; renderer counters are resources, not GPU bytes',state:environment.getState()},null,2);const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:'application/json'}));a.download='machishift-runtime-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function frame(now:number) {
  const dt=Math.min(.08,(now-lastFrame)/1000||0);lastFrame=now;
  const milliseconds=now-frameBefore;frameBefore=now;
  if(['race','free'].includes(phase)){frameTimes.push(milliseconds);if(frameTimes.length>3600)frameTimes.shift();if(stressStarted)measuredFrames.push(milliseconds);}
  const control=input.sample();
  const active=['race','free','tutorial'].includes(phase)||(phase==='results'&&race.vehicles.some(v=>!v.finished));
  if(phase==='countdown'){countdown-=dt;const tick=Math.ceil(countdown);if(tick!==previousTick&&tick>0){sound.cue('tick');previousTick=tick;}if(countdown<=0){phase='race';sound.cue('go');toast('GO! 光るルートへ',1.5);}}
  if(active){
    accumulator+=dt;let steps=0;
    while(accumulator>=1/60&&steps++<5) {
      const tick=1/60;elapsed+=tick;
      race.update(tick,autoDrive?race.driveAI(race.player):control,p=>environment.gripAt(p,elapsed),true);
      world.step();race.afterStep(tick);environment.update(tick,elapsed);scene.updateMatrixWorld(true);updateProjectiles(tick);
      if(phase==='tutorial')tutorial(tick,control);
      accumulator-=tick;
    }
    for(const p of pickups){
      p.mesh.visible=elapsed>=p.availableAt;
      if(p.mesh.visible){
        p.mesh.rotation.y+=dt*1.5;p.mesh.position.y=p.at.y+1.6+Math.sin(elapsed*2+p.at.x)*.18;
        for(const v of race.vehicles){
          if(race.mode==='free'&&v.id!==0)continue;
          const bag=v.id===0?inventory:(aiInventory.get(v.id)??[]);const pos=v.body.translation();
          if(Math.hypot(pos.x-p.at.x,pos.z-p.at.z)<3&&Math.abs(pos.y-p.at.y)<3&&bag.length<2){bag.push(p.item);p.availableAt=elapsed+9;if(v.id===0){sound.cue('pickup');toast(p.item==='paint'?'ペイントを取得 · Space で構える':'ボムを取得 · Space で構える',2);}else aiInventory.set(v.id,bag);break;}
        }
      }
    }
    if(race.mode==='race')for(const v of race.vehicles){
      if(v.id===0||v.finished)continue;
      const bag=aiInventory.get(v.id);if(!bag?.length||elapsed<(aiNextThrow.get(v.id)??8+v.id))continue;
      const pos=v.body.translation(),forward=new THREE.Vector3(Math.sin(v.heading),0,Math.cos(v.heading));
      const rival=race.vehicles.find(other=>{if(other.id===v.id)return false;const d=new THREE.Vector3().copy(other.body.translation()).sub(pos);return d.length()<25&&d.length()>5&&d.normalize().dot(forward)>.8;});
      if(rival||bag[0]==='paint'){launchFor(v,bag.shift()!);aiNextThrow.set(v.id,elapsed+8+v.id);}
    }
    if(race.player.boost>0&&!lastBoost)sound.cue('boost');lastBoost=race.player.boost>0;
    if(race.player.lap!==lastLap){lastLap=race.player.lap;sound.cue('go');toast(lastLap===3?'FINAL LAP · 最後の一周！':'LAP 2 · 街の変化を使いこなそう',3);}
    if(phase==='race'&&race.player.finished)showResults();
    if(phase==='results'&&race.vehicles.filter(v=>v.finished).length!==finishedCount)showResults();
    if(stressStarted){
      if(elapsed>=stressUntil)finishStress('completed');
      else if(phase==='results')finishStress('interrupted-by-results');
      else if(elapsed>=stressNextBurst)stressBurst();
    }
  }
  for(let i=fx.length-1;i>=0;i--){const f=fx[i];f.age+=dt;f.mesh.scale.setScalar(1+f.scale*f.age/f.duration);(f.mesh.material as THREE.MeshBasicMaterial).opacity=.6*(1-f.age/f.duration);if(f.age>f.duration){scene.remove(f.mesh);f.mesh.geometry.dispose();(f.mesh.material as THREE.Material).dispose();fx.splice(i,1);}}
  updateCamera(dt);
  cullClock+=dt;
  if(cullClock>.5){cullClock=0;updateStreaming();}
  renderer.render(scene,camera);sampleMemory(now);uiClock+=dt;
  if(uiClock>.1){uiClock=0;if(['race','free','tutorial','countdown'].includes(phase))updateHUD();else updateDiagnostics();}
  requestAnimationFrame(frame);
}
function updateStreaming(){
  const activePositions=race.vehicles.filter(v=>race.mode==='race'||v.id===0).map(v=>new THREE.Vector3().copy(v.body.translation()));
  activePositions.push(camera.position);
  let changed=false;
  for(const chunk of stage.chunks){
    if(!chunk.bounds)continue;
    const b=chunk.bounds;
    const distance=Math.min(...activePositions.map(p=>Math.hypot(Math.max(b[0]-p.x,0,p.x-b[3]),Math.max(b[2]-p.z,0,p.z-b[5]))));
    if(distance>450&&!unloadedChunks.has(chunk.id)){environment.unloadChunk(chunk.id);unloadedChunks.add(chunk.id);changed=true;}
    if(distance<380&&unloadedChunks.has(chunk.id)){environment.reloadChunk(chunk.id);unloadedChunks.delete(chunk.id);changed=true;}
  }
  if(changed)loadedMeshes=environment.meshes;
  for(const mesh of loadedMeshes){
    const sphere=mesh.geometry.boundingSphere;
    if(!sphere){mesh.geometry.computeBoundingSphere();continue;}
    const center=sphere.center.clone().applyMatrix4(mesh.matrixWorld),distance=center.distanceTo(camera.position);
    const kind=mesh.userData.kind;
    mesh.visible=kind!=='furniture'||distance<110+sphere.radius;
    mesh.castShadow=kind!=='road'&&kind!=='terrain'&&distance<90+sphere.radius;
  }
}
async function boot(){
  showLoading(0,'WebGL2と物理エンジンを準備しています');
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;applyRenderQuality();
  scene.add(new THREE.HemisphereLight(0xdbedff,0x80785c,2.4));
  const sun=new THREE.DirectionalLight(0xfff1d4,3.1);sun.position.set(-100,180,-100);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-120;sun.shadow.camera.right=120;sun.shadow.camera.top=120;sun.shadow.camera.bottom=-120;sun.shadow.camera.far=600;sun.shadow.bias=-.0003;sun.shadow.normalBias=.15;scene.add(sun);scene.add(sun.target);
  await RAPIER.init();world=new RAPIER.World({x:0,y:-9.81,z:0});world.timestep=1/60;environment=new Environment(scene,world);
  showLoading(10,'岐阜駅北口のデータを取得しています');
  stage=await getJSON<Stage>('./data/stage.json');
  if(!stage.chunks?.length||!stage.route||stage.route.length<4)throw new Error('実データまたは走行経路が不足しています。取得・変換手順を実行してください。');
  const destructibles=await getJSON<{objects:{id:string;surfaceIds?:string[]}[]}>('./data/destructibles.json');
  const selection=new Map(destructibles.objects.map(object=>[object.id,object]));
  for(let i=0;i<stage.chunks.length;i++){
    const chunk=stage.chunks[i];const chunkURL=chunk.url.startsWith('/')?`.${chunk.url}`:chunk.url.startsWith('data/')?`./${chunk.url}`:`./data/${chunk.url}`;
    const data=await getJSON<{objects:(StaticMeshSpec&{runtimeEligible?:boolean})[]}>(chunkURL);
    for(const object of data.objects){
      if(object.runtimeEligible===false)continue;
      const selectedSource=selection.get(object.id);
      if(selectedSource)environment.addDestructibleMesh({...object,chunkId:chunk.id},{surfaceIds:selectedSource.surfaceIds});
      else environment.addStaticMesh({...object,chunkId:chunk.id});
    }
    showLoading(Math.round(10+(i+1)/stage.chunks.length*78),`街区 ${i+1} / ${stage.chunks.length} · ${environment.stats.objects} 地物`);
    await new Promise(resolve=>requestAnimationFrame(resolve));
  }
  loadedMeshes=environment.meshes;
  race=new Race(world,stage.route,scene);addRaceObjects();
  world.step();environment.update(0,0);race.afterStep(0);
  const focus=new THREE.Vector3(...race.route[0]);sun.position.add(focus);sun.target.position.copy(focus);
  camera.position.copy(focus).add(new THREE.Vector3(40,35,40));camera.lookAt(focus);
  input.onPause=()=>phase==='paused'?resume():pause();input.onDeactivate=pause;input.onThrow=launch;input.onSwitch=()=>{if(['race','free','tutorial'].includes(phase)&&inventory.length>1)selected=(selected+1)%inventory.length;};input.onRecover=recover;
  window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();showError(new Error('描画コンテキストが失われました。再試行すると新しいレースで再開します。'));});
  initializedAt=Math.round(performance.now());showTitle();requestAnimationFrame(frame);
}
void boot().catch(showError);
