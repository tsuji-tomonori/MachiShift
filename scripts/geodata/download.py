#!/usr/bin/env python3
"""Retrieve unmodified PLATEAU ZIP members by HTTP ranges; never extract all 4.3 GB.

Only the standard library and curl are required. CRC32 is checked against the ZIP
directory and each uncompressed member receives a SHA-256 provenance record.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct
import subprocess
import tempfile
from datetime import datetime, timezone
import zlib

ROOT = Path(__file__).resolve().parents[2]
URL = "https://assets.cms.plateau.reearth.io/assets/1a/f59166-6796-482d-b59d-cb9bfed3ddeb/21201_gifu-shi_city_2024_citygml_1_op.zip"
SIZE = 4284751077
RAW = ROOT / "data/raw"


def fetch_range(start: int, end: int) -> bytes:
    with tempfile.TemporaryDirectory() as temp:
        target = Path(temp) / "range.bin"
        headers = Path(temp) / "headers.txt"
        subprocess.run(["curl", "-fLsS", "--retry", "2", "--max-time", "240",
                        "--range", f"{start}-{end}", "--dump-header", str(headers),
                        "-o", str(target), URL], check=True)
        data = target.read_bytes()
        if len(data) != end - start + 1:
            raise ValueError(f"Server did not return requested byte range: {len(data)} bytes")
        if f"content-range: bytes {start}-{end}/{SIZE}" not in headers.read_text().lower():
            raise ValueError("Missing/mismatched Content-Range; archive may have changed")
        return data


def parse_directory(data: bytes) -> list[dict]:
    entries = []
    cursor = 0
    while data[cursor:cursor + 4] == b"PK\x01\x02":
        r = struct.unpack_from("<4s6H3I5H2I", data, cursor)
        name_len, extra_len, comment_len = r[10:13]
        name_bytes = data[cursor + 46:cursor + 46 + name_len]
        name = name_bytes.decode("utf-8" if r[3] & 2048 else "cp932")
        size, compressed, offset = r[9], r[8], r[16]
        extras = data[cursor + 46 + name_len:cursor + 46 + name_len + extra_len]
        extra_cursor = 0
        while extra_cursor + 4 <= len(extras):
            tag, length = struct.unpack_from("<HH", extras, extra_cursor)
            body = extras[extra_cursor + 4:extra_cursor + 4 + length]
            if tag == 1:
                p = 0
                if size == 0xFFFFFFFF:
                    size = struct.unpack_from("<Q", body, p)[0]; p += 8
                if compressed == 0xFFFFFFFF:
                    compressed = struct.unpack_from("<Q", body, p)[0]; p += 8
                if offset == 0xFFFFFFFF:
                    offset = struct.unpack_from("<Q", body, p)[0]
            extra_cursor += 4 + length
        entries.append({"name": name, "size": size, "compressed": compressed,
                        "offset": offset, "method": r[4], "crc32": r[7]})
        cursor += 46 + name_len + extra_len + comment_len
    return entries


def directory() -> list[dict]:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / "central-directory.bin"
    if not path.exists():
        tail = fetch_range(SIZE - 65536, SIZE - 1)
        # ZIP64 end-of-central-directory record is present in the official archive.
        pos = tail.rfind(b"PK\x06\x06")
        if pos >= 0:
            record = struct.unpack_from("<4sQ2H2I4Q", tail, pos)
            length, offset = record[8:10]
        else:
            pos = tail.rfind(b"PK\x05\x06")
            record = struct.unpack_from("<4s4H2IH", tail, pos)
            length, offset = record[5:7]
        path.write_bytes(fetch_range(offset, offset + length - 1))
    entries = parse_directory(path.read_bytes())
    if not entries:
        raise ValueError("No ZIP members found")
    index = RAW / "zip-members.json"
    if not index.exists() or index.stat().st_size == 0:
        staged = RAW / "zip-members.json.tmp"
        staged.write_text(json.dumps(entries, ensure_ascii=False))
        staged.replace(index)
    return entries


def retrieve(entry: dict) -> dict:
    name = PurePosixPath(entry["name"])
    if name.is_absolute() or ".." in name.parts:
        raise ValueError("Unsafe archive path")
    path = RAW / name
    if path.exists() and path.stat().st_size == entry["size"]:
        data = path.read_bytes()
    else:
        end = min(SIZE - 1, entry["offset"] + entry["compressed"] + 4095)
        block = fetch_range(entry["offset"], end)
        h = struct.unpack_from("<4s5H3I2H", block)
        if h[0] != b"PK\x03\x04":
            raise ValueError("Bad local ZIP header")
        start = 30 + h[9] + h[10]
        if start + entry["compressed"] > len(block):
            block = fetch_range(entry["offset"], entry["offset"] + start + entry["compressed"] - 1)
        payload = block[start:start + entry["compressed"]]
        if entry["method"] == 8:
            data = zlib.decompress(payload, -15)
        elif entry["method"] == 0:
            data = payload
        else:
            raise ValueError("Unsupported ZIP compression method")
        path.parent.mkdir(parents=True, exist_ok=True)
        # Some remote-backed executors return short writes for very large buffers.
        # Write bounded blocks and verify the bytes that were actually persisted.
        with path.open("wb") as handle:
            for cursor in range(0, len(data), 1024 * 1024):
                block = memoryview(data)[cursor:cursor + 1024 * 1024]
                while block:
                    written = handle.write(block)
                    if not written:
                        raise OSError("Short write while preserving source member")
                    block = block[written:]
        data = path.read_bytes()
    if len(data) != entry["size"] or zlib.crc32(data) != entry["crc32"]:
        raise ValueError(f"CRC/size mismatch: {name}")
    return {**entry, "sha256": hashlib.sha256(data).hexdigest(), "url": URL,
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "unchangedArchiveMember": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--members", nargs="*", help="Exact names; default AOI GML and metadata")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    entries = directory()
    if args.list:
        for entry in entries:
            if entry["name"].endswith(".gml") or "/udx/" not in entry["name"]:
                print(entry["name"], entry["size"])
        return
    if args.members:
        wanted = set(args.members)
        selected = [e for e in entries if e["name"] in wanted]
        missing = wanted - {e["name"] for e in selected}
        if missing:
            raise ValueError(f"Missing members: {sorted(missing)}")
    else:
        selected = [e for e in entries if not e["name"].endswith("/") and (
            (e["name"].endswith(".gml") and any(e["name"].startswith(f"udx/{kind}/5336069{col}")
             for kind in ("bldg", "tran", "squr", "trk", "brid", "frn", "dem") for col in (0, 1)))
            or (e["name"].startswith("metadata/") and e["size"] < 3_000_000))]
    print(f"Retrieving {len(selected)} members ({sum(e['compressed'] for e in selected):,} compressed bytes)")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(retrieve, selected))
    manifest_path = ROOT / "data/provenance.json"
    existing = json.loads(manifest_path.read_text())["members"] if manifest_path.exists() else []
    merged = {r["name"]: r for r in existing + records}
    manifest = {"sourceId": "S01", "archiveUrl": URL, "archiveSize": SIZE,
                "archiveFullSha256": None, "archiveFullSha256Reason": "Only selected immutable members retrieved using HTTP ranges",
                "centralDirectorySha256": hashlib.sha256((RAW / "central-directory.bin").read_bytes()).hexdigest(),
                "members": list(merged.values())}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Validated {len(records)} members; provenance at {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
