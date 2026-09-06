#!/usr/bin/env python3
"""Convert downloaded PLATEAU CityGML polygons to meter-space browser chunks.

Coordinates retain source height; zero-height LOD1/2 road surfaces are excluded
where a higher LOD exists and explicitly marked if otherwise included. No boxes,
invented textures or inferred building dimensions are generated.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re

from lxml import etree
import mapbox_earcut
import numpy as np
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = [35.4107, 136.7595, 0.0]
# AOI covers station and its west/north streets, approx. 0.45 km².
AOI = [-410, -710, 230, 100]  # min x, min z, max x, max z
GML = "{http://www.opengis.net/gml}"
CORE = "{http://www.opengis.net/citygml/2.0}"
XLINK = "{http://www.w3.org/1999/xlink}"
TRANSFORM = Transformer.from_crs(6668, 6675, always_xy=True)
ORIGIN_X, ORIGIN_N = TRANSFORM.transform(ORIGIN[1], ORIGIN[0])
KIND = {"bldg": "building", "tran": "road", "squr": "plaza", "brid": "bridge", "frn": "furniture", "trk": "walkway", "dem": "terrain"}
COLORS = {"building": "#b8b9b5", "road": "#424b50", "plaza": "#b8b0a2", "bridge": "#ced5d5", "furniture": "#7d8b8b", "walkway": "#b5b3a9", "terrain": "#737767"}


def local_coordinates(values: np.ndarray) -> np.ndarray:
    if len(values) == 1:
        east, north = TRANSFORM.transform(float(values[0, 1]), float(values[0, 0]))
        return np.asarray([[east - ORIGIN_X, values[0, 2] - ORIGIN[2], ORIGIN_N - north]])
    east, north = TRANSFORM.transform(values[:, 1], values[:, 0])
    return np.column_stack([east - ORIGIN_X, values[:, 2] - ORIGIN[2], ORIGIN_N - north])


def localname(element) -> str:
    return etree.QName(element).localname


def ring_coordinates(ring) -> np.ndarray:
    pos = ring.find(".//" + GML + "posList")
    if pos is not None:
        points = np.fromstring(pos.text or "", sep=" ").reshape(-1, 3)
    else:
        points = np.asarray([np.fromstring(p.text or "", sep=" ") for p in ring.iter(GML + "pos")])
    if len(points) < 3:
        return np.empty((0, 3))
    if np.allclose(points[0], points[-1], atol=1e-12, rtol=0):
        points = points[:-1]
    return local_coordinates(points)


def triangulate_polygon(poly) -> tuple[np.ndarray, np.ndarray] | None:
    outer = poly.find(GML + "exterior")
    if outer is None:
        return None
    rings = [ring_coordinates(outer)] + [ring_coordinates(x) for x in poly.findall(GML + "interior")]
    if len(rings[0]) < 3:
        return None
    rings = [r for r in rings if len(r) >= 3]
    points = np.vstack(rings)
    lo, hi = points.min(0), points.max(0)
    if hi[0] < AOI[0] or lo[0] > AOI[2] or hi[2] < AOI[1] or lo[2] > AOI[3]:
        return None
    # Newell normal supports vertical walls as well as sloping road/roof polygons.
    normal = np.sum(np.cross(rings[0], np.roll(rings[0], -1, axis=0)), axis=0)
    if np.linalg.norm(normal) < 1e-8:
        return None
    axes = [i for i in range(3) if i != int(np.argmax(np.abs(normal)))]
    indices = mapbox_earcut.triangulate_float64(points[:, axes].copy(), np.cumsum([len(r) for r in rings], dtype=np.uint32)).reshape(-1, 3)
    if not len(indices):
        return None
    tri_normal = np.cross(points[indices[:, 1]] - points[indices[:, 0]], points[indices[:, 2]] - points[indices[:, 0]])
    reverse = tri_normal @ normal < 0
    indices[reverse] = indices[reverse][:, [0, 2, 1]]
    # Drop only degenerate triangles; do not simplify or move source surfaces.
    valid = np.linalg.norm(tri_normal, axis=1) > 1e-8
    return np.round(points, 3), indices[valid].ravel()


def object_polygons(obj) -> tuple[int, list]:
    lod_containers = [(int(m.group(1)), e) for e in obj.iter()
                      if (m := re.match(r"lod([1-4])(?:Solid|MultiSurface|Geometry)$", localname(e)))]
    if not lod_containers:
        return 0, []
    lod = max(v for v, _ in lod_containers)
    by_id = {e.get(GML + "id"): e for e in obj.iter() if e.get(GML + "id")}
    polygons = {}
    for n, container in lod_containers:
        if n != lod:
            continue
        candidates = list(container.iter(GML + "Polygon"))
        for ref in container.iter():
            href = ref.get(XLINK + "href", "")
            if href.startswith("#") and href[1:] in by_id:
                candidates.extend(by_id[href[1:]].iter(GML + "Polygon"))
        for polygon in candidates:
            key = polygon.get(GML + "id") or hashlib.sha256(etree.tostring(polygon)).hexdigest()
            polygons[key] = polygon
    return lod, list(polygons.values())


def convert_object(obj, kind: str, filename: str, counters: Counter) -> dict | None:
    source_id = obj.get(GML + "id")
    if not source_id:
        counters["objectsMissingId"] += 1
        return None
    lod, polygons = object_polygons(obj)
    positions, indices, surfaces = [], [], []
    for polygon in polygons:
        result = triangulate_polygon(polygon)
        if result is None:
            continue
        points, tri = result
        if not len(tri):
            continue
        surface_source_id = polygon.get(GML + "id") or "derived-" + hashlib.sha256(points.tobytes()).hexdigest()[:20]
        semantic = next((localname(parent) for parent in polygon.iterancestors()
                         if localname(parent) in {"WallSurface", "RoofSurface", "GroundSurface", "ClosureSurface", "OuterCeilingSurface", "OuterFloorSurface", "TrafficArea", "AuxiliaryTrafficArea"}), "UnknownSurface")
        surfaces.append({"id": f"{source_id}:{surface_source_id}", "sourceId": surface_source_id,
                         "start": len(indices), "count": len(tri), "semantic": semantic})
        indices.extend((tri + len(positions) // 3).tolist())
        positions.extend(points.ravel().tolist())
    if not indices:
        return None
    p = np.asarray(positions).reshape(-1, 3)
    lo, hi = p.min(0), p.max(0)
    center = (lo + hi) / 2
    chunk_id = f"{int(np.floor(center[0] / 200))}_{int(np.floor(center[2] / 200))}"
    name = obj.findtext(GML + "name")
    classes = {localname(e): (e.text or "") for e in obj if localname(e) in ("class", "function", "usage")}
    counters[f"{kind}LOD{lod}"] += 1
    return {"id": f"plateau:{source_id}", "sourceId": source_id, "sourceFile": filename,
            "chunkId": chunk_id, "kind": kind, "cityLod": lod, "renderLod": "original_triangulated",
            "positions": positions, "indices": indices, "surfaces": surfaces,
            "bounds": [*lo.tolist(), *hi.tolist()], "name": name, "sourceAttributes": classes,
            "verification": "source_only", "gameAdded": False, "color": COLORS[kind],
            "runtimeEligible": not (kind == "road" and np.all(p[:, 1] == 0)),
            "heightStatus": "source_placeholder_zero" if kind == "road" and np.all(p[:, 1] == 0) else "source_height_preserved"}


def main() -> None:
    out = ROOT / "public/data"
    out.mkdir(parents=True, exist_ok=True)
    counters = Counter()
    chunks = defaultdict(list)
    network = []
    for kind_code in ("tran", "squr", "bldg", "brid", "frn", "trk"):
        for path in sorted((ROOT / "data/raw/udx" / kind_code).glob("*.gml")):
            print("Converting", path.name, flush=True)
            for _, member in etree.iterparse(str(path), events=("end",), tag=CORE + "cityObjectMember", huge_tree=True):
                if not len(member):
                    continue
                obj = member[0]
                if kind_code == "tran":
                    for line in obj.iter(GML + "LineString"):
                        pos = line.find(GML + "posList")
                        if pos is not None:
                            points = local_coordinates(np.fromstring(pos.text or "", sep=" ").reshape(-1, 3))
                            if len(points) and np.all(points[:, 0] >= AOI[0]) and np.all(points[:, 0] <= AOI[2]) and np.all(points[:, 2] >= AOI[1]) and np.all(points[:, 2] <= AOI[3]):
                                attrs = {e.get("name"): e.findtext("{http://www.opengis.net/citygml/generics/2.0}value") for e in obj if e.get("name")}
                                network.append({"sourceId": obj.get(GML + "id"), "points": np.round(points, 3).tolist(), "attributes": attrs, "heightStatus": "source_placeholder_zero"})
                result = convert_object(obj, KIND[kind_code], str(path.relative_to(ROOT / "data/raw")), counters)
                if result:
                    chunks[result["chunkId"]].append(result)
                member.clear()
                while member.getprevious() is not None:
                    del member.getparent()[0]
    descriptors = []
    for chunk_id, objects in sorted(chunks.items()):
        payload = {"id": chunk_id, "objects": objects}
        filename = f"chunk-{chunk_id}.json"
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        (out / filename).write_text(data)
        bounds = np.asarray([o["bounds"] for o in objects])
        descriptors.append({"id": chunk_id, "url": f"data/{filename}", "bounds": [*bounds[:, :3].min(0).tolist(), *bounds[:, 3:].max(0).tolist()],
                            "objectCount": len(objects), "triangles": sum(len(o["indices"]) // 3 for o in objects),
                            "sha256": hashlib.sha256(data.encode()).hexdigest(), "bytes": len(data.encode())})
    (out / "road-network.json").write_text(json.dumps(network, ensure_ascii=False, separators=(",", ":")))
    metadata = {"name": "岐阜駅北口・信長ゆめ広場", "source": "PLATEAU 岐阜市 2024年度 CityGML v4",
                "sourceUrl": "https://www.geospatial.jp/ckan/dataset/plateau-21201-gifu-shi-2024",
                "status": "source_only", "edition": "2024年度", "origin": ORIGIN,
                "coordinateSystem": "EPSG:6697 source lat/lon/orthometric-height; horizontal EPSG:6675 (JGD2011 Japan Plane Rectangular CS VII); local +X east, +Y source height, -Z north",
                "verticalDatum": "JGD2011 (vertical) height, retained from EPSG:6697; not ellipsoidal height",
                "unit": "metre", "aoiLocalXZ": AOI, "license": "CC BY 4.0 (PLATEAU policy compatible with PDL 1.0)",
                "licenseUrl": "https://www.mlit.go.jp/plateau/site-policy/", "attribution": "岐阜市 3D都市モデル（Project PLATEAU）を加工して作成。地物の切り出し・座標変換・三角形分割：MachiShift。自治体の公式ゲームではありません。",
                "surveyDate": None, "surveyDateNote": "Source resource CSV mixes years and sources by attribute; no single survey date asserted",
                "textures": "not_included_pending_surface_rights_review", "accuracy": "Independent survey not performed; no centimetre-accuracy claim",
                "processing": "AOI polygon selection; highest available LOD per object; Earcut triangulation incl. holes; position rounded to 1 mm (storage precision, not accuracy)",
                "counts": dict(counters)}
    stage = {"version": 1, "metadata": metadata, "chunks": descriptors, "route": [], "routeStatus": "pending_source_surface_route_selection"}
    (out / "stage.json").write_text(json.dumps(stage, ensure_ascii=False, indent=2) + "\n")
    print("Wrote", len(descriptors), "chunks", dict(counters), flush=True)


if __name__ == "__main__":
    main()
