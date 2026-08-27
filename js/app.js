// ---------- config / state ----------
const PALETTE = ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#7f77dd','#e34948','#378add','#ba7517'];
const MAX_SEL = 10;

let META = null;
let NAMES = [];            // [{f:slug, n:name}]
let NAME_BY_SLUG = {};     // slug -> name
let SLUG_BY_NAME = {};     // name -> slug
let REGION_NAMES = {};     // ISO -> ru_name (for map tooltips)
let GEO = null;            // russia geojson
let YEAR_TOTALS = {};      // year -> total people (all names)  — trend denominator
let REGION_TOTALS = {};    // ISO -> {year: total}             — map denominator

let selected = [];
let mode = 'trend';
let mapName = null;
let yearFrom = 1975, yearTo = 1985;

const colorOf = n => PALETTE[selected.indexOf(n) % PALETTE.length];

// per-name data cache: slug -> { n, years:{y:cnt}, regions:{ISO:{y:cnt}} }
const _cache = {};
async function loadName(name){
  const slug = SLUG_BY_NAME[name];
  if(_cache[slug]) return _cache[slug];
  const d = await fetch('data/names/'+slug+'.json').then(r=>r.json());
  _cache[slug] = d;
  return d;
}
function nameData(name){        // sync accessor; returns null if not loaded yet
  return _cache[SLUG_BY_NAME[name]] || null;
}
// years present across the trend window
let YEARS = [];

// ---------- boot ----------
async function boot(){
  const [meta, names, regionNames, geo, yearT, regionT] = await Promise.all([
    fetch('data/meta.json').then(r=>r.json()),
    fetch('data/names_index.json').then(r=>r.json()),
    fetch('data/region_names.json').then(r=>r.json()),
    fetch('data/russia.geojson').then(r=>r.json()),
    fetch('data/year_totals.json').then(r=>r.json()),
    fetch('data/region_totals.json').then(r=>r.json()),
  ]);
  META=meta; NAMES=names; REGION_NAMES=regionNames; GEO=geo;
  YEAR_TOTALS=yearT; REGION_TOTALS=regionT;
  NAMES.forEach(o=>{ NAME_BY_SLUG[o.f]=o.n; SLUG_BY_NAME[o.n]=o.f; });
  NAMES.sort((a,b)=>a.n.localeCompare(b.n,'ru'));

  // trend x-axis years from meta.trend_range, step 1 (real data is yearly)
  const [t0,t1]=META.trend_range||[META.year_min,META.year_max];
  YEARS=[]; for(let y=t0;y<=t1;y++) YEARS.push(y);
  yearFrom=META.map_range_default? META.map_range_default[0]:1975;
  yearTo  =META.map_range_default? META.map_range_default[1]:1985;

  document.getElementById('disclaimer').innerHTML='<b>О данных.</b> '+META.disclaimer;

  // preselect a couple of common names if present
  const pref=['Александр','Елена'].filter(n=>SLUG_BY_NAME[n]);
  selected = pref.length?pref:NAMES.slice(0,2).map(o=>o.n);
  mapName = selected[0]||null;
  await Promise.all(selected.map(loadName));
  wireControls();
  redraw();
}

// ---------- name selection ----------
function renderSelected(){
  const el = document.getElementById('selected');
  if(!selected.length){ el.innerHTML='<span class="empty-sel">Имена не выбраны</span>'; return; }
  el.innerHTML = selected.map(n=>`<span class="chip" style="background:${colorOf(n)}">${n}<span class="x" data-n="${n}">×</span></span>`).join('');
  el.querySelectorAll('.x').forEach(x=>x.onclick=()=>{ const n=x.dataset.n;
    selected=selected.filter(v=>v!==n); if(mapName===n) mapName=selected[0]||null; redraw(); });
}
function renderList(filter=''){
  const el = document.getElementById('namelist');
  const f = filter.toLowerCase();
  const items = NAMES.filter(o=>o.n.toLowerCase().includes(f));
  el.innerHTML = items.map(o=>{ const n=o.n, on=selected.includes(n);
    return `<div class="nrow${on?' on':''}" data-n="${n}"><span class="dot" style="background:${on?colorOf(n):'#ccc'}"></span>${n}</div>`; }).join('');
  el.querySelectorAll('.nrow').forEach(r=>r.onclick=async ()=>{ const n=r.dataset.n;
    if(selected.includes(n)){ selected=selected.filter(v=>v!==n); if(mapName===n) mapName=selected[0]||null; redraw(); }
    else{ if(selected.length>=MAX_SEL){ alert('Можно выбрать до '+MAX_SEL+' имён'); return; }
      selected.push(n); if(!mapName) mapName=n; await loadName(n); redraw(); }
  });
}

