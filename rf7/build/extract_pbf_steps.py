#!/usr/bin/env python3
"""
extract_pbf_steps.py — extract_pbf.py と同じ抽出を、1 回の実行を短く区切って行う版（実行時間に上限がある環境用。2026-11-05 Opus）。
状態を pickle に保存し、呼ぶたびに次の段を 1 つずつ進める。段：hash → hw → touch（接する way と restriction）→ svc1 → svc2 → nodes → write。
出力は extract_pbf.py と同じ形式（同じ入力なら同じ要素・同じ順序）。
使い方：python3 extract_pbf_steps.py <in.osm.pbf> <out.json> <state.pkl>   （"DONE" が出るまで繰り返す）
"""
import sys, os, json, time, hashlib, pickle
import osmium
from extract_pbf import is_hw, PassHW, PassTouch, PassNodes, PassRel, SERVICE_HOPS

STEPS = ['hash', 'hw', 'touch', 'svc1', 'svc2', 'nodes', 'write']


def ways_hw(src):
    fp = osmium.FileProcessor(src, osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('highway'))
    p = PassHW()
    for w in fp:
        p.way(w)
    return p


def ways_touch(src, hwids, front, want_any):
    fp = osmium.FileProcessor(src, osmium.osm.WAY).with_filter(osmium.filter.KeyFilter('highway'))
    p = PassTouch(hwids, front, want_any)
    for w in fp:
        p.way(w)
    return p


def rels(src, hwids):
    fp = osmium.FileProcessor(src, osmium.osm.RELATION).with_filter(osmium.filter.TagFilter(('type', 'restriction')))
    p = PassRel(hwids)
    for r in fp:
        p.relation(r)
    return p


def nodes(src, need, hwnodes):
    p = PassNodes(need, hwnodes)
    for n in osmium.FileProcessor(src, osmium.osm.NODE).with_filter(osmium.filter.IdFilter(need)):
        p.node(n)
    return p


def main():
    src, out, stp = sys.argv[1], sys.argv[2], sys.argv[3]
    st = pickle.load(open(stp, 'rb')) if os.path.exists(stp) else {'done': [], 'sec': {}}
    nxt = next((s for s in STEPS if s not in st['done']), None)
    if nxt is None:
        print('DONE'); return
    t0 = time.time()
    if nxt == 'hash':
        h = hashlib.sha256()
        with open(src, 'rb') as f:
            for b in iter(lambda: f.read(1 << 20), b''):
                h.update(b)
        st['sha256'] = h.hexdigest(); st['bytes'] = os.path.getsize(src)
        st['base'] = osmium.io.Reader(src, osmium.osm.osm_entity_bits.NOTHING).header().get('osmosis_replication_timestamp') or ''
    elif nxt == 'hw':
        p = ways_hw(src); st['hw'] = p.ways; st['hwnodes'] = p.nodes
    elif nxt == 'touch':
        pt = ways_touch(src, set(st['hw']), st['hwnodes'], True); pr = rels(src, set(st['hw']))
        st['touch'] = pt.ways; st['rels'] = pr.rels
        svc = {k: v for k, v in pt.ways.items() if v['tags'].get('highway') == 'service'}
        st['seen'] = set(st['hw']) | set(pt.ways); st['front'] = set(n for v in svc.values() for n in v['nodes']); st['extra'] = {}
    elif nxt in ('svc1', 'svc2'):
        if st['front'] and int(nxt[-1]) <= SERVICE_HOPS - 1:
            p = ways_touch(src, st['seen'], st['front'], False)
            new = {k: v for k, v in p.ways.items() if k not in st['seen']}
            st['extra'].update(new); st['seen'] |= set(new)
            st['front'] = set(n for v in new.values() for n in v['nodes'])
    elif nxt == 'nodes':
        need = set(st['hwnodes'])
        for d in (st['touch'], st['extra']):
            for v in d.values():
                need.update(v['nodes'])
        p = nodes(src, need, st['hwnodes']); st['loc'] = p.loc; st['tagged'] = p.tagged
    elif nxt == 'write':
        loc = st['loc']

        def way_el(i, v, role):
            g = [loc.get(r) for r in v['nodes']]
            el = {'type': 'way', 'id': i, 'nodes': v['nodes'], 'tags': v['tags'], 'rf_role': role}
            if all(x is not None for x in g):
                el['geometry'] = [{'lat': round(a, 7), 'lon': round(b, 7)} for a, b in g]
            else:
                el['rf_missing_nodes'] = sum(1 for x in g if x is None)
            return el
        els = [way_el(i, v, 'hw') for i, v in sorted(st['hw'].items())]
        els += [way_el(i, v, 'touch') for i, v in sorted(st['touch'].items())]
        els += [way_el(i, v, 'service') for i, v in sorted(st['extra'].items())]
        els += [{'type': 'node', 'id': i, 'lat': round(loc[i][0], 7), 'lon': round(loc[i][1], 7), 'tags': t} for i, t in sorted(st['tagged'].items())]
        els += sorted(st['rels'], key=lambda r: r['id'])
        doc = {'version': 0.6, 'generator': 'rf-graph extract_pbf.py (pyosmium ' + __import__('osmium.version').version.pyosmium_release + ')',
               'osm3s': {'timestamp_osm_base': st['base'], 'copyright': 'The data included in this document is from www.openstreetmap.org. The data is made available under ODbL.'},
               'rf_source': {'file': src.split('/')[-1], 'sha256': st['sha256'], 'bytes': st['bytes']},
               'rf_counts': {'hw_ways': len(st['hw']), 'touch_ways': len(st['touch']), 'service_ways': len(st['extra']), 'tagged_nodes': len(st['tagged']), 'relations': len(st['rels']),
                             'missing_geometry_ways': sum(1 for e in els if e.get('rf_missing_nodes'))},
               'elements': els}
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
        print(json.dumps({'out': out, **doc['rf_counts'], 'base': st['base'], 'sha256': st['sha256'][:16]}, ensure_ascii=False))
    st['done'].append(nxt); st['sec'][nxt] = round(time.time() - t0, 1)
    pickle.dump(st, open(stp, 'wb'))
    print('step', nxt, st['sec'][nxt], 's', 'DONE' if nxt == 'write' else 'next=' + STEPS[STEPS.index(nxt) + 1])


if __name__ == '__main__':
    main()
