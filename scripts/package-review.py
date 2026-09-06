#!/usr/bin/env python3
"""Package the committed Git history, HTTP build and review evidence."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
TAG = datetime.now(timezone.utc).strftime("%Y%m%d")
OUT = ROOT.parent / "deliverables"


def main():
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip():
        raise SystemExit("Commit the reviewed source and evidence before packaging.")
    OUT.mkdir(exist_ok=True)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    branch = subprocess.check_output(["git", "branch", "--show-current"], cwd=ROOT, text=True).strip()
    bundle = OUT / "MachiShift.bundle"
    subprocess.run(["git", "bundle", "create", str(bundle), "--all"], cwd=ROOT, check=True)
    subprocess.run(["git", "bundle", "verify", str(bundle)], cwd=ROOT, check=True)
    manifest = json.loads((ROOT / f"docs/evidence/build-manifest-{TAG}.json").read_text())
    for entry in manifest["files"]:
        path = ROOT / "dist" / entry["path"]
        if path.stat().st_size != entry["bytes"] or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit(f"Build artifact changed since verification: {path}")
    start = f"""# MachiShift レビュー用ビルド

コミット: {commit}
ブランチ: {branch}

総合受入とGitHubへの反映は未完了です。実行済み試験、残る条件、過去の不具合と修正は review/docs/acceptance.md と要件台帳に記録しています。

## ブラウザーで開く

このZIPを展開したフォルダーで、Python 3のHTTPサーバーを起動します。

```sh
python3 -m http.server 8000 --directory web-build
```

WebGL2が有効なPCブラウザーで http://localhost:8000 を開きます。終了はターミナルでCtrl+Cです。HTMLのダブルクリックによる file:// 起動は使用できません。

## ソースを復元する

```sh
git clone --branch {branch} MachiShift.bundle MachiShift
cd MachiShift
npm ci
npm run dev
```

Node.js22を使用します。Gitbundleにはローカルのmainと作業ブランチの履歴が含まれます。リモートへのpush・PR・CI・本番公開が完了したという意味ではありません。

原典のCityGML・PDF17ファイルは別の MachiShift-gifu-original-data-{TAG}.zip に保存しています。原本検査を再実行する場合は、そのoriginal-dataの内容をソースのdata/rawへ配置してください。

ゲーム内の検証パネルはURLに ?qa=1 を付けて開けます。実状態のJSON、フレーム時間、利用可能な場合のヒープ値を保存します。指定GPUの性能合格や人の初見評価の代替にはしません。
"""
    delivery = {"createdAt": datetime.now(timezone.utc).isoformat(), "commit": commit, "branch": branch,
                "remoteRepository": "https://github.com/tsuji-tomonori/MachiShift",
                "remoteDelivery": "BLOCKED", "acceptance": "INCOMPLETE",
                "bundleSha256": hashlib.sha256(bundle.read_bytes()).hexdigest(),
                "buildBytes": manifest["totalBytes"], "buildManifest": f"review/docs/evidence/build-manifest-{TAG}.json"}
    archive = OUT / f"MachiShift-review-build-{TAG}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.write(bundle, "MachiShift.bundle")
        z.writestr("START-HERE.md", start)
        z.writestr("delivery-manifest.json", json.dumps(delivery, ensure_ascii=False, indent=2) + "\n")
        for path in sorted((ROOT / "dist").rglob("*")):
            if path.is_file(): z.write(path, "web-build/" + str(path.relative_to(ROOT / "dist")))
        for directory in ["docs", "artifacts", "source_materials"]:
            for path in sorted((ROOT / directory).rglob("*")):
                if path.is_file(): z.write(path, "review/" + str(path.relative_to(ROOT)))
        for path in sorted((ROOT / "data").glob("*")):
            if path.is_file(): z.write(path, "review/" + str(path.relative_to(ROOT)))
        z.write(ROOT / "README.md", "review/README.md")
        z.write(ROOT / "THIRD-PARTY-NOTICES.txt", "review/THIRD-PARTY-NOTICES.txt")
    with zipfile.ZipFile(archive) as z:
        bad = z.testzip()
        if bad: raise SystemExit(f"Archive CRC error: {bad}")
    print(json.dumps({"archive": str(archive), "bytes": archive.stat().st_size,
                      "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "commit": commit}))


if __name__ == "__main__":
    main()