// ---------- metrics ----------
function renderMetrics(){
  const el=document.getElementById('metrics');
  if(!selected.length){ el.innerHTML=''; return; }
  const n0=selected[0], d=nameData(n0);
  if(!d){ el.innerHTML=''; return; }
  let peakYear=null, peakShare=0;
  YEARS.forEach(y=>{ const c=d.years[y]||0, tot=YEAR_TOTALS[y]||0;
    const sh = tot? c/tot : 0; if(sh>peakShare){ peakShare=sh; peakYear=y; } });
  el.innerHTML =
    `<div class="metric"><div class="k">Выбрано имён</div><div class="v">${selected.length}</div></div>`+
    `<div class="metric"><div class="k">Пик · ${n0}</div><div class="v">${peakYear||'—'}</div></div>`+
    `<div class="metric"><div class="k">Макс. доля · ${n0}</div><div class="v">${(peakShare*100).toFixed(2)}%</div></div>`;
}

// ---------- trend chart ----------
let chart;
function renderTrend(){
  const body=document.getElementById('trendBody');
  if(!selected.length){ body.innerHTML='<div class="placeholder">Выберите одно или несколько имён слева.</div>'; return; }
  body.innerHTML='<div class="chartbox"><canvas id="chart" role="img" aria-label="Доля имён по годам рождения"></canvas></div>'+
    '<div class="note">Доля — сколько процентов рождённых в этот год носят имя. Годы на краях диапазона с малым числом наблюдений менее надёжны.</div>';
  const ds=selected.map(n=>{ const d=nameData(n)||{years:{}};
    return { label:n,
      data:YEARS.map(y=>{ const tot=YEAR_TOTALS[y]||0; return tot? 100*(d.years[y]||0)/tot : 0; }),
      borderColor:colorOf(n), backgroundColor:colorOf(n),
      tension:0, pointRadius:0, pointHoverRadius:4, borderWidth:2 }; });
  if(chart) chart.destroy();
  chart=new Chart(document.getElementById('chart'),{ type:'line',
    data:{ labels:YEARS, datasets:ds },
    options:{ responsive:true, maintainAspectRatio:false,
      interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{
          title:items=>items[0].label+' г.р.',
          label:ctx=>ctx.dataset.label+': '+ctx.parsed.y.toFixed(2)+'%'
        }}},
      scales:{ x:{grid:{display:false}}, y:{beginAtZero:true, ticks:{callback:v=>v+'%'}} } } });
}

// ---------- map (real D3 choropleth) ----------
function tint(hex,a){ const c=hex.replace('#','');
  const r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);
  const m=v=>Math.round(v+(255-v)*a); return `rgb(${m(r)},${m(g)},${m(b)})`; }

function renderMap(){
  const body=document.getElementById('mapBody');
  if(!selected.length){ body.innerHTML='<div class="placeholder">Выберите имя слева, чтобы построить карту.</div>'; return; }
  if(!mapName||!selected.includes(mapName)) mapName=selected[0];
  const pick=selected.map(n=>`<span class="chip pick${n===mapName?' active':''}" style="background:${colorOf(n)}" data-mn="${n}">${n}</span>`).join('');
  body.innerHTML=`<div class="mapctl">
      <div class="mapname-pick"><label>Имя на карте:</label>${pick}</div>
      <div style="display:flex;align-items:center;gap:6px">
        <label>Годы рождения:</label>
        <input type="number" class="yearin" id="yFrom" min="${META.year_min}" max="${META.year_max}" value="${yearFrom}">
        <span class="dash">—</span>
        <input type="number" class="yearin" id="yTo" min="${META.year_min}" max="${META.year_max}" value="${yearTo}">
      </div></div>
    <div class="maprow">
      <div id="map"></div>
      <div><div class="scale">
        <div>Доля рождённых с именем <b style="color:${colorOf(mapName)}">${mapName}</b> в ${yearFrom}${yearTo!==yearFrom?'–'+yearTo:''}</div>
        <div class="bar" id="scalebar"></div>
        <div class="ends"><span>мало</span><span>много</span></div>
        <div style="display:flex;align-items:center;gap:7px;margin-top:10px">
          <span style="width:11px;height:11px;border-radius:3px;background:repeating-linear-gradient(45deg,#f0efec,#f0efec 3px,#e7e5df 3px,#e7e5df 6px)"></span>
          <span>мало данных</span></div>
      </div></div>
    </div>`;
  const base=colorOf(mapName), ramp=[tint(base,.82),tint(base,.55),tint(base,.28),base];
  document.getElementById('scalebar').style.background=`linear-gradient(90deg,${ramp.join(',')})`;
  drawChoropleth(mapName, ramp);
  body.querySelectorAll('.chip.pick').forEach(c=>c.onclick=async ()=>{ mapName=c.dataset.mn; if(!nameData(mapName)) await loadName(mapName); renderMap(); });
  const yf=document.getElementById('yFrom'), yt=document.getElementById('yTo');
  const upd=()=>{ yearFrom=Math.min(+yf.value,+yt.value)||META.year_min; yearTo=Math.max(+yf.value,+yt.value)||META.year_max; renderMap(); };
  yf.onchange=upd; yt.onchange=upd;
}

