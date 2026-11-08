'use strict';
// Q8: 入力の way と OSM の両端だけから、有向区間の列を確かめる。
// 構築器と verify_general.js の判定には依存しない。
function directions(w) {
  const t=w.tags||{},o=t.oneway;
  if(['yes','true','1'].includes(o))return[1];if(['-1','reverse'].includes(o))return[-1];
  if(['no','false','0'].includes(o))return[1,-1];return /^(motorway|motorway_link)$/.test(t.highway)?[1]:[1,-1];
}
function distance(a,b) {
  const r=Math.PI/180,x=Math.sin((b.lat-a.lat)*r/2),y=Math.sin((b.lng-a.lng)*r/2);
  return 12742000*Math.asin(Math.min(1,Math.sqrt(x*x+Math.cos(a.lat*r)*Math.cos(b.lat*r)*y*y)));
}
function recover(edge,{ways,coords}) {
  const o=edge.osm||{},nodeId=id=>/^[ns]\.\d+$/.test(id||'')?Number(id.slice(2)):undefined;
  const start=o.start_node??nodeId(edge.from),end=o.end_node??nodeId(edge.to),ids=[...new Set(o.ways||[])],adj=new Map();
  const key=s=>`${s.way}:${s.pos}:${s.sign}`;
  for(const id of ids) {
    const w=ways.get(id);if(!w)return {ok:false,reason:'way_missing',way:id};
    for(let pos=0;pos<w.nodes.length-1;pos++)for(const sign of directions(w)) {
      const from=w.nodes[pos+(sign===-1?1:0)],to=w.nodes[pos+(sign===1?1:0)],a=coords.get(from),b=coords.get(to);
      const s={way:id,pos,sign,from,to,length_m:a&&b?distance(a,b):null};
      if(!adj.has(from))adj.set(from,[]);adj.get(from).push(s);
    }
  }
  const base=edge.length_m-(o.approx_service_m||0);
  function checked(nodes,segments,source) {
    const missing=segments.some(s=>s.length_m===null),len=missing?null:segments.reduce((n,s)=>n+s.length_m,0);
    if(!missing&&Math.abs(len-base)>0.5)return null;
    return {ok:true,source,nodes,segments:segments.map(s=>({...s,id:key(s)})),path_m:len,comparison_base_m:base,length_skipped:missing};
  }
  function sequence(ns) {
    if(!Array.isArray(ns)||ns.length<2||ns[0]!==start||ns.at(-1)!==end)return null;
    const segments=[];
    for(let i=1;i<ns.length;i++) {
      const options=(adj.get(ns[i-1])||[]).filter(s=>s.to===ns[i]);
      // 同じ点の対を複数の way が表す場合も一意とみなさない。
      if(options.length!==1)return null;segments.push(options[0]);
    }
    return checked(ns,segments,'node_sequence');
  }
  const supplied=sequence(o.node_sequence);if(supplied)return supplied;
  if(start===undefined||end===undefined)return{ok:false,reason:'endpoints_missing'};
  const found=[],seen=new Set([start]),stack=[{node:start,edges:adj.get(start)||[],i:0,len:0}],path=[];
  let steps=0,aborted=false;
  while(stack.length&&found.length<2) {
    if(++steps>2000000){aborted=true;break;}
    const f=stack.at(-1);
    if(f.node===end) {
      const r=checked([start,...path.map(s=>s.to)],[...path],'reconstructed');if(r)found.push(r);
      f.i=f.edges.length;
    }
    if(f.i>=f.edges.length){stack.pop();if(path.length){seen.delete(path.at(-1).to);path.pop();}continue;}
    const s=f.edges[f.i++];if(seen.has(s.to))continue;
    const len=f.len===null||s.length_m===null?null:f.len+s.length_m;
    if(len!==null&&len>base+0.5)continue;
    seen.add(s.to);path.push(s);stack.push({node:s.to,edges:adj.get(s.to)||[],i:0,len});
  }
  if(aborted||found.length!==1)return{ok:false,reason:aborted?'search_incomplete':found.length?'ambiguous':'no_path',supplied_sequence_rejected:Array.isArray(o.node_sequence),paths:found.length,steps};
  return{...found[0],supplied_sequence_rejected:Array.isArray(o.node_sequence),steps};
}
module.exports={recover,directions,distance};
