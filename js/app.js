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
let yscale = 'lin';          // 'lin' | 'log' for the trend chart
let mapName = null;
let yearFrom = 1975, yearTo = 1985;
let selectedRegion = null;         // ISO of region clicked for the top-names panel
const _regionCache = {};           // iso -> { name: {year:cnt} }

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

  document.getElementById('disclaimer').innerHTML='<b>Важно про данные.</b> '+META.disclaimer;

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
// Chart.js plugin: draw each series' name at the right end of its line
const endLabelPlugin = {
  id: 'endLabels',
  afterDatasetsDraw(chart){
    const {ctx} = chart;
    ctx.save();
    ctx.font = '600 12px -apple-system,Segoe UI,Roboto,sans-serif';
    ctx.textBaseline = 'middle';
    // collect last visible point per dataset, then nudge apart vertically
    const labels = [];
    chart.data.datasets.forEach((ds,i)=>{
      const meta = chart.getDatasetMeta(i);
      if(meta.hidden) return;
      // find last point with a finite value
      let pt=null;
      for(let k=ds.data.length-1;k>=0;k--){
        const v=ds.data[k];
        if(v!=null && isFinite(v)){ pt=meta.data[k]; break; }
      }
      if(pt) labels.push({y:pt.y, x:pt.x, color:ds.borderColor, text:ds.label});
    });
    labels.sort((a,b)=>a.y-b.y);
    const minGap=14;
    for(let i=1;i<labels.length;i++){
      if(labels[i].y - labels[i-1].y < minGap) labels[i].y = labels[i-1].y + minGap;
    }
    const area=chart.chartArea;
    labels.forEach(l=>{
      const x=Math.min(l.x+6, area.right+4);
      ctx.fillStyle=l.color;
      ctx.fillText(l.text, x, Math.max(area.top+6, Math.min(l.y, area.bottom-6)));
    });
    ctx.restore();
  }
};