function drawChoropleth(name, ramp){
  const el=d3.select('#map'); el.selectAll('*').remove();
  const W=560, H=380;
  const svg=el.append('svg').attr('viewBox',`0 0 ${W} ${H}`).attr('role','img')
    .attr('aria-label','Карта России: доля имени '+name+' по регионам');
  const defs=svg.append('defs');
  const p=defs.append('pattern').attr('id','hatch').attr('width',6).attr('height',6)
    .attr('patternUnits','userSpaceOnUse').attr('patternTransform','rotate(45)');
  p.append('rect').attr('width',6).attr('height',6).attr('fill','#f0efec');
  p.append('rect').attr('width',3).attr('height',6).attr('fill','#e7e5df');
  const proj=d3.geoAlbers().rotate([-105,0]).center([-10,60]).parallels([50,70]);
  const path=d3.geoPath(proj); proj.fitSize([W,H], GEO);

  // compute share per region over [yearFrom..yearTo]
  const d=nameData(name)||{regions:{}};
  const minCell=META.map_min_cell||30;
  const share={};       // iso -> share or null (too little data)
  GEO.features.forEach(f=>{
    const iso=f.id;
    const rt=REGION_TOTALS[iso]||{};
    let num=0, den=0;
    for(let y=yearFrom;y<=yearTo;y++){
      den += rt[y]||0;
      num += (d.regions[iso] && d.regions[iso][y])||0;
    }
    share[iso] = (den>=minCell) ? num/den : null;
  });
  // color scale relative to max share in view (so differences are visible)
  const vals=Object.values(share).filter(v=>v!=null);
  const maxShare=vals.length?Math.max(...vals):0;
  const norm=v=> maxShare>0? v/maxShare : 0;

  svg.selectAll('path').data(GEO.features).join('path')
    .attr('d',path)
    .attr('class',d=>{ const v=share[d.id]; return 'region'+(v==null?' nodata':''); })
    .attr('fill',d=>{ const v=share[d.id]; if(v==null) return null; return ramp[Math.min(3,Math.floor(norm(v)*3.999))]; })
    .on('mousemove',(e,f)=>{ const v=share[f.id];
      const ruName=REGION_NAMES[f.id]||f.properties.name;
      showTip(e, ruName+': '+(v==null?'мало данных':(v*100).toFixed(2)+'%')); })
    .on('mouseout',hideTip);
}

// ---------- tooltip ----------
const tip=document.getElementById('tip');
function showTip(e,text){ tip.textContent=text; tip.style.opacity=1; tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY+12)+'px'; }
function hideTip(){ tip.style.opacity=0; }

// ---------- controls / redraw ----------
function wireControls(){
  document.getElementById('search').oninput=e=>renderList(e.target.value);
  document.getElementById('mode').addEventListener('click',e=>{
    if(!e.target.dataset.m) return; mode=e.target.dataset.m;
    [...document.querySelectorAll('#mode button')].forEach(b=>b.classList.toggle('on',b.dataset.m===mode));
    document.getElementById('trendPanel').style.display=mode==='trend'?'':'none';
    document.getElementById('mapPanel').style.display=mode==='map'?'':'none';
    redraw();
  });
}
function redraw(){
  renderSelected(); renderList(document.getElementById('search').value); renderMetrics();
  if(mode==='trend') renderTrend(); else renderMap();
}

boot();
