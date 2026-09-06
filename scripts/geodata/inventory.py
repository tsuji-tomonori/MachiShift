#!/usr/bin/env python3
"""Regenerate the source asset ledger; seed survey requests only when absent.

The curated destructibles manifest is a versioned input, never inferred from
bounding boxes. Existing independent survey entries are never overwritten.
"""
import csv
import gzip
import json
import math
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def main():
    out = ROOT / "public/data"
    stage = json.loads((out / "stage.json").read_text())
    objects = []
    for chunk in stage["chunks"]:
        path = ROOT / "public" / chunk["url"]
        objects.extend(json.loads(gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes())["objects"])
    provenance = json.loads((ROOT / "data/provenance.json").read_text())
    sources = {x["name"]: x for x in provenance["members"]}
    destructibles = json.loads((out / "destructibles.json").read_text())["objects"]
    selected = {x["id"] for x in destructibles}
    with (ROOT / "source_materials/asset_manifest_template.csv").open() as template:
        header = next(csv.reader(template))
    with (ROOT / "data/asset-manifest.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=header)
        writer.writeheader()
        for obj in objects:
            member = sources[obj["sourceFile"]]
            writer.writerow({"asset_id": obj["id"], "object_id": obj["sourceId"], "source_id": "S01",
                             "source_url": provenance["archiveUrl"], "original_filename": obj["sourceFile"],
                             "sha256": member["sha256"], "provider": "岐阜市 / Project PLATEAU", "edition": "2024年度",
                             "retrieved_at": member["retrievedAt"], "license_name": "CC BY4.0",
                             "license_url": "https://creativecommons.org/licenses/by/4.0/", "attribution_text": stage["metadata"]["attribution"],
                             "third_party_rights_review": "geometry dataset license confirmed; textures omitted; individual artwork review pending",
                             "horizontal_crs": "EPSG:6668 to EPSG:6675", "vertical_datum": "EPSG:6697 JGD2011 height",
                             "local_origin": json.dumps(stage["metadata"]["origin"]), "coverage_geometry": json.dumps(obj["bounds"]),
                             "city_lod": obj["cityLod"], "render_lod": obj["renderLod"], "accuracy_statement": "Independent measurements not performed",
                             "verification_status": "source_only", "modifications": "subset,coordinate conversion,triangulation; terrain road cut if kind terrain",
                             "game_added": "false", "paintable": "runtime surface dependent", "destructible": str(obj["id"] in selected).lower(),
                             "notes": obj["heightStatus"]})
    plan_path = ROOT / "data/survey-plan.json"
    if not plan_path.exists():
        route = np.asarray(stage["route"])
        evidence = json.loads((out / "route-evidence.json").read_text())["samples"]
        roads = []
        for i in range(10):
            n = int(i * len(route) / 10)
            tangent = route[(n + 1) % len(route)] - route[n]
            roads.append({"id": f"GEO-ROAD-{i + 1:02}", "routeSample": n, "sourceRoadId": evidence[n]["sourceId"],
                          "sourcePointMetres": route[n].tolist(), "photoForwardAzimuthDegrees": round(math.degrees(math.atan2(tangent[0], -tangent[2])) % 360, 1),
                          "requiredViews": ["forward", "backward", "left_cross_section", "right_cross_section", "curb_with_scale"],
                          "independentReference": None, "measurementDate": None, "referenceUncertaintyMetres": None,
                          "measuredRoadEdges": None, "measuredRelativeHeights": None, "horizontalErrorMetres": None,
                          "relativeHeightErrorMetres": None, "status": "BLOCKED", "verification": "source_only"})
        buildings = [o for o in objects if o["kind"] == "building"]
        used = set()
        points = []
        for i in range(20):
            point = route[int(i * len(route) / 20)]
            def distance(obj):
                b = np.asarray(obj["bounds"])
                center = (b[:3] + b[3:]) / 2
                return float(np.linalg.norm(center[[0, 2]] - point[[0, 2]]))
            obj = min((o for o in buildings if o["id"] not in used), key=distance)
            used.add(obj["id"])
            points.append({"id": f"GEO-BLDG-{i + 1:02}", "objectId": obj["id"], "sourceId": obj["sourceId"],
                           "sourceBoundsMetres": obj["bounds"], "photoFromRoutePointMetres": point.tolist(),
                           "requiredViews": ["ground_facade_two_directions", "entrance", "corner_with_dimension_reference"],
                           "independentReference": None, "measurementDate": None, "measuredPoint": None,
                           "errorMetres": None, "referenceUncertaintyMetres": None, "status": "BLOCKED", "verification": "source_only"})
        plan_path.write_text(json.dumps({"status": "BLOCKED", "reason": "No independent survey reference supplied; source values are not measurements", "roadCrossSections": roads, "buildingPoints": points}, ensure_ascii=False, indent=2))
    print(f"Asset ledger: {len(objects)} objects; independent survey plan retained")


if __name__ == "__main__":
    main()
