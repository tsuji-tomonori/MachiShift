#!/usr/bin/env python3
"""Reproduce a clean dependency install, physics checks and the static build.

This deliberately does not turn unavailable browser/hardware/survey gates green.
Run from any directory; dated raw records are written into docs/evidence.
"""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import platform
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
TAG = datetime.now(timezone.utc).strftime("%Y%m%d")
EVIDENCE = ROOT / "docs/evidence"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inputs():
    paths = []
    for directory in ["src", "tests", "scripts", "public/data"]:
        paths.extend(p for p in (ROOT / directory).rglob("*")
                     if p.is_file() and "__pycache__" not in p.parts
                     and not (p.name.startswith("chunk-") and p.suffix == ".json"))
    paths.extend(ROOT / name for name in ["package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "vitest.config.ts", "playwright.config.ts", "index.html"])
    return {str(p.relative_to(ROOT)): sha(p) for p in sorted(set(paths))}


def main():
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    before = inputs()
    started = datetime.now(timezone.utc).isoformat()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    commands = [
        ["npm", "ci", "--no-fund", "--no-audit"],
        ["npm", "run", "typecheck"],
        ["npm", "test", "--", "--reporter=default", "--reporter=json", f"--outputFile=docs/evidence/final-unit-results-{TAG}.json"],
        ["npm", "run", "build"],
        ["npx", "playwright", "test", "--list"],
        ["git", "diff", "--check"],
    ]
    results = []
    log_path = EVIDENCE / f"final-run-{TAG}.log"
    with log_path.open("w") as log:
        for command in commands:
            stamp = datetime.now(timezone.utc).isoformat()
            print(f"RUN {' '.join(command)}", flush=True)
            log.write(f"\n{stamp} $ {' '.join(command)}\n")
            log.flush()
            tic = time.perf_counter()
            result = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            row = {"command": command, "startedAt": stamp, "exitCode": result.returncode,
                   "wallSeconds": round(time.perf_counter() - tic, 3)}
            results.append(row)
            print(json.dumps(row), flush=True)
            if result.returncode:
                break
    after = inputs()
    changed = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
    record = {
        "startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat(),
        "baseCommit": commit, "scope": "Actual local clean-install/type/Three+Rapier tests/build. Working-tree inputs identified by SHA-256. Browser listing is discovery only.",
        "environment": {"platform": platform.platform(), "python": platform.python_version(),
                        "node": subprocess.check_output(["node", "--version"], text=True).strip()},
        "commands": results, "inputSha256": before, "inputFilesChangedDuringRun": changed,
        "log": str(log_path.relative_to(ROOT)),
        "localVerification": "PASS" if len(results) == len(commands) and all(x["exitCode"] == 0 for x in results) and not changed else "FAIL",
        "notEstablished": ["browser 3D play", "GitHub CI", "human usability", "target GPU performance", "actual gamepad", "independent survey", "complete acceptance"],
    }
    (EVIDENCE / f"final-execution-{TAG}.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    if record["localVerification"] != "PASS":
        raise SystemExit(1)
    files = [{"path": str(p.relative_to(ROOT / "dist")), "bytes": p.stat().st_size, "sha256": sha(p)}
             for p in sorted((ROOT / "dist").rglob("*")) if p.is_file()]
    build = {"generatedAt": datetime.now(timezone.utc).isoformat(), "files": files,
             "totalBytes": sum(f["bytes"] for f in files), "runtimeChunks": sum(f["path"].endswith(".json.gz") for f in files),
             "usage": "Serve dist over HTTP; WebGL2 required. Does not include original downloads or uncompressed conversion intermediates."}
    (EVIDENCE / f"build-manifest-{TAG}.json").write_text(json.dumps(build, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"result": record["localVerification"], "buildBytes": build["totalBytes"], "runtimeChunks": build["runtimeChunks"]}), flush=True)


if __name__ == "__main__":
    main()
