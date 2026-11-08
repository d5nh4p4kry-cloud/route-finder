'use strict';
// 検査側の原データ判定。構築器・構築記録を読み込まない。
const crypto = require('crypto');
const role = w => w.rf_role || (w.geometry ? 'hw' : 'touch');
const norm = name => String(name || '').split(';')[0].normalize('NFKC').replace(/\([左右]ルート\)|[左右]ルート/g, '').trim();
const dirs = w => /^(yes|true|1)$/.test((w.tags || {}).oneway) ? [1] : /^(-1|reverse)$/.test((w.tags || {}).oneway) ? [-1] : /^(no|false|0)$/.test((w.tags || {}).oneway) ? [1,-1] : /^(motorway|motorway_link)$/.test((w.tags || {}).highway) ? [1] : [1,-1];
const rad = x => x * Math.PI / 180;
function hav(a,b,radius=6371000) { const dlat=rad(b.lat-a.lat),dlon=rad(b.lng-a.lng); return (2*radius)*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2))); }
const vec = (a,b) => ({x:(b.lng-a.lng)*Math.cos(rad((a.lat+b.lat)/2)),y:b.lat-a.lat});
const angle = (a,b) => Math.acos(Math.max(-1,Math.min(1,(a.x*b.x+a.y*b.y)/(Math.hypot(a.x,a.y)*Math.hypot(b.x,b.y))))) * 180/Math.PI;
const surface = w => role(w)==='touch' && /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|trunk_link|primary_link|secondary_link|tertiary_link)$/.test((w.tags||{}).highway) && !/^(no|private)$/.test((w.tags||{}).access);
const arr = xs => [...xs].sort((a,b)=>typeof a==='number'&&typeof b==='number'?a-b:String(a).localeCompare(String(b),'en'));
const sid = s => `${s.way}:${s.pos}:${s.sign}`;
function push(m,k,v) { if(!m.has(k))m.set(k,[]);m.get(k).push(v); }
function prepare({osm,ledger}) {
  const ways=new Map(),nodes=new Map(),coords=new Map(),nodeWays=new Map();
  for(const e of osm.elements) if(e.type==='way') {
    ways.set(e.id,e); e.nodes.forEach((n,i)=>{push(nodeWays,n,e.id); if(e.geometry&&e.geometry[i])coords.set(n,{lat:e.geometry[i].lat,lng:e.geometry[i].lon});});
  } else if(e.type==='node') {nodes.set(e.id,e);coords.set(e.id,{lat:e.lat,lng:e.lon});}
  const box=ledger.bbox,inside=p=>!!p&&p.lat>=box.latMin&&p.lat<=box.latMax&&p.lng>=box.lngMin&&p.lng<=box.lngMax;
  const main=[...ways.values()].filter(w=>role(w)==='hw'&&/^(motorway|trunk)$/.test((w.tags||{}).highway)&&w.nodes.some(n=>inside(coords.get(n)))).sort((a,b)=>a.id-b.id);
  const mainIds=new Set(main.map(w=>w.id)),byName=new Map(ledger.routes.map(r=>[r.normalized_name,r])),roads=new Map(ledger.routes.map(r=>[r.key,r]));
  const assignment=new Map(),unknownNames=[],multiNames=[];
  for(const w of main) {
    const n=norm((w.tags||{}).name);
    if(n) { if(byName.has(n))assignment.set(w.id,byName.get(n).key);else unknownNames.push({way:w.id,name:n}); }
    if(String((w.tags||{}).name||'').includes(';'))multiNames.push({way:w.id,name:w.tags.name});
  }
  // 同期反復：同じ ref の既知の隣接キーを優先する。
  for(;;) {
    const next=[];
    for(const w of main) if(!assignment.has(w.id)&&!norm((w.tags||{}).name)) {
      const near=new Set(w.nodes.flatMap(n=>nodeWays.get(n)||[]).filter(id=>id!==w.id&&mainIds.has(id)&&assignment.has(id)));
      const same=new Set([...near].filter(id=>w.tags&&w.tags.ref&&(ways.get(id).tags||{}).ref===w.tags.ref).map(id=>assignment.get(id)));
      const all=new Set([...near].map(id=>assignment.get(id))),chosen=same.size?same:all;
      if(chosen.size===1)next.push([w.id,[...chosen][0]]);
    }
    if(!next.length)break;for(const [id,key]of next)assignment.set(id,key);
  }
  const left=new Set(main.filter(w=>!assignment.has(w.id)&&!norm((w.tags||{}).name)).map(w=>w.id)),unnamed=[];
  while(left.size) {
    const seed=Math.min(...left),group=[],stack=[seed];left.delete(seed);
    while(stack.length){const id=stack.pop();group.push(id);for(const n of ways.get(id).nodes)for(const v of nodeWays.get(n)||[])if(left.delete(v))stack.push(v);}
    const name='無名の接続路:'+Math.min(...group),r=byName.get(name),key=r?r.key:'r'+crypto.createHash('sha256').update(name).digest('hex').slice(0,10);
    for(const id of group)assignment.set(id,key);unnamed.push({key,name,ways:arr(group)});
  }
  const tag=w=>['yes','no'].includes((w.tags||{}).toll)?w.tags.toll:'none';
  const pending=new Set(mainIds),components=[],wayComponent=new Map();
  while(pending.size) {
    const seed=pending.values().next().value,stack=[seed],ids=[],route=assignment.get(seed),value=tag(ways.get(seed));pending.delete(seed);
    while(stack.length){const id=stack.pop();ids.push(id);for(const n of ways.get(id).nodes)for(const v of nodeWays.get(n)||[])if(pending.has(v)&&assignment.get(v)===route&&tag(ways.get(v))===value){pending.delete(v);stack.push(v);}}
    const ns=new Set(ids.flatMap(id=>ways.get(id).nodes)),external=new Set(),surfaces=new Set();
    for(const n of ns)for(const id of nodeWays.get(n)||[])if(!ids.includes(id)) {if(mainIds.has(id))external.add(id);else if(surface(ways.get(id)))surfaces.add(id);}
    const c={id:Math.min(...ids),route,tag:value,ways:arr(ids),booths:arr([...ns].filter(n=>(nodes.get(n)||{}).tags?.barrier==='toll_booth')),contact_main_ways:arr(external),contact_surface_ways:arr(surfaces)};
    components.push(c);for(const id of ids)wayComponent.set(id,c);
  }
  components.sort((a,b)=>a.id-b.id);
  const contradictions=[];
  for(const c of components)c.same_route_contacts=arr(new Set(c.contact_main_ways.map(id=>wayComponent.get(id)).filter(o=>o.route===c.route).map(o=>o.id)));
  const compById=new Map(components.map(c=>[c.id,c]));
  for(const value of ['no','yes','none'])for(const c of components.filter(c=>c.tag===value)) {
    const r=roads.get(c.route)||{},policy=r.toll_handling||'タグに従う',neighbors=c.same_route_contacts.map(id=>compById.get(id));
    const routeConflict=components.some(o=>o.route===c.route&&(o.tag==='yes'||o.booths.length));
    let row,result;
    if(policy==='無料路線'&&routeConflict){row=1;result='conflict';contradictions.push(c.id);}
    else if(policy==='無料路線'){row=2;result='free';}
    else if(value==='no'&&policy==='有料路線'){row=3;result='null';}
    else if(value==='none'&&policy==='有料路線'){row=4;result='true';}
    else if(value==='yes'){row=5;result='true';}
    else if(value==='no'&&c.booths.length){row=6;result='true';}
    else if(value==='no'&&neighbors.some(o=>o.tag==='yes'||o.tag==='none')){row=7;result='null';}
    else if(value==='no'){row=8;result='free';}
    else if(neighbors.length&&neighbors.every(o=>[5,6].includes(o.row))){row=9;result='true';}
    else if(neighbors.length&&neighbors.every(o=>[5,6,7].includes(o.row))&&neighbors.some(o=>o.result==='null')){row=10;result='null';}
    else{row=11;result='excluded';}
    Object.assign(c,{row,result});
  }
  const segments=[],incoming=new Map(),outgoing=new Map(),bySegment=new Map();
  for(const w of main) {
    const c=wayComponent.get(w.id);if(!['true','null'].includes(c.result))continue;
    for(let pos=0;pos<w.nodes.length-1;pos++)for(const sign of dirs(w)) {
      const from=w.nodes[pos+(sign===-1?1:0)],to=w.nodes[pos+(sign===1?1:0)];if(!inside(coords.get(from))||!inside(coords.get(to)))continue;
      const s={way:w.id,pos,sign,from,to,key:assignment.get(w.id),len:hav(coords.get(from),coords.get(to)),toll:c.result==='true'?true:null};
      segments.push(s);bySegment.set(sid(s),s);push(incoming,to,s);push(outgoing,from,s);
    }
  }
  const evidence = n => ({surface_ways:arr((nodeWays.get(n)||[]).filter(id=>surface(ways.get(id))&&(ways.get(id).tags||{}).toll!=='yes')),free_main_ways:arr((nodeWays.get(n)||[]).filter(id=>mainIds.has(id)&&wayComponent.get(id).result==='free'))});
  const terminals=[];
  for(const n of new Set([...incoming.keys(),...outgoing.keys()])) {
    const ins=incoming.get(n)||[],outs=outgoing.get(n)||[],near=new Set(ins.map(s=>s.from).concat(outs.map(s=>s.to))),ev=evidence(n);
    if(near.size===1&&inside(coords.get(n))&&(ev.surface_ways.length||ev.free_main_ways.length))terminals.push({node:n,point:[coords.get(n).lat,coords.get(n).lng],entry_arcs:outs.map(s=>[s.from,s.to,s.way,s.pos,s.sign]),exit_arcs:ins.map(s=>[s.from,s.to,s.way,s.pos,s.sign]),...ev,main_ways:arr((nodeWays.get(n)||[]).filter(id=>mainIds.has(id))),routes:arr(new Set((nodeWays.get(n)||[]).filter(id=>mainIds.has(id)).map(id=>assignment.get(id))))});
  }
  terminals.sort((a,b)=>a.node-b.node);
  const boundaries=[];
  for(const s of segments)for(const t of outgoing.get(s.to)||[])if(t.to!==s.from&&s.key!==t.key)boundaries.push({node:s.to,from:s.key,to:t.key,incoming:sid(s),outgoing:sid(t)});
  return {role,dirs,norm,hav,vec,angle,ways,nodes,coords,nodeWays,main,mainIds,assignment,unknownNames,multiNames,unnamed,roads,components,wayComponent,contradictions,segments,bySegment,incoming,outgoing,terminals,evidence,boundaries,inside,box};
}
function pointSegment(p,a,b) {
  const kx=111320*Math.cos(rad(p.lat)),ky=110574,ax=(a.lng-p.lng)*kx,ay=(a.lat-p.lat)*ky,bx=(b.lng-p.lng)*kx,by=(b.lat-p.lat)*ky,dx=bx-ax,dy=by-ay;
  const t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));return Math.hypot(ax+t*dx,ay+t*dy);
}
// V8: way 境界をまたぐ物理チェーンの連続標本。
function correspondence(v,n06,ledger) {
  const grid=new Map(),cell=p=>[Math.floor(p.lng*100),Math.floor(p.lat*100)];
  for(const sec of n06.sections) {
    const lines=sec.geometry.type==='LineString'?[sec.geometry.coordinates]:sec.geometry.coordinates;
    for(const line of lines)for(let i=1;i<line.length;i++) {
      const a={lat:line[i-1][1],lng:line[i-1][0]},b={lat:line[i][1],lng:line[i][0]},ca=cell(a),cb=cell(b),s={a,b,name:sec.name};
      for(let x=Math.min(ca[0],cb[0]);x<=Math.max(ca[0],cb[0]);x++)for(let y=Math.min(ca[1],cb[1]);y<=Math.max(ca[1],cb[1]);y++)push(grid,x+','+y,s);
    }
  }
  const threshold=ledger.n06_correspondence.distance_m,minimum=ledger.n06_correspondence.minimum_consecutive,step=ledger.n06_correspondence.sample_step_m;
  const near=p=>{const [x,y]=cell(p),names=new Set(),seen=new Set();for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const s of grid.get((x+dx)+','+(y+dy))||[])if(!seen.has(s)){seen.add(s);if(pointSegment(p,s.a,s.b)<=threshold)names.add(s.name);}return names;};
  const rows=[];
  for(const key of arr(new Set(v.assignment.values()))) {
    const edges=[],adj=new Map(),physical=new Set();
    for(const w of v.main.filter(w=>v.assignment.get(w.id)===key))for(let i=1;i<w.nodes.length;i++) {
      const a=w.nodes[i-1],b=w.nodes[i];if(!v.inside(v.coords.get(a))||!v.inside(v.coords.get(b)))continue;
      const k=Math.min(a,b)+':'+Math.max(a,b);if(physical.has(k))continue;physical.add(k);
      const e={a,b,way:w.id,pos:i-1,id:edges.length};edges.push(e);push(adj,a,e);push(adj,b,e);
    }
    const used=new Set(),chains=[];
    function chain(start,e) {
      let n=start,cur=e,ns=[start];
      while(cur&&!used.has(cur.id)){used.add(cur.id);n=cur.a===n?cur.b:cur.a;ns.push(n);if(adj.get(n).length!==2)break;cur=adj.get(n).find(s=>!used.has(s.id));}
      chains.push(ns);
    }
    for(const n of arr(adj.keys()))if(adj.get(n).length!==2)for(const e of adj.get(n))if(!used.has(e.id))chain(n,e);
    for(const e of edges)if(!used.has(e.id))chain(Math.min(e.a,e.b),e);
    let samples=0;const maxRun={},nearby=new Set();
    for(const chain of chains) {
      let at=0,cumulative=0;const streak={};
      for(let i=1;i<chain.length;i++) {
        const a=v.coords.get(chain[i-1]),b=v.coords.get(chain[i]),len=hav(a,b);
        while(at<=cumulative+len+1e-9) {
          const t=len?(at-cumulative)/len:0,p={lat:a.lat+(b.lat-a.lat)*t,lng:a.lng+(b.lng-a.lng)*t},names=near(p);
          samples++;for(const name of Object.keys(streak))if(!names.has(name))streak[name]=0;
          for(const name of names){nearby.add(name);streak[name]=(streak[name]||0)+1;maxRun[name]=Math.max(maxRun[name]||0,streak[name]);}at+=step;
        }
        cumulative+=len;
      }
    }
    let names=Object.keys(maxRun).filter(n=>maxRun[n]>=minimum).sort(),status=names.length?'対応あり':nearby.size?'対応未解決':'N06に路線なし';
    const raw_status=status,r=v.roads.get(key),resolution=r?.n06_resolution;
    if(status==='対応未解決'&&resolution&&resolution.result==='N06に路線なし'&&resolution.basis&&resolution.decision){status=resolution.result;names=[];}
    else if(status==='対応未解決'&&resolution&&resolution.basis&&resolution.decision&&r.n06_status==='対応あり'&&r.n06_routes.includes(resolution.result)){status='対応あり';names=[resolution.result];}
    rows.push({key,display_name:r?.display_name,n06_status:status,n06_routes:names,samples,raw_status,max_consecutive_by_name:maxRun,nearby_names:[...nearby].sort(),resolution:raw_status!==status?resolution:null});
  }
  return rows;
}
function alongWay(v,way,pos,sign,metres) {
  const w=v.ways.get(way);let i=pos,p=v.coords.get(w.nodes[i]);
  // T5 分解書 f-3 の「既存の hav」の半径。N06 標本は METHODS の 6,371,000 m。
  while(i+sign>=0&&i+sign<w.nodes.length){const q=v.coords.get(w.nodes[i+sign]);if(!p||!q)return null;const d=hav(p,q,6371008.8);if(d>=metres){const t=d?metres/d:0;return{lat:p.lat+(q.lat-p.lat)*t,lng:p.lng+(q.lng-p.lng)*t};}metres-=d;i+=sign;p=q;}return p;
}
function turn(v,s,t) {
  const p=v.coords.get(s.to),before=alongWay(v,s.way,s.pos+(s.sign===1?1:0),-s.sign,30),after=alongWay(v,t.way,t.pos+(t.sign===-1?1:0),t.sign,30);
  return p&&before&&after?angle(vec(before,p),vec(p,after)):Infinity;
}
function directionAudit(v,graph,edgePaths,groupRecords,params,allGroups=false) {
  const groups=new Map(groupRecords.map(g=>[g.id,{id:g.id,key:g.key,segments:[],votes:[],recorded_reverse:g.reverse_group}])),membership=new Map(),errors=[];
  for(const e of graph.edges.filter(e=>e.kind==='mainline'||e.sub==='terminal'))for(const p of edgePaths.get(e.id)?.segments||[])if(v.bySegment.has(p.id)) {
    if(membership.has(p.id)&&membership.get(p.id)!==e.direction_group)errors.push({segment:p.id,why:'group_disagreement'});
    membership.set(p.id,e.direction_group);
  }
  for(const s of v.segments) {const id=membership.get(sid(s));if(groups.has(id))groups.get(id).segments.push(s);}
  const targets=new Set(allGroups?[...groups.values()].map(g=>g.key):['tomei','ken','c3']),targetGroups=[...groups.values()].filter(g=>targets.has(g.key));
  const linksIn=new Map(),linksOut=new Map(),linkNodes=new Set();
  for(const w of v.ways.values())if(role(w)==='hw'&&/^(motorway_link|trunk_link)$/.test((w.tags||{}).highway))for(let pos=0;pos<w.nodes.length-1;pos++)for(const sign of dirs(w)) {
    const from=w.nodes[pos+(sign===-1?1:0)],to=w.nodes[pos+(sign===1?1:0)];if(!v.inside(v.coords.get(from))||!v.inside(v.coords.get(to)))continue;
    const s={way:w.id,pos,sign,from,to,len:hav(v.coords.get(from),v.coords.get(to))};push(linksIn,to,s);push(linksOut,from,s);linkNodes.add(from);linkNodes.add(to);
  }
  const words=name=>[...String(name||'').normalize('NFKC').replace(/\s/g,'').matchAll(/\((上り|下り|内回り|外回り|東行き|西行き)\)/g)].map(m=>m[1]);
  const votes=[];
  function ballot(type,source,name,word,js,matchPairs) {
    const hits=[],matches=[];
    for(const [j,l]of matchPairs)for(const s of v.incoming.get(j)||[])if(targets.has(s.key)&&turn(v,s,l)<=90){const group=membership.get(sid(s));hits.push(group);matches.push({J:j,theta:turn(v,s,l),group,main:{way:s.way,pos:s.pos,sign:s.sign},link:{way:l.way,pos:l.pos,sign:l.sign}});}
    const gs=arr(new Set(hits.filter(Boolean))),vote={id:`${type}:${source}:${word}`,type,source,name,word,J:arr(new Set(js)),matches,groups:gs,group:gs.length===1?gs[0]:null,status:gs.length===1?'帰属':gs.length?'帰属が決まらない票':'帰属先の無い票'};
    votes.push(vote);if(gs.length===1&&groups.has(gs[0]))groups.get(gs[0]).votes.push(vote);
  }
  for(const n of v.nodes.values())if((n.tags||{}).highway==='motorway_junction')for(const word of new Set(words(n.tags.name)))ballot('分流点',n.id,n.tags.name,word,[n.id],(linksOut.get(n.id)||[]).map(l=>[n.id,l]));
  function insidePolygon(p,ids){let hit=false;for(let i=0,j=ids.length-1;i<ids.length;j=i++){const a=v.coords.get(ids[i]),b=v.coords.get(ids[j]);if(!a||!b)continue;if((a.lat>p.lat)!==(b.lat>p.lat)&&p.lng<(b.lng-a.lng)*(p.lat-a.lat)/(b.lat-a.lat)+a.lng)hit=!hit;}return hit;}
  for(const w of v.ways.values())if(/^(services|rest_area)$/.test((w.tags||{}).highway)&&words(w.tags.name).length) {
    const starts=new Set(w.nodes.filter(n=>linkNodes.has(n)));
    if(w.nodes[0]===w.nodes.at(-1))for(const n of linkNodes)if(insidePolygon(v.coords.get(n),w.nodes))starts.add(n);
    const distances=new Map([...starts].map(n=>[n,0])),queue=[...starts],pairs=[];
    // 正の長さの緩和。上限は累計距離だけで、候補数で切らない。
    for(let i=0;i<queue.length;i++) {
      const n=queue[i],d=distances.get(n);
      for(const l of linksIn.get(n)||[]) {
        const nd=d+l.len;if(nd>3000)continue;
        if(v.incoming.has(l.from)){pairs.push([l.from,l]);continue;}
        if(nd<(distances.get(l.from)??Infinity)){distances.set(l.from,nd);queue.push(l.from);}
      }
    }
    for(const word of new Set(words(w.tags.name)))ballot('施設',w.id,w.tags.name,word,pairs.map(p=>p[0]),pairs);
  }
  const mid=s=>{const a=v.coords.get(s.from),b=v.coords.get(s.to);return{lat:(a.lat+b.lat)/2,lng:(a.lng+b.lng)/2};};
  const index=new Map();
  for(const s of v.segments.filter(s=>targets.has(s.key))){const p=mid(s);push(index,s.key+':'+Math.floor(p.lng*500)+':'+Math.floor(p.lat*500),s);}
  const opposite={'上り':'下り','下り':'上り','内回り':'外回り','外回り':'内回り','東行き':'西行き','西行き':'東行き','北行き':'南行き','南行き':'北行き','時計回り':'反時計回り','反時計回り':'時計回り'};
  for(const g of targetGroups) {
    const counts={};
    for(const s of g.segments) {
      const p=mid(s),x=Math.floor(p.lng*500),y=Math.floor(p.lat*500),d=vec(v.coords.get(s.from),v.coords.get(s.to));let best=null;
      for(let dx=-1;dx<=1;dx++)for(let dy=-1;dy<=1;dy++)for(const t of index.get(g.key+':'+(x+dx)+':'+(y+dy))||[]) {
        const tg=membership.get(sid(t));if(!tg||tg===g.id||angle(d,vec(v.coords.get(t.from),v.coords.get(t.to)))<150)continue;
        const dist=hav(p,mid(t));if(dist<=100&&(!best||dist<best.dist||(dist===best.dist&&sid(t)<best.sid)))best={group:tg,dist,sid:sid(t)};
      }
      if(best)counts[best.group]=(counts[best.group]||0)+1;
    }
    const sorted=Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));g.reverse=sorted.length&&sorted[0][1]>=g.segments.length/2?sorted[0][0]:null;g.reverse_counts=counts;
    g.vote_counts={};for(const vote of g.votes)g.vote_counts[vote.word]=(g.vote_counts[vote.word]||0)+1;
  }
  const bbox5a=p=>p.lat>=35.38&&p.lat<=35.68&&p.lng>=139.30&&p.lng<=139.76;
  const rows=[];
  for(const g of targetGroups.filter(g=>['tomei','ken','c3'].includes(g.key))) {
    const reverse=groups.get(g.reverse),noVotes=g.votes.length===0&&(!reverse||reverse.votes.length===0),within=g.segments.every(s=>bbox5a(v.coords.get(s.from))&&bbox5a(v.coords.get(s.to))),counts={};
    const r=params.roads[g.key],d=vec(r.a,r.b);
    for(const s of g.segments){const q=vec(v.coords.get(s.from),v.coords.get(s.to)),name=d.x*q.x+d.y*q.y>=0?r.dirPos:r.dirNeg;counts[name]=(counts[name]||0)+1;}
    const candidate=noVotes&&within,expected=candidate&&Object.keys(counts).length===1?Object.keys(counts)[0]:null;
    rows.push({id:g.id,key:g.key,segments:g.segments.length,vote_counts:g.vote_counts,votes:g.votes,reverse_group:g.reverse,reverse_candidates:g.reverse_counts,candidate,in_5a_bbox:within,no_votes_self_and_partner:noVotes,counts,expected_dir:expected,expected_basis:candidate?(expected?'5a継承':'幾何'):null});
  }
  return {groups,membership,rows,votes:votes.filter(r=>r.groups.length||r.J.some(j=>(v.incoming.get(j)||[]).some(s=>targets.has(s.key)))),errors,opposite};
}
function wanganAudit(v,groups,n06) {
  const j1=n06.joints.find(j=>j.n06_id==='EA03_686011'),j2=n06.joints.find(j=>j.n06_id==='EA03_691001'),rows=[];
  for(const g of groups.values())if(g.key==='r0477cfb689') {
    const ns=new Set(g.segments.flatMap(s=>[s.from,s.to]));
    const pick=(name,j)=>[...ns].filter(n=>v.nodes.get(n)?.tags?.highway==='motorway_junction'&&String(v.nodes.get(n).tags.name||'').normalize('NFKC').replace(/\s/g,'').replace(/\([^)]*\)/g,'').replace(/JCT|IC|インターチェンジ/g,'').includes(name)).sort((a,b)=>hav(v.coords.get(a),j)-hav(v.coords.get(b),j)||a-b)[0];
    const a=pick('東扇島',j1),b=pick('川崎浮島',j2),edges=new Map();for(const s of g.segments)push(edges,s.from,s);
    const route=(from,to)=>{const q=[from],prev=new Map([[from,null]]);for(let i=0;i<q.length&&!prev.has(to);i++)for(const s of edges.get(q[i])||[])if(!prev.has(s.to)){prev.set(s.to,s);q.push(s.to);}if(!prev.has(to))return null;const result=[];let n=to;while(n!==from){const s=prev.get(n);result.push(sid(s));n=s.from;}return result.reverse();};
    const path=a&&b?(route(a,b)||route(b,a)):null;rows.push({group:g.id,higashi_ogishima:a,kawasaki_ukishima:b,identified:!!path,segments:path||[]});
  }return rows;
}
function audit({v,graph,report,icMatch,unmatched,n06,ledger,params,recover}) {
  const paths=new Map(),coverage=new Map(),edgeById=new Map(graph.edges.map(e=>[e.id,e])),nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
  const failures={},sections={},add=(check,code,id,detail)=>push(failures,check,{code,id,...detail});
  // failures は通常のオブジェクト。Map 用 push とは分ける。
  function bad(check,code,id,detail={}){if(!failures[check])failures[check]=[];failures[check].push({code,id,...detail});}
  for(const e of graph.edges.filter(e=>e.kind==='mainline'||e.sub==='terminal')) {
    const p=recover(e,v);paths.set(e.id,p);
    if(!p.ok){bad('h4','reconstruction_failed',e.id,p);continue;}
    for(const s of p.segments)if(v.bySegment.has(s.id))push(coverage,s.id,e);else {const w=v.ways.get(s.way);if(role(w)==='hw'&&/^(motorway|trunk)$/.test(w.tags?.highway))bad('h4','extra',s.id,{edge:e.id});}
  }
  for(const s of v.segments){const es=coverage.get(sid(s))||[];if(!es.length)bad('h4','missing',sid(s));if(es.length>1)bad('h4','duplicate',sid(s),{edges:es.map(e=>e.id)});for(const e of es)if(e.toll!==s.toll)bad('h1a','toll_mismatch',sid(s),{edge:e.id,expected:s.toll,actual:e.toll});}
  for(const e of graph.edges.filter(e=>e.kind==='mainline'||e.sub==='terminal')){
    const values=new Set((paths.get(e.id)?.segments||[]).map(s=>v.bySegment.get(s.id)).filter(Boolean).map(s=>s.toll));if(values.size>1)bad('h1a','mixed_judgments',e.id,{values:[...values]});
  }
  for(const w of v.main)if(!v.assignment.has(w.id))bad('h4','no_route_key',String(w.id));
  for(const x of v.unknownNames)bad('h4','unknown_name',String(x.way),x);
  const free=v.components.filter(c=>c.result==='free'),buildFree=(report.general.components||[]).filter(c=>c.result==='free');
  const freeIds=arr(free.flatMap(c=>c.ways)),builtIds=arr(buildFree.flatMap(c=>c.ways));
  if(JSON.stringify(freeIds)!==JSON.stringify(builtIds))bad('h1','free_set_mismatch','free_components',{independent:freeIds,recorded:builtIds});
  for(const c of free)if(![2,8].includes(c.row)||c.booths.length||c.tag==='yes')bad('h1','unsafe_free',String(c.id),{component:c});
  for(const id of v.contradictions)bad('h1','ledger_conflict',String(id));
  const surfaceRows=[];
  for(const n of graph.nodes.filter(n=>n.surface_ways!==undefined||(n.osm_node!==undefined&&v.evidence(n.osm_node).free_main_ways.length))) {
    const ev=v.evidence(n.osm_node),recorded=(n.surface_ways||[]).map(x=>typeof x==='object'?x.way:x),all=arr(new Set([...recorded,...ev.free_main_ways]));
    const expected=arr(new Set([...ev.surface_ways,...ev.free_main_ways]));
    const row={node:n.id,osm_node:n.osm_node,recorded_ways:recorded,...ev,all_evidence:all,expected_evidence:expected,recorded_agrees:JSON.stringify(arr(all))===JSON.stringify(expected)};surfaceRows.push(row);
    for(const id of all){const w=v.ways.get(id),c=v.wayComponent.get(id);if(!w||!w.nodes.includes(n.osm_node)||(w.tags||{}).toll==='yes'||(v.mainIds.has(id)&&(c.result!=='free'||c.booths.length))||(!v.mainIds.has(id)&&(!surface(w)||(w.tags||{}).toll==='yes')))bad('h1','unsafe_surface_evidence',n.id+':'+id,{node:n.id,way:id});
      if(v.roads.get(v.assignment.get(id))?.toll_handling==='有料路線')bad('h2','paid_in_surface',n.id+':'+id,{way:id});}
  }
  for(const c of free)if(v.roads.get(c.route)?.toll_handling==='有料路線')bad('h2','paid_free_component',String(c.id));
  for(const e of graph.edges)if(e.toll===false)bad('h1','toll_false',e.id);
  sections.h1={components:free,surface_evidence:surfaceRows,free_ways:freeIds.length};
  sections.h4={population:v.segments.length,main_ways:v.main.length,unnamed_connections:v.unnamed,reconstruction:[...paths].filter(([id,p])=>p.ok).map(([id,p])=>({id,source:p.source,length_skipped:p.length_skipped}))};
  const da=directionAudit(v,graph,paths,report.general.directionGroups,params);
  const groupNames=new Map();
  for(const e of graph.edges) {
    if(!e.dir||e.dir.includes('不明')||!['票','対','5a継承','幾何','名前の表'].includes(e.dir_basis))bad('h3','invalid_direction',e.id);
    const ns=e.kind==='jct_link'?e.dir.split('→'):[e.dir],gs=e.kind==='jct_link'?[e.direction_group,e.direction_group_to]:[e.direction_group],bs=[e.dir_basis,e.dir_basis_to];
    for(let i=0;i<gs.length;i++){if(!da.groups.has(gs[i])||!ns[i]||!['票','対','5a継承','幾何','名前の表'].includes(bs[i]))bad('h3','unknown_group',e.id,{group:gs[i],basis:bs[i]});else {if(!groupNames.has(gs[i]))groupNames.set(gs[i],new Set());groupNames.get(gs[i]).add(ns[i]);}}
  }
  for(const g of da.groups.values()) {
    const names=groupNames.get(g.id)||new Set();if(names.size!==1)bad('h3','group_names',g.id,{names:[...names],edges:graph.edges.filter(e=>e.direction_group===g.id||e.direction_group_to===g.id).map(e=>({id:e.id,dir:e.dir,direction_group:e.direction_group,direction_group_to:e.direction_group_to}))});
    const signs=new Map();for(const s of g.segments){const k=s.way+':'+s.pos;if(signs.has(k)&&signs.get(k)!==s.sign)bad('h3','opposite_in_group',g.id,{segment:k});signs.set(k,s.sign);}
    const reverse=['tomei','ken','c3'].includes(g.key)?g.reverse:g.recorded_reverse;
    if(reverse&&[...names].some(name=>groupNames.get(reverse)?.has(name)))bad('h3','reverse_same_name',g.id,{reverse});
  }
  for(const row of da.rows) {
    const es=graph.edges.filter(e=>e.direction_group===row.id||e.direction_group_to===row.id),record=report.general.directionGroups.find(g=>g.id===row.id);
    const is5a=es.some(e=>(e.direction_group===row.id?e.dir_basis:e.dir_basis_to)==='5a継承');
    if(is5a&&!row.candidate)bad('h3','not_5a_candidate',row.id);
    if(row.candidate)for(const e of es){const name=e.direction_group===row.id?e.dir.split('→')[0]:e.dir.split('→')[1],basis=e.direction_group===row.id?e.dir_basis:e.dir_basis_to;if(basis!==row.expected_basis||(row.expected_dir&&name!==row.expected_dir))bad('h3','5a_mismatch',e.id,{group:row.id,expected_dir:row.expected_dir,actual:name,expected_basis:row.expected_basis,basis});}
    const ranked=Object.entries(row.vote_counts).sort((a,b)=>b[1]-a[1]);if(ranked.length&&(ranked.length===1||ranked[0][1]>ranked[1][1]))for(const e of es){const name=e.direction_group===row.id?e.dir.split('→')[0]:e.dir.split('→')[1],basis=e.direction_group===row.id?e.dir_basis:e.dir_basis_to;if(name!==ranked[0][0]||basis!=='票')bad('h3','vote_mismatch',e.id,{group:row.id,name,basis});}
    if(row.reverse_group!==record.reverse_group||JSON.stringify(row.vote_counts)!==JSON.stringify(record.vote_counts))bad('h3','direction_table_mismatch',row.id);
  }
  sections.h3={five_a:da.rows,votes:da.votes,geometry_named:graph.meta.road_list.filter(r=>graph.edges.some(e=>e.road===r.key&&e.dir_basis==='幾何')),losing_votes:da.rows.flatMap(r=>r.votes.filter(vote=>r.vote_counts[vote.word]<Math.max(...Object.values(r.vote_counts))).map(vote=>({group:r.id,...vote})))};
  const boundaryRows=[];
  for(const b of v.boundaries){if(!(coverage.get(b.outgoing)||[]).length)bad('h5','route_boundary_missing',b.outgoing,{boundary:b});for(const e of coverage.get(b.outgoing)||[]) {
    const first=paths.get(e.id)?.segments[0];if(e.kind!=='mainline'||first?.id!==b.outgoing||!e.fare_relevant)bad('h5','route_boundary',b.outgoing,{boundary:b,edge:e.id,fare_relevant:e.fare_relevant});boundaryRows.push({...b,edge:e.id});
  }}
  const wa=wanganAudit(v,da.groups,n06),wanganEdges=new Set();
  for(const w of wa){if(!w.identified)bad('h5','wangan_unresolved',w.group);for(const id of w.segments)for(const e of coverage.get(id)||[]){wanganEdges.add(e.id);if(!e.fare_relevant||!String(e.fare_reason||'').includes('湾岸'))bad('h5','wangan_fare',e.id,{reason:e.fare_reason});}}
  const jcts=graph.edges.filter(e=>e.kind==='jct_link');for(const e of jcts)if(!e.fare_relevant)bad('h5','jct_fare',e.id);
  sections.h5={boundaries:boundaryRows,wangan:wa,wangan_edges:arr(wanganEdges),jct_links:jcts.length};
  const terminalMap=new Map(v.terminals.map(t=>[t.node,t])),terminalEdges=graph.edges.filter(e=>e.sub==='terminal'),terminalRows=[];
  const ramps=graph.edges.filter(e=>['on_ramp','off_ramp'].includes(e.kind)),surfTypes=new Set(['ramp_surface_end','smartic_gate']);
  for(const e of ramps) {
    const osmid=e.kind==='on_ramp'?e.osm.start_node:e.osm.end_node,node=e.kind==='on_ramp'?e.from:e.to,ev=v.evidence(osmid),ends=[e.from,e.to].filter(id=>surfTypes.has(nodeById.get(id)?.type)),paid=(v.nodeWays.get(osmid)||[]).filter(id=>v.mainIds.has(id)&&['true','null'].includes(v.wayComponent.get(id).result));
    if(ends.length!==1||nodeById.get(node)?.osm_node!==osmid||(!ev.surface_ways.length&&!ev.free_main_ways.length))bad('(e)','invalid_surface_endpoint',e.id,{surfaceEnds:ends,osm_node:osmid,evidence:ev});
    if(e.sub!=='terminal'&&paid.length)bad('(e)','endpoint_touches_toll_mainline',e.id,{osm_node:osmid,main_ways:paid});
    if(e.sub==='terminal') {
      const t=terminalMap.get(osmid),p=paths.get(e.id),mainEnd=e.kind==='on_ramp'?e.to:e.from,degree=graph.edges.filter(x=>x.from===mainEnd||x.to===mainEnd).length,viaDistance=e.via?Math.min(...(p?.segments||[]).map(s=>pointSegment(e.via,v.coords.get(s.from),v.coords.get(s.to)))):Infinity;
      if(!t)bad('(e)','terminal_not_independent',e.id,{osm_node:osmid,kind:e.kind});
      const ok=!!t&&p?.ok&&e.length_m>0&&viaDistance<=1&&(e.length_m>=30||degree>=3)&&(e.kind==='on_ramp'?p.nodes[0]===osmid:p.nodes.at(-1)===osmid);
      terminalRows.push({edge:e.id,X:osmid,length_m:e.length_m,via_distance_m:viaDistance,main_end_degree:degree,ok});if(!ok)bad('h6','terminal_invalid',e.id,terminalRows.at(-1));
      if(graph.edges.some(x=>['mainline','jct_link'].includes(x.kind)&&(x.from===node||x.to===node)))bad('(e)','terminal_mainline_attachment',e.id,{node});
      for(const s of p?.segments||[])if((coverage.get(s.id)||[]).some(x=>x.kind==='mainline'))bad('(e)','terminal_duplicate_mainline',e.id,{segment:s.id});
    }
  }
  for(const t of v.terminals){if(t.entry_arcs.length&&!terminalEdges.some(e=>e.kind==='on_ramp'&&e.osm.start_node===t.node))bad('h6','terminal_entry_missing',String(t.node));if(t.exit_arcs.length&&!terminalEdges.some(e=>e.kind==='off_ramp'&&e.osm.end_node===t.node))bad('h6','terminal_exit_missing',String(t.node));}
  for(const e of graph.edges.filter(e=>['mainline','jct_link'].includes(e.kind)))if([e.from,e.to].some(id=>surfTypes.has(nodeById.get(id)?.type)))bad('(e)','mainline_surface_attachment',e.id);
  sections.h6={terminals:v.terminals,ramps:terminalRows,special:terminalRows.filter(r=>r.X===13903584350||v.terminals.find(t=>t.node===r.X)?.routes.includes('rd52f6f9c39'))};
  const sapaRows=[];
  for(const n of graph.nodes.filter(n=>n.type==='sapa')) {
    const ins=graph.edges.filter(e=>e.to===n.id&&e.sub==='sapa_in'),outs=graph.edges.filter(e=>e.from===n.id&&e.sub==='sapa_out');
    for(const a of ins)for(const b of outs){const ga=da.groups.get(a.direction_group),gb=da.groups.get(b.direction_group),reverse=ga&&(['tomei','ken','c3'].includes(ga.key)?ga.reverse:ga.recorded_reverse),opposite=reverse===b.direction_group||(a.road===b.road&&da.opposite[a.dir]===b.dir);const row={node:n.id,name:n.name,in_edge:a.id,out_edge:b.id,gi:a.direction_group,go:b.direction_group,opposite};sapaRows.push(row);if(opposite)bad('h7','opposite_sapa',n.id,{in_edge:a.id,out_edge:b.id});}
  }
  sections.h7={pairs:sapaRows,split_groups:graph.nodes.filter(n=>n.type==='sapa'&&/新倉|大黒|海ほたる|太田強戸/.test(n.name||'')),special_groups:[...da.groups.values()].filter(g=>['g0003','g0011','g0109','g0136'].includes(g.id)).map(g=>({id:g.id,key:g.key,names:arr(groupNames.get(g.id)||[]),reverse:g.recorded_reverse}))};
  return {v,paths,coverage,edgeById,nodeById,failures,sections,directions:da,terminalMap};
}
function n06Audit(a,{graph,osmOnly,report,icMatch,unmatched,n06,ledger}) {
  const v=a.v,rows=correspondence(v,n06,ledger),failures=[],bad=(code,id,detail={})=>failures.push({code,id,...detail});
  const summary=r=>JSON.stringify([r.n06_status,[...r.n06_routes].sort()]);
  for(const r of rows){if(r.n06_status==='対応未解決')bad('route_unresolved',r.key,r);for(const [source,table]of [['report',report.general.n06Correspondence],['ledger',ledger.routes]]){const o=table.find(o=>o.key===r.key);if(!o||summary(o)!==summary(r))bad('table_mismatch',r.key,{source,actual:r,recorded:o});}}
  const routesFor=j=>arr(new Set(rows.filter(r=>r.n06_status==='対応あり'&&r.n06_routes.some(name=>(j.routes||{})[name]<=50)).map(r=>r.key)));
  const mainNodeKeys=new Map();for(const w of v.main)for(const n of w.nodes){if(!mainNodeKeys.has(n))mainNodeKeys.set(n,new Set());mainNodeKeys.get(n).add(v.assignment.get(w.id));}
  const ramps=graph.edges.filter(e=>['on_ramp','off_ramp'].includes(e.kind));
  const jointRows=[],note=[];
  for(const j of n06.joints) {
    if(!v.inside(j))continue;
    const margin=Math.min(hav(j,{lat:v.box.latMin,lng:j.lng}),hav(j,{lat:v.box.latMax,lng:j.lng}),hav(j,{lat:j.lat,lng:v.box.lngMin}),hav(j,{lat:j.lat,lng:v.box.lngMax}));
    if(margin<2000)continue;
    const keys=routesFor(j);
    if(!keys.length){note.push({n06_id:j.n06_id,name:j.name,routes:Object.keys(j.routes||{}).filter(name=>j.routes[name]<=50),osm: [...v.ways.values()].filter(w=>String(w.tags?.name||'').includes('八重洲')).map(w=>({way:w.id,role:role(w),highway:w.tags.highway}))});continue;}
    const koj=Number(j.koj),evidence=[];
    if([1,2].includes(koj))for(const e of ramps.filter(e=>e.ic_id==='ic:'+j.n06_id))evidence.push({type:'ramp',edge:e.id,road:e.road,distance_m:e.via?hav(j,e.via):Math.min(...[e.from,e.to].map(id=>a.nodeById.get(id)).filter(Boolean).map(n=>hav(j,n)))});
    if([3,4].includes(koj)) {
      const candidate=icMatch.jct_and_boundaries.find(x=>x.n06_id===j.n06_id);
      const dist=e=>e.via?hav(j,e.via):Math.min(...[e.from,e.to].map(id=>a.nodeById.get(id)).filter(Boolean).map(n=>hav(j,n)));
      if(candidate) {
        for(const x of candidate.jct_links||[]){const e=a.edgeById.get(x.edge),d=e?dist(e):Infinity;if(e&&e.kind==='jct_link'&&e.road.split('>').some(k=>keys.includes(k))&&d<=2000)evidence.push({type:'jct_link',edge:e.id,roads:e.road.split('>'),distance_m:d,recorded_dist_m:x.dist_m});}
        for(const x of [...candidate.operator_boundary_edges||[],...candidate.mainline_boundaries||[]]){const e=a.edgeById.get(x.edge),incoming=e?graph.edges.filter(s=>s.kind==='mainline'&&s.to===e.from).map(s=>s.road):[],d=e?dist(e):Infinity;if(e&&e.kind==='mainline'&&e.fare_relevant&&[e.road,...incoming].some(k=>keys.includes(k))&&d<=2000)evidence.push({type:'mainline_boundary',edge:e.id,roads:[e.road,...incoming],distance_m:d,recorded_dist_m:x.dist_m});}
        for(const x of candidate.boundary_links||[]) {
          const start=Number(x.start),end=Number(x.end);if(!v.coords.has(start)||!v.coords.has(end))continue;
          for(const n of [start,end]){const roads=arr(mainNodeKeys.get(n)||[]),d=hav(j,v.coords.get(n));if(roads.some(k=>keys.includes(k))&&d<=2000)evidence.push({type:'boundary_link',start,end,osm_node:n,roads,distance_m:d,recorded_dist_m:x.dist_m});}
        }
      }
      if(koj===4) {
        const sapas=graph.nodes.filter(n=>n.type==='sapa'&&hav(j,n)<=300),sapaEvidence=sapas.map(n=>({node:n.id,name:n.name,distance_m:hav(j,n),entry:graph.edges.filter(e=>e.to===n.id&&e.kind==='mainline'&&keys.includes(e.road)).map(e=>e.id),exit:graph.edges.filter(e=>e.from===n.id&&e.kind==='mainline'&&keys.includes(e.road)).map(e=>e.id)}));
        if(sapas.length&&sapaEvidence.every(x=>x.entry.length&&x.exit.length))evidence.push({type:'sapa',nodes:sapaEvidence});
      }
    }
    const row={n06_id:j.n06_id,name:j.name,koj,keys,margin_m:margin,evidence,matched:evidence.length>0};jointRows.push(row);if(!row.matched)bad('joint_unmatched',j.n06_id,{joint:row});
  }
  const unmatchedRows=[];
  for(const u of unmatched.ramps) {
    const e=a.edgeById.get(u.edge),road=e?.road,r=rows.find(r=>r.key===road);if(!e||!r) {bad('unmatched_record',u.edge);continue;}
    if(!['N06に路線なし','名称の違い','候補なし','候補が複数'].includes(u.reason_code))bad('unmatched_reason',u.edge,{reason_code:u.reason_code});
    const near=n06.joints.filter(j=>routesFor(j).includes(road)).map(j=>({n06_id:j.n06_id,name:j.name,distance_m:e.via?hav(e.via,j):Infinity})).sort((x,y)=>x.distance_m-y.distance_m)[0]||null;
    unmatchedRows.push({edge:e.id,road,osm_names:u.osm_names,reason_code:u.reason_code,n06_status:r.n06_status,nearest_joint:near});
  }
  const distanceOnly=ramps.filter(e=>e.n06_match?.method==='distance_only').map(e=>{const surface=e.kind==='on_ramp'?e.from:e.to;return{edge:e.id,osm_name:(osmOnly||graph).ics.find(ic=>ic.ic_id===e.osm_ic_id)?.name||null,n06:e.n06_match,surface,ic_id_conflict:a.nodeById.get(surface)?.ic_id_conflict||null};});
  a.n06Rows=rows;a.jointRows=jointRows;
  a.sections.h8={routes:rows,joints:jointRows,no_osm_route_notes:note,unmatched:unmatchedRows,distance_only:distanceOnly,no_n06_by_road:unmatchedRows.filter(r=>r.n06_status==='N06に路線なし').reduce((o,r)=>(o[r.road]=(o[r.road]||0)+1,o),{}),unnamed_ics:graph.ics.filter(ic=>!ic.name)};
  a.failures.h8=failures;return a;
}
function reachability(graph,entry,exit,restrictions=false) {
  const out=new Map();for(const e of graph.edges)if(!restrictions||!(e.restriction?.resolved===true&&e.restriction.passable===false))push(out,e.from,e);
  const initial=entry.flatMap(n=>(out.get('s.'+n)||[]).filter(e=>e.kind==='on_ramp'));
  const targets=new Set(exit.map(n=>'s.'+n)),queue=initial.map(e=>e.to),seen=new Set(queue),prev=new Map(initial.map(e=>[e.to,e]));let final=null;
  for(let i=0;i<queue.length&&!final;i++)for(const e of out.get(queue[i])||[]) {
    if(e.kind==='off_ramp'&&targets.has(e.to)){final=e;break;}
    if(['mainline','jct_link'].includes(e.kind)&&!seen.has(e.to)){seen.add(e.to);prev.set(e.to,e);queue.push(e.to);}
  }
  if(!final)return {reachable:false,seen:seen.size,path:[]};const path=[final.id];let n=final.from;while(prev.has(n)){const e=prev.get(n);path.push(e.id);if(e.kind==='on_ramp')break;n=e.from;}return{reachable:true,seen:seen.size,path:path.reverse()};
}
// 確定例外の原因だけを原データと許された出力属性で検査する。
// 除去途中の kept ID、osm.merged_at、parallel_alternatives は条件に使わない。
function exceptionCauses(a,{graph,osmOnly,report,unmatched,n06,recover,exceptions,ledger,osm}) {
  const v=a.v,rows=[],put=(id,target,conditions)=>rows.push({id,target,ok:conditions.every(c=>c.ok),conditions});
  const term=a.terminalMap.get(7157290244),off=a.edgeById.get('off.1745714321.7157290244');
  put('X-001','route:re32e40a0e3:forward',[
    {condition:'独立に認めた終端 X',ok:!!term&&term.routes.includes('re32e40a0e3'),node:7157290244},
    {condition:'指定の出口終端ランプが X に着く',ok:!!off&&off.kind==='off_ramp'&&off.sub==='terminal'&&off.to==='s.7157290244'&&off.osm?.end_node===7157290244,edge:off?.id}]);
  const targets=[...Array.from({length:6},(_,i)=>`26288523:${i+16}:1`),...Array.from({length:4},(_,i)=>`24907532:${i}:1`)];
  const removed=report.parallelRemoved.filter(r=>r.id==='ml.5745156515.9521254286'),r=removed[0],ns=r?.node_sequence||[],removedSegments=[],adjacency=[];
  for(let i=1;i<ns.length;i++) {
    const matches=[];
    for(const wid of [26288523,24907532]){const w=v.ways.get(wid);if(!w)continue;for(let pos=0;pos<w.nodes.length-1;pos++)for(const sign of dirs(w))if(w.nodes[pos+(sign===-1?1:0)]===ns[i-1]&&w.nodes[pos+(sign===1?1:0)]===ns[i])matches.push(`${wid}:${pos}:${sign}`);}
    adjacency.push({from:ns[i-1],to:ns[i],matches});if(matches.length===1)removedSegments.push(matches[0]);
  }
  const kw=v.ways.get(1033563731),keptNodes=[5745156515,9522213903,9521254286],keptIds=['1033563731:0:1','1033563731:1:1'];
  const keptVariants=[['full',graph],['osm-only',osmOnly]].map(([variant,g])=>{
    const e=g.edges.find(e=>e.id==='ml.262596241.287053476'),p=e?recover(e,v):null,ids=p?.ok?p.segments.map(s=>s.id):[],at=ids.indexOf(keptIds[0]);
    return{variant,edge:e?.id,kind:e?.kind,reconstruction_ok:!!p?.ok,at,consecutive:at>=0&&ids[at+1]===keptIds[1],road:e?.road,toll:e?.toll,direction_group:e?.direction_group};
  });
  const segmentFacts=targets.map(id=>{const s=v.bySegment.get(id),gs=s?report.general.directionGroups.filter(g=>g.ways.includes(s.way)).map(g=>g.id):[];return{id,key:s?.key,toll:s?.toll,groups:gs};});
  const length=nodes=>nodes.length>1&&nodes.every(n=>v.coords.has(n))?nodes.slice(1).reduce((sum,n,i)=>sum+hav(v.coords.get(nodes[i]),v.coords.get(n)),0):null;
  const keptLength=length(keptNodes),removedLength=length(ns);
  const conditions=[
    {condition:'(1)',ok:removed.length===1&&JSON.stringify(r.ways)===JSON.stringify([26288523,24907532]),count:removed.length,id:r?.id,ways:r?.ways},
    {condition:'(2)',ok:ns.length===11&&ns[0]===5745156515&&ns.at(-1)===9521254286&&adjacency.every(x=>x.matches.length===1)&&JSON.stringify(arr(removedSegments))===JSON.stringify(arr(targets)),node_count:ns.length,segment_count:removedSegments.length,segments:removedSegments,adjacency},
    {condition:'(3)',ok:!!kw&&role(kw)==='hw'&&kw.tags?.highway==='motorway'&&kw.tags?.oneway==='yes'&&JSON.stringify(kw.nodes)===JSON.stringify(keptNodes)&&keptVariants.every(x=>x.kind==='mainline'&&x.reconstruction_ok&&x.consecutive),way:1033563731,nodes:kw?.nodes,oneway:kw?.tags?.oneway,role:kw&&role(kw),highway:kw?.tags?.highway,segments:keptIds,variants:keptVariants},
    {condition:'(4)',ok:segmentFacts.every(s=>s.key==='r35baf984d2'&&s.toll===true&&JSON.stringify(s.groups)===JSON.stringify(['g0048']))&&keptVariants.every(e=>e.road==='r35baf984d2'&&e.toll===true&&e.direction_group==='g0048'),removed_segments:segmentFacts,variants:keptVariants},
    {condition:'(5)',ok:keptLength!==null&&removedLength!==null&&keptLength<=removedLength,kept_length_m:keptLength,removed_length_m:removedLength}];
  for(const target of targets)put('X-002',target,conditions);
  for(const id of ['EA03_636009','EA03_636006','EA03_636008','EA03_636007','EA03_638003','EA03_638002','EA03_636003','EA03_636004','EA03_636005']){
    const j=a.jointRows.find(j=>j.n06_id===id),route=v.roads.get('r5314628d9a');
    put('X-003',id,[{condition:'対応路線は無料路線 r5314628d9a だけ',ok:!!j&&JSON.stringify(j.keys)===JSON.stringify(['r5314628d9a'])&&route?.handling==='無料路線',keys:j?.keys,handling:route?.handling}]);
  }
  for(const [id,candidates]of [['EA03_513008',[[1505133426,1092086159],[4328731708,1264856325]]],['EA03_504019',[[2460186855,771208508],[2460186857,238163710],[4055843178,771208509]]]]){
    const j=n06.joints.find(j=>j.n06_id===id),facts=candidates.map(([node,way])=>{const c=v.coords.get(node),w=v.ways.get(way),candidate=report.general.paidTouchBoundaries.some(x=>x.node===node&&x.ways.includes(way)),d=j&&c?hav(j,c):Infinity;return{node,way,candidate,distance_m:d,role:w&&role(w),highway:w?.tags?.highway,toll:w?.tags?.toll,raw_contains_node:!!w?.nodes.includes(node),ok:candidate&&d<=2000&&!!w?.nodes.includes(node)&&role(w)==='touch'&&surface(w)&&w.tags?.toll==='yes'};});
    put('X-004',id,[{condition:'候補の全ノードが原データで有料の接続道路に接し、2 km 以内',ok:facts.every(f=>f.ok),candidates:facts}]);
  }
  for(const id of ['EA03_520047','EA03_522031','EA03_511018','EA03_511004']){
    const j=n06.joints.find(j=>j.n06_id===id),keys=a.jointRows.find(x=>x.n06_id===id)?.keys||[],facts=[];
    for(const u of unmatched.ramps.filter(u=>u.reason_code==='名称の違い')){
      const e=a.edgeById.get(u.edge),oe=osmOnly.edges.find(x=>x.id===u.edge);if(!e||!oe||!keys.includes(e.road)||!['on_ramp','off_ramp'].includes(e.kind))continue;
      const d=j&&e.via?hav(j,e.via):Infinity;if(d>2000)continue;
      const names=[...u.osm_names?.direct||[],...u.osm_names?.component||[]].filter(n=>/[,、]/.test(n));
      // SA/PA のスマート IC の名は、本線上の分流点から付くこともある。
      // 完全一致したランプ内ノードだけに限定せず、原データの近傍の名前を確かめる。
      const sources=[...v.nodes.values()].filter(n=>/[,、]/.test(n.tags?.name||'')&&v.coords.has(n.id)&&hav(j,v.coords.get(n.id))<=2000&&names.some(name=>String(n.tags.name).normalize('NFKC').replace(/\([^)]*\)|\s/g,'').startsWith(name.split(/[,、]/)[0]))).map(n=>({node:n.id,name:n.tags.name,distance_m:hav(j,v.coords.get(n.id))}));
      if(sources.length)facts.push({edge:e.id,road:e.road,distance_m:d,reason_code:u.reason_code,names,raw_sources:sources,osm_only_present:true});
    }
    put('X-005',id,[{condition:'対応路線の区切り記号付き OSM 名の未照合ランプが 2 km 以内にある',ok:facts.length>0,ramps:facts}]);
  }
  const x=a.terminalMap.get(257059180),e=a.edgeById.get('on.257059180.390280875'),o=a.edgeById.get('off.630496117.257059180'),paid=(v.nodeWays.get(257059180)||[]).filter(id=>v.mainIds.has(id)&&['true','null'].includes(v.wayComponent.get(id).result));
  put('X-007','on.257059180.390280875',[
    {condition:'X は r9a09577ef2 の終端で入る区間は way 491249075',ok:!!x&&x.routes.includes('r9a09577ef2')&&x.exit_arcs.length>0&&x.exit_arcs.every(s=>s[2]===491249075),node:257059180,routes:x?.routes,exit_arcs:x?.exit_arcs},
    {condition:'接する保持本線は同路線だけ',ok:paid.length>0&&paid.every(id=>v.assignment.get(id)==='r9a09577ef2'),main_ways:paid},
    {condition:'指定の通常入口と出口終端ランプ',ok:!!e&&e.kind==='on_ramp'&&e.sub!=='terminal'&&e.from==='s.257059180'&&!!o&&o.kind==='off_ramp'&&o.sub==='terminal'&&o.to==='s.257059180',entry:e?.id,exit:o?.id}]);
  rows.push(...confirmedH8Causes(a,{graph,report,n06,exceptions,ledger,osm}));
  return rows;
}
// T6-2 受入で確定した X-010〜X-017。構築の対応表・照合結果ではなく、
// 原データ、出力属性、V3/V4/V8/V10 の独立判定から条件を確かめる。
function confirmedH8Causes(a,{graph,report,n06,exceptions,ledger,osm}) {
  const v=a.v,out=[],entries=new Map((exceptions?.entries||[]).map(e=>[e.id,e]));
  const joint=id=>n06.joints.find(j=>j.n06_id===id);
  const keys=j=>arr(new Set(a.n06Rows.filter(r=>r.n06_status==='対応あり'&&r.n06_routes.some(name=>(j?.routes||{})[name]<=50)).map(r=>r.key)));
  const distance=(j,p)=>j&&p?hav(j,p):Infinity;
  const wayDistance=(j,w)=>w?Math.min(...w.nodes.map(n=>distance(j,v.coords.get(n)))):Infinity;
  const boundary=(edge,from,to)=>a.sections.h5.boundaries.filter(b=>b.edge===edge&&b.from===from&&b.to===to);
  const put=(id,target,conditions)=>out.push({id,target,ok:conditions.length>0&&conditions.every(c=>c.ok),conditions});
  const free=v.roads.get('r5314628d9a'),fj=joint('EA03_636010');
  put('X-010','EA03_636010',[{condition:'対応路線は無料路線 r5314628d9a だけ',keys:keys(fj),handling:free?.handling,ok:JSON.stringify(keys(fj))===JSON.stringify(['r5314628d9a'])&&free?.handling==='無料路線'}]);
  for(const target of entries.get('X-011')?.targets||[]) {
    const j=joint(target),facts=(entries.get('X-011').cause.candidates?.[target]||[]).map(([node,way])=>{
      const w=v.ways.get(way),d=distance(j,v.coords.get(node)),candidate=report.general.paidTouchBoundaries.some(x=>x.node===node&&x.ways.includes(way));
      return{node,way,distance_m:d,candidate,role:w&&role(w),tags:w?.tags,ok:candidate&&d<=2000&&!!w?.nodes.includes(node)&&surface(w)&&w.tags?.toll==='yes'};
    });
    put('X-011',target,[{condition:'全候補が原データの有料接続道路上にあり 2 km 以内',candidates:facts,ok:facts.length>0&&facts.every(f=>f.ok)}]);
  }
  const links=new Set([...v.ways.values()].filter(w=>role(w)==='hw'&&/_link$/.test(w.tags?.highway||'')).map(w=>w.id));
  const used=new Set(graph.edges.flatMap(e=>e.osm?.ways||[]));
  for(const target of entries.get('X-012')?.targets||[]) {
    const j=joint(target),spec=entries.get('X-012').cause.groups?.[target],facts=[],seen=new Set();
    for(const seed of spec?.seeds||[]) {
      if(seen.has(seed))continue;
      const group=new Set(),stack=links.has(seed)?[seed]:[];
      while(stack.length){const id=stack.pop();if(group.has(id))continue;group.add(id);seen.add(id);for(const n of v.ways.get(id).nodes)for(const other of v.nodeWays.get(n)||[])if(links.has(other)&&!group.has(other))stack.push(other);}
      const ns=new Set([...group].flatMap(id=>v.ways.get(id).nodes)),touching=new Set([...ns].flatMap(n=>v.nodeWays.get(n)||[]).filter(id=>!group.has(id)));
      const main=[...touching].filter(id=>v.mainIds.has(id)).map(id=>({way:id,key:v.assignment.get(id),result:v.wayComponent.get(id)?.result})),other=[...touching].filter(id=>!v.mainIds.has(id));
      const paid=main.filter(x=>keys(j).includes(x.key)&&x.result==='true'),excluded=main.filter(x=>x.key===spec?.excluded_route&&x.result==='excluded'),d=Math.min(...[...ns].map(n=>distance(j,v.coords.get(n))));
      facts.push({seed,ways:arr(group),distance_m:d,used_ways:[...group].filter(id=>used.has(id)),main,other,ok:group.size>0&&d<=1000&&[...group].every(id=>!used.has(id))&&paid.length>0&&excluded.length>0&&main.length===paid.length+excluded.length&&other.length===0});
    }
    put('X-012',target,[{condition:'指定除外路線は台帳で除外',route:spec?.excluded_route,handling:v.roads.get(spec?.excluded_route)?.handling,ok:v.roads.get(spec?.excluded_route)?.handling==='除外'}, {condition:'全 seed の連絡路成分は未使用で対応有料本線と除外本線だけに接する',groups:facts,ok:(spec?.seeds?.length||0)>0&&spec.seeds.every(id=>seen.has(id))&&facts.every(f=>f.ok)}]);
  }
  for(const target of entries.get('X-013')?.targets||[]) {
    const j=joint(target),spec=entries.get('X-013').cause.facts?.[target],route=spec?.route,r=v.roads.get(route);
    const ramps=(spec?.ramps||[]).map(id=>{const e=a.edgeById.get(id),d=distance(j,e?.via);return{edge:id,kind:e?.kind,road:e?.road,ic_id:e?.ic_id,distance_m:d,ok:!!e&&['on_ramp','off_ramp'].includes(e.kind)&&e.road===route&&e.ic_id?.startsWith('osm-ic:'+route+':')&&d<=2000};});
    const connections=(spec?.links||[]).map(id=>{
      const e=a.edgeById.get(id),d=distance(j,e?.via),pairs=e?.kind==='jct_link'?[e.road.split('>')]:keys(j).flatMap(k=>[[k,route],[route,k]].filter(([f,t])=>e?.kind==='mainline'&&e.fare_relevant&&boundary(id,f,t).length));
      const valid=pairs.filter(([f,t])=>(keys(j).includes(f)&&t===route)||(f===route&&keys(j).includes(t)));
      return{edge:id,kind:e?.kind,distance_m:d,pairs:valid,ok:!!e&&d<=2000&&valid.length>0};
    });
    const directions=connections.flatMap(x=>x.ok?x.pairs:[]);
    put('X-013',target,[{condition:'隣の路線は台帳で N06 に路線なし',route,status:r?.n06_status,ok:r?.n06_status==='N06に路線なし'}, {condition:'指定ランプが隣の路線の osm-ic にあり 2 km 以内',ramps,ok:ramps.length>0&&ramps.every(x=>x.ok)}, {condition:'指定辺が対応路線との接続を両方向に表し 2 km 以内',connections,ok:connections.length>0&&connections.every(x=>x.ok)&&directions.some(([f,t])=>keys(j).includes(f)&&t===route)&&directions.some(([f,t])=>f===route&&keys(j).includes(t))}]);
  }
  for(const target of entries.get('X-014')?.targets||[]) {
    const j=joint(target),facts=(entries.get('X-014').cause.edges||[]).map(([id,from,to,node])=>{
      const e=a.edgeById.get(id),p=a.paths.get(id),matches=boundary(id,from,to),d=distance(j,v.coords.get(node));
      return{edge:id,from,to,node,distance_m:d,boundaries:matches,ok:!!e&&e.kind==='mainline'&&e.fare_relevant&&p?.ok&&p.nodes[0]===node&&matches.some(b=>b.node===node)&&d<=2000};
    });
    put('X-014',target,[{condition:'小松川線と京葉道路の指定本線境界が両方向にあり 2 km 以内',edges:facts,ok:facts.length===2&&facts.every(f=>f.ok)&&facts.some(f=>f.from==='r67e182ba68'&&f.to==='r9459aa655a')&&facts.some(f=>f.from==='r9459aa655a'&&f.to==='r67e182ba68')}]);
  }
  for(const target of entries.get('X-015')?.targets||[]) {
    const j=joint(target),facts=(entries.get('X-015').cause.facts?.[target]||[]).map(([id,other])=>{
      const e=a.edgeById.get(id),o=joint(other),d=distance(j,e?.via);
      return{edge:id,ic_id:e?.ic_id,other,other_koj:o?.koj,road:e?.road,keys:keys(j),other_keys:keys(o),distance_m:d,ok:!!e&&['on_ramp','off_ramp'].includes(e.kind)&&keys(j).includes(e.road)&&e.ic_id==='ic:'+other&&other!==target&&Number(o?.koj)===1&&keys(o).includes(e.road)&&d<=500};
    });
    put('X-015',target,[{condition:'指定ランプは同路線の別の N06 一般 IC に照合され 500 m 以内',ramps:facts,ok:facts.length>0&&facts.every(f=>f.ok)}]);
  }
  const unmappedYaesu=j=>(j?.routes||{})['首都高速八重洲線']<=50&&!(ledger?.routes||[]).some(r=>r.n06_routes?.includes('首都高速八重洲線'));
  const yj=joint('EA03_671024'),construction=[390441536,390441537].map(id=>{const w=v.ways.get(id),d=wayDistance(yj,w);return{way:id,role:w&&role(w),tags:w?.tags,distance_m:d,ok:w?.tags?.name==='首都高速八重洲線'&&w.tags.highway==='construction'&&role(w)==='touch'&&d<=2000};});
  put('X-016','EA03_671024',[{condition:'50 m 以内に台帳未対応の八重洲線',routes:yj?.routes,ok:unmappedYaesu(yj)}, {condition:'指定八重洲線 way は touch の工事中道路で 2 km 以内',ways:construction,ok:construction.every(f=>f.ok)}]);
  const tj=joint('EA03_685002'),named=osm.elements.filter(e=>Object.values(e.tags||{}).some(s=>/常盤橋|常磐橋/.test(String(s)))).map(e=>({type:e.type,id:e.id}));
  put('X-017','EA03_685002',[{condition:'0 m に台帳未対応の八重洲線があり常盤橋・常磐橋のタグ要素なし',routes:tj?.routes,named,ok:unmappedYaesu(tj)&&tj.routes['首都高速八重洲線']===0&&named.length===0}]);
  const ringKeys=new Set(a.n06Rows.filter(r=>r.n06_routes.includes('首都高速都心環状線')).map(r=>r.key));
  for(const target of ['EA03_671009','EA03_671003']) {
    const j=joint(target),names=Object.keys(j?.routes||{}).filter(name=>j.routes[name]<=300).sort(),nearJct=graph.edges.filter(e=>e.kind==='jct_link'&&distance(j,e.via)<=300).map(e=>e.id),nearOther=v.main.filter(w=>!ringKeys.has(v.assignment.get(w.id))&&wayDistance(j,w)<=300).map(w=>({way:w.id,key:v.assignment.get(w.id),distance_m:wayDistance(j,w)}));
    put('X-017',target,[{condition:'300 m 以内は都心環状線だけで JCT via と別路線本線のノードなし',names,near_jct:nearJct,near_other_main:nearOther,ok:JSON.stringify(names)===JSON.stringify(['首都高速都心環状線'])&&nearJct.length===0&&nearOther.length===0}]);
  }
  return out;
}
// V1〜V5。入力の原データから計算し、構築器の判定関数・名前の構築記録は読まない。
const nameKey = s => String(s || '').normalize('NFKC').replace(/\s/g, '');
const nameCompare = s => nameKey(s).replace(/[ヶヵ]/g, 'ケ');
function nameBases(s, discardJct = true) {
  const parts=String(s||'').normalize('NFKC').replace(/\([^)]*\)/g,'').split(/[\/・;]/),out=[];
  for(let part of parts) {
    part=part.replace(/^[、,，。;\s]+|[、,，。;\s]+$/g,'').replace(/\s/g,'');
    if(discardJct&&/(?:JCT|ジャンクション)$/i.test(part))continue;
    for(let i=0;i<3;i++)part=part.replace(/(?:スマートインターチェンジ|インターチェンジ|ジャンクション|スマートIC|パーキングエリア|サービスエリア|SIC|JCT|IC|インター|出入口|出口|入口|料金所|北側|南側|PA|SA)$/i,'');
    if(part&&!/^(?:スマート|第\d+出口)$/.test(part))out.push(part);
  }
  return [...new Set(out)];
}
function normalizeNames(text, {names, routeNames, surfaceNames = [], clauses = () => []}) {
  const key=s=>nameKey(norm(s)),routes=new Set(routeNames.map(key)),roads=new Set(names.road_words.map(r=>key(r.word))),surfaces=new Set(surfaceNames.map(key));
  const pass=text=>{
    let s=String(text||'').normalize('NFKC');
    for(const r of names.ic_name_fixes)s=s.split(r.before.normalize('NFKC')).join(r.after.normalize('NFKC'));
    let parts=[...new Set(s.replace(/^[、,，。;\s]+|[、,，。;\s]+$/g,'').split('/').map(p=>p.replace(/^[、,，。;\s]+|[、,，。;\s]+$/g,'')).filter(Boolean))];
    parts=parts.filter(p=>!routes.has(key(p))&&(!(roads.has(key(p))||surfaces.has(key(p)))||clauses(p).length));
    if(parts.some(p=>!p.endsWith('分岐')))parts=parts.filter(p=>!p.endsWith('分岐'));
    return [...new Set(parts.flatMap(p=>nameBases(p)))];
  };
  return [...new Set(pass(text).flatMap(pass))];
}
function nameContext(v, graph, ledger, n06, names) {
  const ramps=graph.edges.filter(e=>['on_ramp','off_ramp'].includes(e.kind));
  const routeNames=ledger.routes.flatMap(r=>[r.normalized_name,r.display_name,...(r.aliases||[])]).filter(Boolean);
  const nodeById=new Map(graph.nodes.map(n=>[n.id,n])),surfaceNode=e=>e.kind==='on_ramp'?e.from:e.to;
  const surfaceNames=e=>[...new Set((v.nodeWays.get(nodeById.get(surfaceNode(e))?.osm_node)||[])
    .filter(id=>surface(v.ways.get(id))||v.wayComponent.get(id)?.result==='free')
    .flatMap(id=>[v.ways.get(id).tags?.name,v.ways.get(id).tags?.ref]).filter(Boolean))];
  // link way は共有する全 node でつなぐ。本線上の node も含む。
  const linkWays=new Map([...v.ways].filter(([,w])=>role(w)==='hw'&&/^(motorway_link|trunk_link)$/.test(w.tags?.highway))),at=new Map();
  for(const [id,w]of linkWays)for(const n of w.nodes)push(at,n,id);
  const components=new Map(),seen=new Set();
  for(const [seed]of linkWays)if(!seen.has(seed)){
    const c={ids:new Set(),edges:[]},queue=[seed];seen.add(seed);
    for(let i=0;i<queue.length;i++){const w=linkWays.get(queue[i]);c.ids.add(w.id);components.set(w.id,c);for(const n of w.nodes)for(const id of at.get(n)||[])if(!seen.has(id)){seen.add(id);queue.push(id);}}
  }
  for(const e of graph.edges)if(['on_ramp','off_ramp','jct_link'].includes(e.kind)&&e.sub!=='terminal')components.get(e.osm?.ways?.[0])?.edges.push(e);
  const sourceRaw=e=>[...(e.osm?.junctions||[]),...(e.osm?.toll_booths||[])].map(x=>v.nodes.get(x.osm_node)?.tags?.name||x.name).filter(Boolean);
  const componentEdges=e=>components.get(e.osm?.ways?.[0])?.edges||[];
  const componentRaw=e=>e.sub==='terminal'?[]:componentEdges(e).flatMap(sourceRaw);
  const clauses=(e,part)=>{
    const b=nameBases(part,false).map(nameCompare),out=[],raw=[...sourceRaw(e),...componentEdges(e).filter(x=>['on_ramp','off_ramp'].includes(x.kind)).flatMap(sourceRaw)];
    if(raw.some(s=>nameBases(s,false).some(n=>b.includes(nameCompare(n)))))out.push('(i)');
    const route=v.roads.get(e.road),p=e.via||nodeById.get(surfaceNode(e));
    if(p&&n06.joints.some(j=>[1,2].includes(Number(j.koj))&&(route?.n06_routes||[]).some(r=>j.routes?.[r]<=50)&&hav(p,j,6371008.8)<=3000&&nameBases(j.name,false).some(n=>b.includes(nameCompare(n)))))out.push('(ii)');
    return out;
  };
  const normalized=(e,s)=>normalizeNames(s,{names,routeNames,surfaceNames:surfaceNames(e),clauses:p=>clauses(e,p)}),rows=new Map();
  for(const e of ramps){
    const end=nodeById.get(e.to)?.osm_node;
    const directSources=[...(e.osm?.junctions||[]).filter(x=>e.kind!=='on_ramp'||x.osm_node!==end),...(e.osm?.toll_booths||[])].map(x=>v.nodes.get(x.osm_node)?.tags?.name||x.name).filter(Boolean);
    const direct=directSources.flatMap(s=>normalized(e,s));
    for(const id of [e.from,e.to])if(nodeById.get(id)?.type==='sapa')direct.push(...normalized(e,nodeById.get(id).name));
    if(e.sub!=='terminal')for(const s of e.osm?.way_names||[])direct.push(...normalized(e,s).filter(b=>!/高速|道路|線$/.test(b)));
    const component=[...new Set(componentRaw(e).flatMap(s=>normalized(e,s)))],terminal=[],point=nodeById.get(surfaceNode(e));
    if(e.sub==='terminal'&&point)for(const [id,n]of v.nodes)if(n.tags?.name&&(n.tags.highway==='motorway_junction'||n.tags.barrier==='toll_booth')&&
      (v.nodeWays.get(id)||[]).some(w=>v.assignment.get(w)===e.road&&['true','null'].includes(v.wayComponent.get(w)?.result))&&hav(point,v.coords.get(id),6371008.8)<=2000)terminal.push(...normalized(e,n.tags.name));
    const smart=[...sourceRaw(e),...(e.osm?.way_names||[])].some(s=>/スマート|SIC/i.test(String(s).normalize('NFKC')))||[e.from,e.to].some(id=>nodeById.get(id)?.type==='sapa');
    rows.set(e.id,{edge:e.id,road:e.road,direct:[...new Set(direct)],component,terminal:[...new Set(terminal)],smart,candidates:[...new Set([...direct,...component,...terminal])]});
  }
  for(const e of ramps){
    const row=rows.get(e.id);if(row.candidates.length||!e.via)continue;
    const candidates=ramps.filter(x=>x.road===e.road&&x.id!==e.id&&x.via&&rows.get(x.id).smart===row.smart).flatMap(x=>{
      const r=rows.get(x.id),ns=r.direct.length?r.direct:r.component;
      return ns.length===1?[{e:x,name:ns[0],d:hav(e.via,x.via,6371008.8)}]:[];
    }).filter(x=>x.d<=1500).sort((a,b)=>a.d-b.d||a.name.localeCompare(b.name,'en'));
    if(candidates.length){const best=candidates[0];row.nearest=best.e.id;row.candidates=normalized(e,best.name);}
  }
  return {ramps,rows,routeNames,nodeById,surfaceNode,surfaceNames,clauses,normalized};
}
function verifyAttribution({graph,icMatch,names,context}) {
  const failures=[],bad=(id,code,extra={})=>failures.push({id,code,...extra}), keep=new Map(names.match_keep.map(r=>[r.edge,r]));
  const matches=new Map(icMatch.ramps.map(r=>[r.edge,r]));
  for(const r of names.match_keep) {const e=context.ramps.find(e=>e.id===r.edge),m=matches.get(r.edge);if(!e||!m||m.n06_id!==r.n06_id||m.method!=='match_keep(G1)'||e.n06_match?.n06_id!==r.n06_id||e.n06_match?.method!=='match_keep(G1)'||e.ic_id!=='ic:'+r.n06_id)bad(r.edge,'keep_mismatch',{expected:r.n06_id,match:m});}
  const keptJoints=new Set(names.match_keep.map(r=>r.n06_id)),distance=[];
  for(const e of context.ramps) {
    const m=matches.get(e.id), method=m?.method || e.n06_match?.method;
    if(method==='match_keep(G1)'&&!keep.has(e.id))bad(e.id,'unlisted_keep');
    if((keptJoints.has(m?.n06_id)||keptJoints.has(e.n06_match?.n06_id)||[...keptJoints].some(id=>e.ic_id==='ic:'+id))&&keep.get(e.id)?.n06_id!==(m?.n06_id||e.n06_match?.n06_id))bad(e.id,'other_match_on_kept_joint',{match:m});
    if(method==='distance_only'){const row=context.rows.get(e.id);distance.push(row);if(row.candidates.length)bad(e.id,'named_distance_only',{candidates:row.candidates});}
  }
  return {failures,keep_rows:names.match_keep.length,distance_only:distance.length,named_distance_only:distance.filter(r=>r.candidates.length).length,distance_only_rows:distance};
}
function verifyNames({graphs,names,context}) {
  const failures=[],counts=[],fixUses=names.ic_name_fixes.map(r=>({before:r.before,after:r.after,raw:0,output:0}));
  const routes=new Set(context.routeNames.map(nameKey)),roads=new Set(names.road_words.map(r=>nameKey(r.word)));
  for(let version=0;version<graphs.length;version++) {
    const graph=graphs[version], nodes=graph.nodes.filter(n=>n.name),ics=graph.ics.filter(i=>i.name);
    counts.push({version,ics:ics.length,nodes:nodes.length});
    for(const [kind,items]of [['ic',ics],['node',nodes]])for(const item of items) {
      const id=kind==='ic'?item.ic_id:item.id,ramps=kind==='ic'?context.ramps.filter(e=>e.ic_id===id||e.osm_ic_id===id):[];
      const whole=String(item.name).normalize('NFKC'),parts=whole.split('/').map(p=>p.trim()),seen=new Set();
      if(/^[、,，。;\s]|[、,，。;\s]$/.test(whole))failures.push({id,version,kind,name:item.name,why:['delimiter']});
      for(const p of parts) {
        const key=nameKey(p), why=[];
        if(!p||/^[、,，。;]|[、,，。;]$/.test(p))why.push('delimiter');
        if(seen.has(key))why.push('duplicate');seen.add(key);
        if(routes.has(key))why.push('route_name');
        const surfaceHit=ramps.some(e=>context.surfaceNames(e).some(n=>nameKey(n)===key));
        if((roads.has(key)||surfaceHit)&&!ramps.some(e=>context.clauses(e,p).length))why.push('road_or_surface_name_without_C2');
        for(const fix of names.ic_name_fixes)if(p.includes(fix.before.normalize('NFKC')))why.push('uncorrected:'+fix.before);
        if(why.length)failures.push({id,version,kind,name:item.name,part:p,why});
      }
      for(const fix of fixUses)if(nameBases(fix.after).some(b=>nameBases(item.name).some(n=>nameCompare(n)===nameCompare(b))))fix.output++;
    }
  }
  for(const fix of fixUses) {for(const n of context.nodeById.values())if(String(n.name||'').normalize('NFKC').includes(fix.before))fix.raw++;if(!fix.output)failures.push({id:fix.before,code:'unused_name_fix'});}
  return {failures,versions:counts,fixes:fixUses};
}
function verifyTerminalMerge({graph,v}) {
  const byIc=new Map(),nodeById=new Map(graph.nodes.map(n=>[n.id,n]));
  for(const e of graph.edges.filter(e=>['on_ramp','off_ramp'].includes(e.kind)))push(byIc,e.ic_id,e);
  const terminals=[...byIc].filter(([,es])=>es.every(e=>e.sub==='terminal')),failures=[];
  const end=e=>nodeById.get(e.kind==='on_ramp'?e.from:e.to);
  const tokens=n=>new Set((v.nodeWays.get(n.osm_node)||[]).filter(id=>surface(v.ways.get(id))||v.wayComponent.get(id)?.result==='free').flatMap(id=>[v.ways.get(id).tags?.name,v.ways.get(id).tags?.ref]).filter(Boolean).map(nameKey));
  for(let i=0;i<terminals.length;i++)for(let j=i+1;j<terminals.length;j++)for(const a of terminals[i][1])for(const b of terminals[j][1])if(a.road===b.road) {
    const na=end(a),nb=end(b);if(!na||!nb)continue;const d=hav(na,nb,6371008.8);if(d>50)continue;
    const ta=tokens(na),common=[...tokens(nb)].filter(t=>ta.has(t));if(common.length)failures.push({id:a.id,other:b.id,ics:[terminals[i][0],terminals[j][0]],distance_m:d,common});
  }
  return {failures,threshold_m:50,terminal_ics:terminals.length,unmerged_pairs:failures.length};
}
function geometryName(v,segments) {
  // 反復型の深さ優先探索で強連結成分を求める（長い本線でも呼出しスタックを使わない）。
  const out=new Map(),incoming=new Map(),nodes=new Set();for(const s of segments){push(out,s.from,s.to);push(incoming,s.to,s.from);nodes.add(s.from);nodes.add(s.to);}
  const seen=new Set(),order=[];
  for(const seed of nodes)if(!seen.has(seed)){const stack=[[seed,0]];seen.add(seed);while(stack.length){const frame=stack.at(-1),next=out.get(frame[0])||[];if(frame[1]<next.length){const n=next[frame[1]++];if(!seen.has(n)){seen.add(n);stack.push([n,0]);}}else{order.push(frame[0]);stack.pop();}}}
  const membership=new Map(),components=[];
  for(const seed of order.reverse())if(!membership.has(seed)){const id=components.length,ns=[],queue=[seed];membership.set(seed,id);for(let i=0;i<queue.length;i++){const n=queue[i];ns.push(n);for(const m of incoming.get(n)||[])if(!membership.has(m)){membership.set(m,id);queue.push(m);}}components.push({ns,length:0,segments:[]});}
  for(const s of segments)if(membership.get(s.from)===membership.get(s.to)){const c=components[membership.get(s.from)];c.length+=hav(v.coords.get(s.from),v.coords.get(s.to));c.segments.push(s);}
  const rings=components.filter(c=>c.length>=1000);
  if(rings.length){let cross=0;for(const c of rings){const center=c.ns.reduce((p,n)=>({lat:p.lat+v.coords.get(n).lat/c.ns.length,lng:p.lng+v.coords.get(n).lng/c.ns.length}),{lat:0,lng:0}),k=Math.cos(rad(center.lat));for(const s of c.segments){const a=v.coords.get(s.from),b=v.coords.get(s.to);cross+=(a.lng-center.lng)*k*(b.lat-center.lat)-(a.lat-center.lat)*(b.lng-center.lng)*k;}}return cross>0?'反時計回り':'時計回り';}
  const sum=segments.reduce((p,s)=>{const d=vec(v.coords.get(s.from),v.coords.get(s.to));return{x:p.x+d.x,y:p.y+d.y};},{x:0,y:0});
  return Math.abs(sum.x)>=Math.abs(sum.y)?sum.x>=0?'東行き':'西行き':sum.y>=0?'北行き':'南行き';
}
function verifyDirections({a,graphs,report,names,params}) {
  const da=directionAudit(a.v,graphs[0],a.paths,report.general.directionGroups,params,true),failures=[],rows=[],used=new Map(names.directions.map((r,i)=>[i,[]]));
  const candidates=new Set(a.directions.rows.filter(r=>r.candidate).map(r=>r.id));
  for(const g of da.groups.values()) {
    const geometry=geometryName(a.v,g.segments),noVotes=!g.votes.length&&!da.groups.get(g.reverse)?.votes.length,eligible=noVotes&&!candidates.has(g.id);
    const hits=names.directions.map((r,i)=>({r,i})).filter(({r})=>r.road===g.key&&r.geometry_name===geometry);
    if(hits.length>1)failures.push({id:g.id,code:'duplicate_direction_rows'});
    const selected=eligible&&hits.length===1?hits[0]:null;if(selected)used.get(selected.i).push(g.id);
    rows.push({id:g.id,key:g.key,geometry,reverse:g.reverse,votes:g.votes.length,eligible,expected:selected?selected.r.name:geometry,table:!!selected});
    for(let version=0;version<graphs.length;version++)for(const e of graphs[version].edges) {
      const reference=version===2?a.edgeById.get(e.id):e;
      const gs=reference?.kind==='jct_link'?[reference.direction_group,reference.direction_group_to]:[reference?.direction_group],ds=String(e.dir||'').split('→');
      for(let part=0;part<gs.length;part++)if(gs[part]===g.id){const basis=part?e.dir_basis_to:e.dir_basis;
        if(ds[part]==='不明'||(eligible&&(ds[part]!== (selected?selected.r.name:geometry)||(version<2&&basis!==(selected?'名前の表':'幾何'))))||(!selected&&version<2&&basis==='名前の表'))failures.push({id:g.id,edge:e.id,version,part,actual:ds[part],basis,expected:selected?selected.r.name:geometry,eligible,code:'direction_part'});
      }
    }
  }
  for(const [i,ids]of used)if(!ids.length)failures.push({id:'directions:'+i,code:'unused_direction',row:names.directions[i]});
  const byRoad=new Map();for(const r of names.directions)push(byRoad,r.road,r);
  for(const [road,rs]of byRoad)if(new Set(rs.map(r=>r.geometry_name)).size!==rs.length||new Set(rs.map(r=>r.name)).size!==rs.length)failures.push({id:road,code:'not_one_to_one'});
  for(const row of rows.filter(r=>r.table)){
    const other=rows.find(r=>r.id===row.reverse);
    if(row.reverse&&(!other?.table||other.key!==row.key||da.opposite[row.expected]!==other.expected))failures.push({id:row.id,reverse:row.reverse,code:'direction_pair'});
    if(!names.directions.some(r=>r.road===row.key&&r.geometry_name===da.opposite[row.geometry]&&r.name===da.opposite[row.expected]))failures.push({id:row.id,code:'one_sided_route'});
  }
  const set=xs=>JSON.stringify([...new Set(xs)].sort());
  let sapaNodes=0,basis=0,basisTo=0;const renamedEdges=new Set();
  for(let version=0;version<graphs.length;version++) {
    const g=graphs[version];
    for(const e of g.edges){if(String(e.dir||'').includes('不明'))failures.push({id:e.id,code:'unknown_direction',version});if(version===2&&('dir_basis'in e||'dir_basis_to'in e))failures.push({id:e.id,code:'app_basis',version});if(version===0){if(e.dir_basis==='名前の表'){basis++;renamedEdges.add(e.id);}if(e.dir_basis_to==='名前の表'){basisTo++;renamedEdges.add(e.id);}}}
    if(version<2)for(const n of g.nodes.filter(n=>n.type==='sapa')){if(!version)sapaNodes++;for(const [key,es]of [['dir_in',g.edges.filter(e=>e.to===n.id)],['dir_out',g.edges.filter(e=>e.from===n.id)]])if(set(n.osm?.[key]||[])!==set(es.map(e=>e.dir)))failures.push({id:n.id,version,code:'sapa_direction',item:key,expected:[...new Set(es.map(e=>e.dir))],actual:n.osm?.[key]});}
    for(const ic of g.ics){const expected=g.edges.filter(e=>e.ic_id===ic.ic_id&&['on_ramp','off_ramp'].includes(e.kind)).map(e=>e.kind+':'+e.dir);if(JSON.stringify(expected.sort())!==JSON.stringify(ic.movements))failures.push({id:ic.ic_id,version,code:'movements'});}
    for(const road of g.meta.road_list){const expected=[];for(const e of g.edges){const keys=e.road.split('>'),ds=e.dir.split('→');for(let i=0;i<keys.length;i++)if(keys[i]===road.key)expected.push(ds[i]);}if(set(expected)!==set(road.directions))failures.push({id:road.key,version,code:'road_list.directions'});}
  }
  return {failures,rows,table_rows:names.directions.length,table_groups:rows.filter(r=>r.table).length,geometry_groups:rows.filter(r=>r.eligible).length,renamed_edges:renamedEdges.size,dir_basis:basis,dir_basis_to:basisTo,sapa_nodes:sapaNodes};
}
function restrictionText(e,r,routeNames) {
  const suffix='。OSM上は接続しているが、実際に通行できるか・料金の扱いは未確認';
  if(r.kind==='uturn_link'&&!(e.via_excluded?.shared_ways_with_excluded_jct||[]).length)return '同一路線の転回（他の路線のJCT連絡路とは区間を共有しない）'+suffix;
  const match=String(r.note||'').match(/^他の路線（([^（）]+)）のJCT連絡路/),label=match?.[1];
  if(label&&label.split('・').some(n=>!routeNames.includes(n)))return null;
  if(['jl.264008196.5685123294','jl.264008196.940043714','jl.927641089.5685123294','jl.927641089.940043714'].includes(e.id)&&label!=='首都高速中央環状線')return null;
  return '他の路線'+(label?'（'+label+'）':'')+'のJCT連絡路と区間を共有する同一路線の連絡'+(r.kind==='same_road_via_excluded_jct'?'':'（転回）')+suffix;
}
function verifyMetadata({graphs,v,names,namesMeta,ledgerSha,icMatch,unmatched,ledger}) {
  const failures=[],versions=[],kinds=new Set(['uturn_link','same_road_via_excluded_jct','uturn_via_excluded_jct']);
  const routeNames=ledger.routes.flatMap(r=>[r.normalized_name,r.display_name,...(r.aliases||[])]).filter(Boolean);
  const eq=(id,version,actual,expected)=>{if(JSON.stringify(actual)!==JSON.stringify(expected))failures.push({id,version,actual,expected});};
  for(let version=0;version<graphs.length;version++) {
    const g=graphs[version],sapa=new Set(g.nodes.filter(n=>n.type==='sapa').map(n=>n.id)),attached=g.edges.filter(e=>sapa.has(e.from)||sapa.has(e.to)).length,gaps=g.edges.filter(e=>e.geom_gap).length;
    const note=`SA/PA ノードに接する辺（${attached} 本）の geom は、場内通路で到達できる場合、接続点から場内通路（OSM の service・motorway_link。--osm の抽出に含まれるもの）を一方通行の向きにたどった実形状で、SA/PA 側の端点（代表点に近い通路上の頂点）まで続く。端点から代表点までの直線区間は含めない（直線補間はしない）。形状で埋まらない区間がある辺（${gaps} 本）は geom_gap:true（geom_gap_info に区間の長さ[m]と理由）`;
    eq('meta.geom.note',version,g.meta.geom?.note,note);eq('meta.names',version,g.meta.names,namesMeta);
    if(version===2)eq('counts.geom_gap_edges',version,g.meta.counts.geom_gap_edges,gaps);
    let selected=0,other=0;
    for(const e of g.edges)for(const r of [e.restriction,...(e.restriction?.all||[])].filter(Boolean)) {
      if(String(r.note||'').includes('対象外路線'))failures.push({id:e.id,version,item:'restriction.note',code:'excluded_route_word'});
      if(kinds.has(r.kind)){selected++;eq(e.id,version,r.note,restrictionText(version===2?graphs[0].edges.find(x=>x.id===e.id):e,r,routeNames));}else other++;
    }
    versions.push({version,sapa_edges:attached,geom_gap_edges:gaps,selected_notes:selected,other_notes:other});
  }
  if(names.format!=='rf-name-table/1'||names.ledger_sha256!==ledgerSha)failures.push({id:'meta.names',code:'name_table_input',format:names.format,ledger_sha256:names.ledger_sha256});
  eq('meta.ic_match',0,graphs[0].meta.ic_match?.matched_ramps,icMatch.ramps.length);eq('meta.ic_match',0,graphs[0].meta.ic_match?.unmatched_ramps,unmatched.count);
  return {failures,versions};
}
function nameAudits({a,graphs,report,icMatch,unmatched,n06,ledger,names,namesMeta,ledgerSha,params}) {
  const context=nameContext(a.v,graphs[0],ledger,n06,names);
  return {V1:verifyAttribution({graph:graphs[0],icMatch,names,context}),V2:verifyNames({graphs,names,context}),V3:verifyTerminalMerge({graph:graphs[1],v:a.v}),V4:verifyDirections({a,graphs,report,names,params}),V5:verifyMetadata({graphs,v:a.v,names,namesMeta,ledgerSha,icMatch,unmatched,ledger})};
}

module.exports={nameKey,nameCompare,nameBases,normalizeNames,nameContext,verifyAttribution,verifyNames,verifyTerminalMerge,geometryName,verifyDirections,restrictionText,verifyMetadata,nameAudits,prepare,role,dirs,norm,hav,vec,angle,surface,sid,arr,push,pointSegment,correspondence,alongWay,turn,directionAudit,wanganAudit,audit,n06Audit,reachability,exceptionCauses};
