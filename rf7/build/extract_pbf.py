#!/usr/bin/env python3
"""
extract_pbf.py — Geofabrik の地域 PBF から、グラフ構築に必要な OSM 要素だけを取り出す（段階5b-0、2026-11-05 Opus）。
出力は Overpass の JSON に近い形（raw/osm_small.json と同じ要素の形）で、build_graph.js の入力に使う。

取り出すもの（osm_query.overpassql・osm_query_sapa.overpassql と同じ考え方を PBF に当てはめたもの）
  1. 高速系の way（geometry 付き）：highway=motorway|motorway_link、または highway=trunk|trunk_link で motorroad=yes か toll=yes
  2. 1 のノードに接する highway の way（geometry 付き。Overpass 版は nodes だけだったが、一般道側端点の判定と SA/PA に使えるよう座標も持つ）
  3. 1 から highway=service をたどって 3 段までの way（geometry 付き。SA/PA の場内通路）
  4. 1 のノードのうち highway=motorway_junction と barrier=toll_booth（tags 付き）
  5. 1 の way を members に持つ type=restriction の relation
使い方：python3 extract_pbf.py <in.osm.pbf> <out.json>
"""
import sys, json, time, hashlib
import osmium

HW = {'motorway', 'motorway_link'}
TR = {'trunk', 'trunk_link'}
SERVICE_HOPS = 3


def is_hw(tags):
    h = tags.get('highway')
    if h in HW:
        return True
    if h in TR and (tags.get('motorroad') == 'yes' or tags.get('toll') == 'yes'):
        return True
    return False


class PassHW(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.ways = {}; self.nodes = set()

    def way(self, w):
        t = w.tags
        if is_hw(t):
            refs = [n.ref for n in w.nodes]
            self.ways[w.id] = {'nodes': refs, 'tags': {k.k: k.v for k in t}}
            self.nodes.update(refs)


class PassTouch(osmium.SimpleHandler):
    """接する way（全 highway）と、service の連鎖の 1 段"""
    def __init__(self, hwids, front, want_any):
        super().__init__(); self.hwids = hwids; self.front = front; self.want_any = want_any; self.ways = {}

    def way(self, w):
        if w.id in self.hwids:
            return
        h = w.tags.get('highway')
        if not h:
            return
        if not self.want_any and h != 'service':
            return
        refs = [n.ref for n in w.nodes]
        if any(r in self.front for r in refs):
            self.ways[w.id] = {'nodes': refs, 'tags': {k.k: k.v for k in w.tags}}


class PassNodes(osmium.SimpleHandler):
    def __init__(self, need, hwnodes):
        super().__init__(); self.need = need; self.hwnodes = hwnodes; self.loc = {}; self.tagged = {}

    def node(self, n):
        if n.id in self.need:
            self.loc[n.id] = (n.location.lat, n.location.lon)
            if n.id in self.hwnodes:
                t = n.tags
                if t.get('highway') == 'motorway_junction' or t.get('barrier') == 'toll_booth':
                    self.tagged[n.id] = {k.k: k.v for k in t}


class PassRel(osmium.SimpleHandler):
    def __init__(self, hwids):
        super().__init__(); self.hwids = hwids; self.rels = []

    def relation(self, r):
        if r.tags.get('type') != 'restriction':
            return
        mem = [{'type': {'n': 'node', 'w': 'way', 'r': 'relation'}[m.type], 'ref': m.ref, 'role': m.role} for m in r.members]
        if any(m['type'] == 'way' and m['ref'] in self.hwids for m in mem):
            self.rels.append({'type': 'relation', 'id': r.id, 'members': mem, 'tags': {k.k: k.v for k in r.tags}})


def main():
    src, out = sys.argv[1], sys.argv[2]
    t0 = time.time()
    h = hashlib.sha256()
    with open(src, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    hdr = osmium.io.Reader(src, osmium.osm.osm_entity_bits.NOTHING).header()
    base = hdr.get('osmosis_replication_timestamp') or ''
    p1 = PassHW(); p1.apply_file(src)
    hwids = set(p1.ways)
    p2 = PassTouch(hwids, p1.nodes, True); p2.apply_file(src)
    touch = p2.ways
    # service の連鎖（SA/PA の場内通路）：接する way のうち service から始めて SERVICE_HOPS 段
    svc = {k: v for k, v in touch.items() if v['tags'].get('highway') == 'service'}
    seen = set(hwids) | set(touch)
    front = set(n for v in svc.values() for n in v['nodes'])
    extra = {}
    for _ in range(SERVICE_HOPS - 1):
        if not front:
            break
        p = PassTouch(seen, front, False); p.apply_file(src)
        new = {k: v for k, v in p.ways.items() if k not in seen}
        extra.update(new); seen |= set(new)
        front = set(n for v in new.values() for n in v['nodes'])
    need = set(p1.nodes)
    for d in (touch, extra):
        for v in d.values():
            need.update(v['nodes'])
    p3 = PassNodes(need, p1.nodes); p3.apply_file(src)
    p4 = PassRel(hwids); p4.apply_file(src)

    def way_el(i, v, role):
        g = [p3.loc.get(r) for r in v['nodes']]
        el = {'type': 'way', 'id': i, 'nodes': v['nodes'], 'tags': v['tags'], 'rf_role': role}
        if all(x is not None for x in g):
            el['geometry'] = [{'lat': round(a, 7), 'lon': round(b, 7)} for a, b in g]
        else:
            el['rf_missing_nodes'] = sum(1 for x in g if x is None)
        return el

    els = [way_el(i, v, 'hw') for i, v in sorted(p1.ways.items())]
    els += [way_el(i, v, 'touch') for i, v in sorted(touch.items())]
    els += [way_el(i, v, 'service') for i, v in sorted(extra.items())]
    els += [{'type': 'node', 'id': i, 'lat': round(p3.loc[i][0], 7), 'lon': round(p3.loc[i][1], 7), 'tags': t} for i, t in sorted(p3.tagged.items())]
    els += sorted(p4.rels, key=lambda r: r['id'])
    doc = {'version': 0.6, 'generator': 'rf-graph extract_pbf.py (pyosmium ' + __import__('osmium.version').version.pyosmium_release + ')',
           'osm3s': {'timestamp_osm_base': base, 'copyright': 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.'},
           'rf_source': {'file': src.split('/')[-1], 'sha256': h.hexdigest(), 'bytes': __import__('os').path.getsize(src)},
           'rf_counts': {'hw_ways': len(p1.ways), 'touch_ways': len(touch), 'service_ways': len(extra), 'tagged_nodes': len(p3.tagged), 'relations': len(p4.rels),
                         'missing_geometry_ways': sum(1 for e in els if e.get('rf_missing_nodes'))},
           'elements': els}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print(json.dumps({'out': out, 'sec': round(time.time() - t0, 1), **doc['rf_counts'], 'base': base, 'sha256': h.hexdigest()[:16]}, ensure_ascii=False))


if __name__ == '__main__':
    main()
