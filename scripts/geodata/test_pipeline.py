"""Checks conversion/delivery fidelity; these tests are not independent surveys."""
import gzip
import hashlib
import json
from pathlib import Path
import unittest

from lxml import etree
import numpy as np
from pyproj import Geod, Transformer
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

from convert import ROOT, ORIGIN, ORIGIN_X, ORIGIN_N, local_coordinates, triangulate_polygon


class CoordinateTests(unittest.TestCase):
    def test_orthometric_height_origin_and_metre_scale(self):
        local = local_coordinates(np.asarray([[ORIGIN[0], ORIGIN[1], 12.345]]))[0]
        np.testing.assert_allclose(local, [0, 12.345, 0], atol=1e-8)
        inverse = Transformer.from_crs(6675, 6668, always_xy=True)
        lon, lat = inverse.transform(ORIGIN_X + 100, ORIGIN_N)
        result = local_coordinates(np.asarray([[lat, lon, 14]]))[0]
        np.testing.assert_allclose(result, [100, 14, 0], atol=1e-6)
        geodesic = Geod(ellps="GRS80").inv(ORIGIN[1], ORIGIN[0], lon, lat)[2]
        self.assertLess(abs(geodesic - 100), .02)

    def test_hole_and_vertical_surface_preserve_area(self):
        inverse = Transformer.from_crs(6675, 6668, always_xy=True)
        outer = [[-100, 10, -100], [-94, 10, -100], [-94, 16, -100], [-100, 16, -100]]
        hole = [[-98, 12, -100], [-96, 12, -100], [-96, 14, -100], [-98, 14, -100]]
        def ring(points):
            entries = []
            for x, y, z in points + [points[0]]:
                lon, lat = inverse.transform(ORIGIN_X + x, ORIGIN_N - z)
                entries.extend([lat, lon, y])
            return " ".join(map(str, entries))
        xml = f'<gml:Polygon xmlns:gml="http://www.opengis.net/gml"><gml:exterior><gml:LinearRing><gml:posList>{ring(outer)}</gml:posList></gml:LinearRing></gml:exterior><gml:interior><gml:LinearRing><gml:posList>{ring(hole)}</gml:posList></gml:LinearRing></gml:interior></gml:Polygon>'
        points, indices = triangulate_polygon(etree.fromstring(xml.encode()))
        triangles = points[indices.reshape(-1, 3)]
        area = np.linalg.norm(np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0]), axis=1).sum() / 2
        self.assertAlmostEqual(area, 32, places=5)
        np.testing.assert_allclose(points[:, 2], -100)


class DeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.stage = json.loads((ROOT / "public/data/stage.json").read_text())
        cls.objects = []
        for chunk in cls.stage["chunks"]:
            path = ROOT / "public" / chunk["url"]
            compressed = path.read_bytes()
            raw = gzip.decompress(compressed)
            assert hashlib.sha256(compressed).hexdigest() == chunk["sha256"]
            assert hashlib.sha256(raw).hexdigest() == chunk["uncompressedSha256"]
            cls.objects.extend(json.loads(raw)["objects"])

    def test_all_source_objects_and_surfaces_are_addressable(self):
        object_ids = set()
        for obj in self.objects:
            self.assertNotIn(obj["id"], object_ids)
            object_ids.add(obj["id"])
            vertices = np.asarray(obj["positions"]).reshape(-1, 3)
            indices = np.asarray(obj["indices"])
            self.assertTrue(np.isfinite(vertices).all())
            self.assertEqual(len(indices) % 3, 0)
            self.assertLess(int(indices.max()), len(vertices))
            self.assertGreaterEqual(int(indices.min()), 0)
            self.assertEqual(obj["verification"], "source_only")
            self.assertFalse(obj["gameAdded"])
            cursor = 0
            for surface in obj["surfaces"]:
                self.assertEqual(surface["start"], cursor)
                self.assertTrue(surface["sourceId"])
                cursor += surface["count"]
            self.assertEqual(cursor, len(indices))
            if obj["heightStatus"] == "source_placeholder_zero":
                self.assertFalse(obj["runtimeEligible"])

    def test_selected_destruction_faces_exist_in_actual_meshes(self):
        objects = {o["id"]: o for o in self.objects}
        selection = json.loads((ROOT / "public/data/destructibles.json").read_text())["objects"]
        for item in selection:
            obj = objects[item["id"]]
            if item["kind"] == "building":
                self.assertTrue(set(item["surfaceIds"]).issubset({s["id"] for s in obj["surfaces"]}))
                for s in obj["surfaces"]:
                    if s["id"] in item["surfaceIds"]:
                        self.assertEqual(s["semantic"], "WallSurface")
            else:
                self.assertEqual(obj["sourceAttributes"]["function"], item["sourceFunction"])

    def test_terrain_does_not_replace_or_overlap_racing_line_surface(self):
        road_polygons, terrain_polygons = [], []
        road_triangles = []
        for obj in self.objects:
            if obj["kind"] not in ("road", "terrain") or not obj.get("runtimeEligible", True):
                continue
            vertices = np.asarray(obj["positions"]).reshape(-1, 3)
            for indices in np.asarray(obj["indices"]).reshape(-1, 3):
                tri = vertices[indices]
                polygon = Polygon(tri[:, [0, 2]])
                if polygon.area < 1e-7:
                    continue
                if obj["kind"] == "road":
                    road_polygons.append(polygon); road_triangles.append(tri)
                else:
                    terrain_polygons.append(polygon)
        road_tree, terrain_tree = STRtree(road_polygons), STRtree(terrain_polygons)
        self.assertTrue(terrain_polygons, "Actual terrain must be present")
        for x, y, z in self.stage["route"]:
            p = Point(x, z)
            hits = [int(i) for i in road_tree.query(p) if road_polygons[int(i)].buffer(.002).covers(p)]
            self.assertTrue(hits)
            supported = False
            for i in hits:
                tri = road_triangles[i]
                normal = np.cross(tri[1] - tri[0], tri[2] - tri[0])
                if abs(normal[1]) < 1e-6:
                    continue
                plane_error = abs(float(np.dot(normal, np.asarray([x, y, z]) - tri[0]))) / np.linalg.norm(normal)
                supported = supported or plane_error < .002
            self.assertTrue(supported)
            self.assertFalse(any(terrain_polygons[int(i)].covers(p) for i in terrain_tree.query(p)))


if __name__ == "__main__":
    unittest.main()
