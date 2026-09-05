#!/usr/bin/env python3
"""Subset actual source TIN, cutting source road/plaza footprints from terrain.

The cut avoids drawing/colliding two different source surfaces at road level.
New cut-edge vertices are interpolated on the original TIN triangle plane.
No source heights are smoothed, replaced by zero, or moved to match roads.
"""
from __future__ import annotations
from collections import defaultdict
import gzip
import hashlib
import json
from pathlib import Path

from lxml import etree
import mapbox_earcut
import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.prepared import prep

from convert import ROOT, AOI, GML, local_coordinates


def main():
    out = ROOT / "public/data"
    stage = json.loads((out / "stage.json").read_text())
    cutouts = []
    for chunk in stage["chunks"]:
        if chunk.get("kind") == "terrain":
            continue
        path = ROOT / "public" / chunk["url"]
        payload = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes())
        for obj in payload["objects"]:
            if obj["kind"] not in ("road", "plaza", "walkway") or obj["cityLod"] < 3:
                continue
            vertices = np.asarray(obj["positions"]).reshape(-1, 3)
            for indices in np.asarray(obj["indices"]).reshape(-1, 3):
                tri = vertices[indices]
                normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                if abs(normal[1]) > .7 * np.linalg.norm(normal):
                    p = Polygon(tri[:, [0, 2]])
                    if p.area > 1e-7:
                        cutouts.append(p)
    footprint = unary_union(cutouts)
    prepared = prep(footprint)
    source = ROOT / "data/raw/udx/dem/533606_dem_6697_op.gml"
    groups = defaultdict(lambda: {"positions": [], "indices": [], "surfaces": [], "sourceIds": set()})
    source_triangles = 0
    selected = 0
    trimmed = 0
    relief_ns = "{http://www.opengis.net/citygml/relief/2.0}"
    # Filter by geographic AOI before invoking projection and clipping.
    lat_min, lat_max, lon_min, lon_max = 35.4097, 35.4173, 136.7548, 136.7623
    for _, triangle in etree.iterparse(str(source), events=("end",), tag=GML + "Triangle", huge_tree=True):
        source_triangles += 1
        pos = triangle.find(".//" + GML + "posList")
        points = np.fromstring(pos.text or "", sep=" ").reshape(-1, 3)[:3]
        if (points[:, 0].max() < lat_min or points[:, 0].min() > lat_max
                or points[:, 1].max() < lon_min or points[:, 1].min() > lon_max):
            triangle.clear()
            while triangle.getprevious() is not None:
                del triangle.getparent()[0]
            continue
        local = local_coordinates(points)
        lo, hi = local.min(0), local.max(0)
        if hi[0] < AOI[0] or lo[0] > AOI[2] or hi[2] < AOI[1] or lo[2] > AOI[3]:
            triangle.clear()
            while triangle.getprevious() is not None:
                del triangle.getparent()[0]
            continue
        selected += 1
        source_id = next(a.get(GML + "id") for a in triangle.iterancestors() if a.tag == relief_ns + "TINRelief")
        shape = Polygon(local[:, [0, 2]])
        normal = np.cross(local[1] - local[0], local[2] - local[0])
        if abs(normal[1]) < 1e-7:
            triangle.clear()
            continue
        if prepared.intersects(shape):
            shape = shape.difference(footprint)
            trimmed += 1
        pieces = [shape] if shape.geom_type == "Polygon" else list(shape.geoms) if shape.geom_type == "MultiPolygon" else []
        for piece_index, piece in enumerate(pieces):
            if piece.area < 1e-6:
                continue
            rings = [np.asarray(piece.exterior.coords)[:-1]] + [np.asarray(r.coords)[:-1] for r in piece.interiors]
            flat = np.vstack(rings)
            heights = local[0, 1] - (normal[0] * (flat[:, 0] - local[0, 0]) + normal[2] * (flat[:, 1] - local[0, 2])) / normal[1]
            vertices = np.round(np.column_stack([flat[:, 0], heights, flat[:, 1]]), 3)
            indices = mapbox_earcut.triangulate_float64(flat.copy(), np.cumsum([len(r) for r in rings], dtype=np.uint32)).reshape(-1, 3)
            normals = np.cross(vertices[indices[:, 1]] - vertices[indices[:, 0]], vertices[indices[:, 2]] - vertices[indices[:, 0]])
            reverse = normals[:, 1] < 0
            indices[reverse] = indices[reverse][:, [0, 2, 1]]
            center = vertices.mean(0)
            chunk_id = f"terrain-{int(np.floor(center[0] / 200))}_{int(np.floor(center[2] / 200))}"
            group = groups[chunk_id]
            group["surfaces"].append({"id": f"{source_id}:triangle-{source_triangles}:piece-{piece_index}", "sourceId": f"{source_id}:triangle-{source_triangles}", "sourceIdType": "derived_triangle_ordinal_under_source_gml_id", "start": len(group["indices"]), "count": len(indices.ravel()), "semantic": "TerrainSurface"})
            group["indices"].extend((indices.ravel() + len(group["positions"]) // 3).tolist())
            group["positions"].extend(vertices.ravel().tolist())
            group["sourceIds"].add(source_id)
        triangle.clear()
        while triangle.getprevious() is not None:
            del triangle.getparent()[0]
    stage["chunks"] = [c for c in stage["chunks"] if c.get("kind") != "terrain"]
    for chunk_id, group in sorted(groups.items()):
        p = np.asarray(group["positions"]).reshape(-1, 3)
        bounds = [*p.min(0).tolist(), *p.max(0).tolist()]
        obj = {**group, "id": "plateau:" + chunk_id, "sourceId": sorted(group["sourceIds"])[0], "sourceIds": sorted(group["sourceIds"]), "sourceFile": str(source.relative_to(ROOT / "data/raw")), "chunkId": chunk_id,
               "kind": "terrain", "cityLod": 1, "renderLod": "original_tin_cut_at_source_road_boundary", "bounds": bounds,
               "verification": "source_only", "gameAdded": False, "runtimeEligible": True, "color": "#7f876b", "heightStatus": "source_height_preserved", "name": None, "sourceAttributes": {}}
        data = json.dumps({"id": chunk_id, "objects": [obj]}, ensure_ascii=False, separators=(",", ":"))
        filename = f"chunk-{chunk_id}.json"
        (out / filename).write_text(data)
        stage["chunks"].append({"id": chunk_id, "kind": "terrain", "url": f"data/{filename}", "bounds": bounds, "objectCount": 1, "triangles": len(group["indices"]) // 3, "bytes": len(data.encode()), "sha256": hashlib.sha256(data.encode()).hexdigest()})
    stage["metadata"]["terrain"] = {"status": "source_only", "sourceFile": str(source.relative_to(ROOT / "data/raw")), "sourceTrianglesScanned": source_triangles, "sourceTrianglesInAOI": selected, "sourceTrianglesTouchingCutout": trimmed, "chunks": len(groups), "modifications": "Subset AOI; cut actual LOD3 road/plaza footprint from TIN; interpolate cut edge on each original source triangle plane; no height smoothing"}
    stage["metadata"]["counts"]["terrainChunksLOD1"] = len(groups)
    (out / "stage.json").write_text(json.dumps(stage, ensure_ascii=False, indent=2) + "\n")
    print(f"Terrain: {source_triangles} scanned, {selected} source triangles in AOI, {trimmed} touch road/plaza, {len(groups)} chunks")


if __name__ == "__main__":
    main()