let chart;
function renderTrend(){
  const body=document.getElementById('trendBody');
  if(!selected.length){ body.innerHTML='<div class="placeholder">Выберите одно или несколько имён слева.</div>'; return; }
  body.innerHTML='<div class="chartbox"><canvas id="chart" role="img" aria-label="Доля имён по годам рождения"></canvas></div>'+
    '<div class="note">Доля — сколько процентов рождённых в этот год носят имя. Годы на краях диапазона с малым числом наблюдений менее надёжны.'+
    (yscale==='log'?' Логарифмическая шкала: нулевые значения не отображаются.':'')+'</div>';
  const isLog = yscale==='log';
  const ds=selected.map(n=>{ const d=nameData(n)||{years:{}};
    return { label:n,
      data:YEARS.map(y=>{ const tot=YEAR_TOTALS[y]||0; const v = tot? 100*(d.years[y]||0)/tot : 0;
        return (isLog && v<=0) ? null : v; }),   // log can't show 0
      borderColor:colorOf(n), backgroundColor:colorOf(n),
      tension:0, pointRadius:0, pointHoverRadius:4, borderWidth:2, spanGaps:false }; });
  if(chart) chart.destroy();
  chart=new Chart(document.getElementById('chart'),{ type:'line',
    data:{ labels:YEARS, datasets:ds },
    options:{ responsive:true, maintainAspectRatio:false,
      layout:{ padding:{ right:70 } },      // room for line-end labels
      interaction:{ mode:'index', intersect:false },
      plugins:{ legend:{display:false},
        tooltip:{ callbacks:{
          title:items=>items[0].label+' г.р.',
          label:ctx=>ctx.dataset.label+': '+(ctx.parsed.y==null?'—':ctx.parsed.y.toFixed(2)+'%')
        }}},
      scales:{ x:{grid:{display:false}},
        y: isLog
          ? { type:'logarithmic', ticks:{callback:v=>v+'%'} }
          : { beginAtZero:true, ticks:{callback:v=>v+'%'} } } },
    plugins:[endLabelPlugin] });
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
      <div>
        <div class="scale">
        <div>Доля рождённых с именем <b style="color:${colorOf(mapName)}">${mapName}</b> в ${yearFrom}${yearTo!==yearFrom?'–'+yearTo:''}</div>
        <div class="bar" id="scalebar"></div>
        <div class="ends"><span>мало</span><span>много</span></div>
        <div style="display:flex;align-items:center;gap:7px;margin-top:10px">
          <span style="width:11px;height:11px;border-radius:3px;background:repeating-linear-gradient(45deg,#f0efec,#f0efec 3px,#e7e5df 3px,#e7e5df 6px)"></span>
          <span>мало данных</span></div>
        </div>
        <div id="regionTop" class="regiontop"></div>
      </div>
    </div>`;
  const base=colorOf(mapName), ramp=[tint(base,.82),tint(base,.55),tint(base,.28),base];
  document.getElementById('scalebar').style.background=`linear-gradient(90deg,${ramp.join(',')})`;
  drawChoropleth(mapName, ramp);
  renderRegionTop();
  body.querySelectorAll('.chip.pick').forEach(c=>c.onclick=async ()=>{ mapName=c.dataset.mn; if(!nameData(mapName)) await loadName(mapName); renderMap(); });
  const yf=document.getElementById('yFrom'), yt=document.getElementById('yTo');
  const upd=()=>{ yearFrom=Math.min(+yf.value,+yt.value)||META.year_min; yearTo=Math.max(+yf.value,+yt.value)||META.year_max; renderMap(); };
  yf.onchange=upd; yt.onchange=upd;
}

function computeShare(name){
  // share + numerator per region over [yearFrom..yearTo]
  const d=nameData(name)||{regions:{}};
  const minCell=META.map_min_cell||30;
  const share={}, count={};
  GEO.features.forEach(f=>{
    const iso=f.id, rt=REGION_TOTALS[iso]||{};
    let num=0, den=0;
    for(let y=yearFrom;y<=yearTo;y++){ den+=rt[y]||0; num+=(d.regions[iso]&&d.regions[iso][y])||0; }
    share[iso] = (den>=minCell)? num/den : null;
    count[iso] = num;
  });
  return {share, count};
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

  const {share,count}=computeShare(name);
  const vals=Object.values(share).filter(v=>v!=null);
  const maxShare=vals.length?Math.max(...vals):0;
  const norm=v=> maxShare>0? v/maxShare : 0;
  const fillFor=v=> v==null? null : ramp[Math.min(3,Math.floor(norm(v)*3.999))];
  const tipText=(iso)=>{ const v=share[iso], c=count[iso]||0;
    const ru=REGION_NAMES[iso]||iso;
    return ru+': '+(v==null?'мало данных':(v*100).toFixed(2)+'% ('+c.toLocaleString('ru')+' чел.)'); };

  // region polygons
  svg.selectAll('path').data(GEO.features).join('path')
    .attr('d',path)
    .attr('class',d=>'region'+(share[d.id]==null?' nodata':''))
    .attr('fill',d=>fillFor(share[d.id]))
    .style('cursor','pointer')
    .on('mousemove',(e,f)=>showTip(e,tipText(f.id)))
    .on('mouseout',hideTip)
    .on('click',(e,f)=>selectRegion(f.id));

  // callouts for Moscow & St. Petersburg only (too small to see/click otherwise)
  const CALLOUT = {
    'RU-MOW': { label:'Москва',        dx:-70, dy: 34 },
    'RU-SPE': { label:'Санкт-Петербург', dx:-96, dy:-26 },
  };
  Object.entries(CALLOUT).forEach(([iso,cfg])=>{
    const feat=GEO.features.find(f=>f.id===iso); if(!feat) return;
    const [cx,cy]=path.centroid(feat); if(!isFinite(cx)) return;
    const v=share[iso];
    const lx=cx+cfg.dx, ly=cy+cfg.dy;
    // leader line
    svg.append('line').attr('x1',cx).attr('y1',cy).attr('x2',lx).attr('y2',ly)
      .attr('stroke','#1a1a19').attr('stroke-width',0.7).attr('opacity',0.6);
    // dot on the region
    svg.append('circle').attr('cx',cx).attr('cy',cy).attr('r',4)
      .attr('fill', v==null?'url(#hatch)':fillFor(v))
      .attr('stroke','#1a1a19').attr('stroke-width',0.9)
      .style('cursor','pointer')
      .on('mousemove',(e)=>showTip(e,tipText(iso))).on('mouseout',hideTip)
      .on('click',()=>selectRegion(iso));
    // label with a small swatch
    const g=svg.append('g').style('cursor','pointer')
      .on('mousemove',(e)=>showTip(e,tipText(iso))).on('mouseout',hideTip)
      .on('click',()=>selectRegion(iso));
    g.append('rect').attr('x',lx-2).attr('y',ly-8).attr('width',10).attr('height',10).attr('rx',2)
      .attr('fill', v==null?'url(#hatch)':fillFor(v)).attr('stroke','#1a1a19').attr('stroke-width',0.6);
    g.append('text').attr('x',lx+12).attr('y',ly).attr('dy','0.32em')
      .attr('font-size','11').attr('font-weight','600').attr('fill','#1a1a19').text(cfg.label);
  });
}

// ---------- region top-names panel ----------
async function loadRegion(iso){
  if(_regionCache[iso]) return _regionCache[iso];
  try{
    const d=await fetch('data/regions/'+iso+'.json').then(r=>r.json());
    _regionCache[iso]=d; return d;
  }catch(e){ _regionCache[iso]={}; return {}; }
}
async function selectRegion(iso){
  selectedRegion=iso;
  await loadRegion(iso);
  renderRegionTop();
}
function renderRegionTop(){
  const el=document.getElementById('regionTop');
  if(!el) return;
  if(!selectedRegion){ el.innerHTML='<div class="rt-hint">Нажмите на регион, чтобы увидеть самые частые имена в нём за выбранный период.</div>'; return; }
  const iso=selectedRegion, data=_regionCache[iso]||{};
  // sum each name over [yearFrom..yearTo], accurate top for the range
  const totals=[];
  for(const n in data){
    let s=0; const ys=data[n];
    for(let y=yearFrom;y<=yearTo;y++) s+=ys[y]||0;
    if(s>0) totals.push([n,s]);
  }
  totals.sort((a,b)=>b[1]-a[1]);
  const ru=REGION_NAMES[iso]||iso;
  const rangeTxt=yearFrom+(yearTo!==yearFrom?'–'+yearTo:'');
  if(!totals.length){ el.innerHTML=`<div class="rt-title">${ru}</div><div class="rt-hint">Недостаточно данных за ${rangeTxt}.</div>`; return; }
  const denom=totals.reduce((s,[,c])=>s+c,0);
  const top=totals.slice(0,5);
  const rows=top.map(([n,c],i)=>{
    const pct=(100*c/denom).toFixed(1);
    const isSel=SLUG_BY_NAME[n]&&selected.includes(n);
    return `<div class="rt-row${isSel?' sel':''}" data-n="${n}">
      <span class="rt-rank">${i+1}</span>
      <span class="rt-name">${n}</span>
      <span class="rt-pct">${pct}%</span>
      <span class="rt-cnt">${c.toLocaleString('ru')}</span></div>`;
  }).join('');
  el.innerHTML=`<div class="rt-title">${ru} · ${rangeTxt}</div>
    <div class="rt-sub">Самые частые имена (доля среди рождённых)</div>
    ${rows}
    <div class="rt-foot">Показаны имена, встречающиеся в регионе не реже 10 раз.</div>`;
  // clicking a name in the list adds it to selection
  el.querySelectorAll('.rt-row').forEach(r=>r.onclick=async ()=>{
    const n=r.dataset.n;
    if(!SLUG_BY_NAME[n]) return;               // name below global threshold, no per-name file
    if(!selected.includes(n)){
      if(selected.length>=MAX_SEL){ alert('Можно выбрать до '+MAX_SEL+' имён'); return; }
      selected.push(n); await loadName(n); if(!mapName) mapName=n;
    }
    mapName=n; renderMap();
  });
}


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
  const ys=document.getElementById('yscale');
  if(ys) ys.addEventListener('click',e=>{
    if(!e.target.dataset.s) return; yscale=e.target.dataset.s;
    [...ys.querySelectorAll('button')].forEach(b=>b.classList.toggle('on',b.dataset.s===yscale));
    if(mode==='trend') renderTrend();
  });
}
function redraw(){
  renderSelected(); renderList(document.getElementById('search').value); renderMetrics();
  if(mode==='trend') renderTrend(); else renderMap();
}

boot();