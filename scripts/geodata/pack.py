#!/usr/bin/env python3
"""Write deterministic gzip chunks for network delivery (no raw-data download)."""
import gzip
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "public/data"


def main():
    stage = json.loads((OUT / "stage.json").read_text())
    for chunk in stage["chunks"]:
        path = ROOT / "public" / chunk["url"]
        plain = path.with_suffix("") if path.suffix == ".gz" else path
        raw = plain.read_bytes() if plain.exists() else gzip.decompress(path.read_bytes())
        target = path if path.suffix == ".gz" else path.with_suffix(".json.gz")
        payload = gzip.compress(raw, compresslevel=9, mtime=0)
        target.write_bytes(payload)
        if gzip.decompress(target.read_bytes()) != raw:
            raise OSError(f"Persisted gzip did not verify: {target}")
        chunk.update(url=str(target.relative_to(ROOT / "public")), encoding="gzip",
                     sha256=hashlib.sha256(payload).hexdigest(), bytes=len(payload),
                     uncompressedBytes=len(raw), uncompressedSha256=hashlib.sha256(raw).hexdigest())
    (OUT / "stage.json").write_text(json.dumps(stage, ensure_ascii=False, indent=2) + "\n")
    # Vite copies every public file regardless of .gitignore. Keep only compressed
    # delivery artifacts here once the manifest points to validated gzip files.
    for plain in OUT.glob("chunk-*.json"):
        if plain.with_suffix(".json.gz").exists():
            plain.unlink()
    print(f"Packed {len(stage['chunks'])} chunks: {sum(c['bytes'] for c in stage['chunks']):,} bytes")


if __name__ == "__main__":
    main()
