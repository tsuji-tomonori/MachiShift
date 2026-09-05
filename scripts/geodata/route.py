#!/usr/bin/env python3
"""Select a game racing line inside imported LOD3 road surfaces.

The racing line is a game definition, not an asserted real road centreline.
Every sample gets its height from a containing source triangle. A missing
surface is a hard error; the script never invents road geometry to complete it.
"""
from __future__ import annotations
import json
import gzip
from pathlib import Path
import numpy as np
from shapely.geometry import Point, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[2]
# Control points selected from the source LOD3 road footprint, x east / z south.
CONTROLS = [[-190, -2], [-238, -10], [-249, -35], [-246, -200], [-239, -460],
            [-233, -483], [-206, -482], [12, -486], [32, -473], [28, -444],
            [10, -192], [9, -175], [-11, -135], [-73, -9], [-100, 10], [-130, 7]]


def build_route() -> None:
    out = ROOT / "public/data"
    stage = json.loads((out / "stage.json").read_text())
    triangles, polys, ids = [], [], []
    for chunk in stage["chunks"]:
        path = ROOT / "public" / chunk["url"]
        payload = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes())
        for obj in payload["objects"]:
            if obj["kind"] != "road" or obj["cityLod"] != 3:
                continue
            verts = np.asarray(obj["positions"]).reshape(-1, 3)
            for tri_indices in np.asarray(obj["indices"]).reshape(-1, 3):
                tri = verts[tri_indices]
                n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                if abs(n[1]) < .7 * np.linalg.norm(n) or min(tri[:, 1]) < 5:
                    continue
                poly = Polygon(tri[:, [0, 2]])
                if poly.area < 1e-7:
                    continue
                triangles.append(tri); polys.append(poly); ids.append(obj["sourceId"])
    tree = STRtree(polys)
    footprint = unary_union(polys)
    controls = np.asarray(CONTROLS, dtype=float)
    # Two Chaikin corner-cutting passes form a smooth closed line without
    # introducing a Catmull-Rom overshoot beyond the selected road corridor.
    for _ in range(2):
        successor = np.roll(controls, -1, axis=0)
        controls = np.stack([.75 * controls + .25 * successor, .25 * controls + .75 * successor], axis=1).reshape(-1, 2)
    samples = []
    for a, b in zip(controls, np.roll(controls, -1, axis=0)):
        count = max(1, int(np.ceil(np.linalg.norm(b - a) / 4)))
        samples.extend(a + (b - a) * (i / count) for i in range(count))
    route, evidence, missing = [], [], []
    for i, point in enumerate(samples):
        query = Point(point)
        candidates = [int(j) for j in tree.query(query) if polys[int(j)].buffer(1e-5).covers(query)]
        if not candidates:
            missing.append({"sample": i, "xz": point.tolist(), "distanceToSourceRoad": query.distance(footprint)})
            continue
        hits = []
        for index in candidates:
            tri = triangles[index]
            n = np.cross(tri[1] - tri[0], tri[2] - tri[0])
            y = tri[0, 1] - (n[0] * (point[0] - tri[0, 0]) + n[2] * (point[1] - tri[0, 2])) / n[1]
            hits.append((float(y), index))
        y, index = min(hits)
        clearance = query.distance(footprint.boundary)
        route.append([round(float(point[0]), 3), round(y, 3), round(float(point[1]), 3)])
        evidence.append({"sample": i, "sourceId": ids[index], "triangleIndex": index, "clearanceMetres": round(clearance, 3), "height": round(y, 3)})
    if missing:
        (ROOT / "data/route-missing.json").write_text(json.dumps(missing, indent=2))
        raise ValueError(f"{len(missing)} racing-line samples have no actual source road; see data/route-missing.json")
    route_array = np.asarray(route)
    length = float(np.linalg.norm(np.roll(route_array, -1, axis=0) - route_array, axis=1).sum())
    minimum_clearance = min(e["clearanceMetres"] for e in evidence)
    (ROOT / "data/route-candidate.json").write_text(json.dumps({"route": route, "evidence": evidence, "length": length}, indent=2))
    if minimum_clearance < 2:
        raise ValueError(f"Road boundary clearance insufficient: {minimum_clearance}")
    stage["route"] = route
    stage["routeStatus"] = "game_racing_line_on_source_lod3_roads_not_survey_verified"
    stage["routeLengthMetres"] = round(length, 3)
    stage["routeMinimumSourceBoundaryClearanceMetres"] = minimum_clearance
    stage["routeWidthMetres"] = round(minimum_clearance * 2, 3)
    stage["routeClearanceMetres"] = [e["clearanceMetres"] for e in evidence]
    stage["routeEvidenceUrl"] = "data/route-evidence.json"
    (out / "stage.json").write_text(json.dumps(stage, ensure_ascii=False, indent=2) + "\n")
    (out / "route-evidence.json").write_text(json.dumps({"method": "Every 4 m or less; barycentric plane height on containing original LOD3 road triangle; source-union boundary clearance", "controlsXZ": CONTROLS, "samples": evidence}, indent=2))
    print(f"Route {length:.3f} m, {len(route)} samples; minimum source boundary clearance {minimum_clearance:.3f} m")


if __name__ == "__main__":
    build_route()
