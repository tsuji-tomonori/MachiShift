#!/usr/bin/env python3
"""Write measured source-integrity and conversion-validation evidence."""
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import subprocess
import sys
import time
import zlib

ROOT = Path(__file__).resolve().parents[2]


def main():
    started = datetime.now(timezone.utc).isoformat()
    provenance = json.loads((ROOT / "data/provenance.json").read_text())
    members = []
    for source in provenance["members"]:
        path = ROOT / "data/raw" / source["name"]
        if not path.exists():
            members.append({"name": source["name"], "status": "NOT_RUN", "reason": "Raw member absent in this checkout; retrieve it for source integrity recheck"})
            continue
        digest = hashlib.sha256()
        crc = 0
        size = 0
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk); crc = zlib.crc32(chunk, crc); size += len(chunk)
        passed = size == source["size"] and digest.hexdigest() == source["sha256"] and crc == source["crc32"]
        members.append({"name": source["name"], "status": "PASS" if passed else "FAIL", "actualBytes": size, "actualSha256": digest.hexdigest(), "actualCrc32": crc})
    command = [sys.executable, "-m", "unittest", "discover", "-s", "scripts/geodata", "-p", "test_*.py"]
    tic = time.perf_counter()
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    elapsed = time.perf_counter() - tic
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True)
    versions = {p: importlib.metadata.version(p) for p in ["lxml", "numpy", "pyproj", "shapely", "mapbox-earcut"]}
    files = list((ROOT / "scripts/geodata").glob("*.py")) + [ROOT / "public/data/stage.json", ROOT / "public/data/destructibles.json"]
    evidence = {"startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat(),
                "baseCommit": base.stdout.strip() if base.returncode == 0 else None,
                "scope": "Working-tree files identified by SHA256; base commit is not asserted to contain every change", "command": command,
                "testStatus": "PASS" if result.returncode == 0 else "FAIL", "exitCode": result.returncode,
                "wallTimeSeconds": round(elapsed, 3), "stdout": result.stdout, "stderr": result.stderr,
                "environment": {"python": sys.version, "platform": platform.platform(), "packages": versions},
                "fileHashes": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
                "rawSourceIntegrity": members, "notEstablished": ["independent road precision", "independent building precision", "source photograph/texture match", "hardware GPU performance", "human usability"]}
    (ROOT / "data/validation.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"testStatus": evidence["testStatus"], "wallTimeSeconds": evidence["wallTimeSeconds"], "rawMembers": len(members), "rawPass": sum(x["status"] == "PASS" for x in members), "rawFail": sum(x["status"] == "FAIL" for x in members)}, indent=2))
    if result.returncode or any(x["status"] == "FAIL" for x in members):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
