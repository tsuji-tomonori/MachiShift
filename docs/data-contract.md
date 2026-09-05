# 地理・物理・レース状態のデータ契約

Version 1。実装上の型は `src/environment.ts`、`src/race.ts`、生成スキーマは `scripts/geodata/convert.py` にある。この契約は現状のシリアライズ形式と、未完成の部分を区別する。

## 地理原典と座標

`source_materials/` は変更しない要求・調査資料であり、取得済み地理データそのものではない。取得したCityGML等の原本と取得記録を `data/provenance.json` から追跡する。大きな原本はGitとブラウザーの配信物に含めない。

ゲーム内の1単位は1m。水平は原典の緯度経度からJGD2011平面直角座標系第VII系（EPSG:6675）へ変換し、原点からのメートル差へ変換する。軸は +X=東、+Y=上、−Z=北。原典の高さはEPSG:6697のJGD2011標高として扱う。`metadata.origin` は `[latitude, longitude, height]` で、現時点の初期値は `[35.4107,136.7595,0]`。

`heightStatus: source_placeholder_zero` は原典の平面形状に0が入っていたことを表す。測量による標高0mと解釈しない。走行路の支持面として無条件に利用しない。`source_height_preserved` も独立測量精度の合格を意味しない。

## ステージと区画

`public/data/stage.json` の必須構成は次のとおり。

| 属性 | 形式・意味 |
|---|---|
| `version` | `1` |
| `metadata.name/source/sourceUrl` | ステージ名、採用原典、配布元 |
| `metadata.status` | 現状は `source_only` |
| `metadata.coordinateSystem/verticalDatum/unit/origin` | 座標変換、高さ基準、単位、原点 |
| `metadata.aoiLocalXZ` | `[minX,minZ,maxX,maxZ]`、変換後のAOI |
| `metadata.license/licenseUrl/attribution` | 採用条件と帰属表示 |
| `metadata.surveyDate/surveyDateNote` | 調査年と確認範囲。不明は `null` |
| `metadata.textures/accuracy/processing/counts/terrain` | テクスチャの採用状態、未検証精度、加工履歴、地物集計、原典TIN地形の切出し・路面重複除去 |
| `chunks[]` | `{id,url,bounds,objectCount,triangles,sha256,bytes,encoding,uncompressedBytes,uncompressedSha256}` |
| `route` | `[x,y,z][]`、メートル単位の閉ルート候補 |
| `routeStatus` | 経路の由来・検証状態。座標があるだけで走行合格にしない |
| `routeLengthMetres/routeWidthMetres/routeMinimumSourceBoundaryClearanceMetres` | 現経路長1,388.202m、原典路面の最小境界余裕とその2倍の幅。現地測量による有効幅員の保証ではない |
| `routeEvidenceUrl/routeClearanceMetres` | 経路生成の検査資料と採用した障害物余裕 |

区画配信ファイル `public/data/chunk-{id}.json.gz` はgzip解凍後に `{id,objects:[]}` となる。区画境界 `bounds` は `[minX,minY,minZ,maxX,maxY,maxZ]`。`sha256/bytes` は圧縮ファイル、`uncompressedSha256/uncompressedBytes` は解凍後のJSONに対応する。

| 地物属性 | 形式・意味 |
|---|---|
| `id` | `plateau:`＋元 `gml:id`。実行時の `objectId` に対応 |
| `sourceId/sourceFile/chunkId` | 原典ID・ファイル・区画の逆引き |
| `kind` | `building`, `road`, `plaza`, `bridge`, `furniture`, `walkway`, `terrain` |
| `positions` | フラットなXYZ配列。メートル単位 |
| `indices` | `positions` 頂点への整数インデックス。3個で1三角形 |
| `surfaces[]` | `{id,sourceId,start,count,semantic}`。`start/count` はインデックス配列の範囲 |
| `cityLod/renderLod` | 原典CityGML LODと描画変換を別管理。現状の `renderLod` は `original_triangulated` |
| `bounds/name/sourceAttributes` | 境界・原典名称・`class/function/usage` |
| `verification/gameAdded/heightStatus` | 真正性分類、ゲーム追加か、原典高さの扱い |
| `runtimeEligible` | `false` の原典地物は台帳に残すが、表示・衝突・経路支持面には採用しない。現状は高さ0の道路292件を除外 |

`survey_verified` は独立資料の測定証跡がある場合だけ使用可能。原典のままなら `source_only`、推定補修なら `inferred`、仮設障害物などのゲーム専用追加は `game_added` とする。表示メッシュ統合で原典の地物・表面IDを捨てない。

現在の50区画には4,845地物と336,547三角形を収める。原典TIN地形は道路と重複する面を切り抜き、走行路より上に重なる地面で車体を妨げないようにする。原典高を任意の平面へ置換しない。原典LOD3道路に全378経路点が支持されることを検査しているが、実在のデッキ昇降部や縁石の独立測量は別に必要である。

現配信形式はGLBではなくJSON gzip。初期起動で全50区画を順番に取得して進捗を表示し、走行中の区画復元はメモリ内アーカイブから行う。未取得区画を走行に合わせてネットワーク取得する実装ではない。原文の「GLB等」に対する可逆な形式選択として扱い、形式比較・テクスチャ採用・配信性能の不足をPERF-04に残す。

## 表示・衝突・破壊部品

`Environment.addStaticMesh(spec)` は同じ頂点・三角形からThree.js表示メッシュとRapierの静的三角形衝突面を生成する。`spec.surfaces` の範囲は描画上の着弾面から原典表面IDを選ぶために使う。

`addBreakable(spec)` は `{id,position,size,rotationY?,color?,chunkId,kind?,verification,parts?}` を受け取る。部品は `{id?,offset,size,color?}`。部品を省略した場合にも事前分割する。部品ごとの `pieceId`、親の `objectId`、`surfaceId` を保持する。現地資料がない任意の柵・外装を `source_only` にしない。

`addDestructibleMesh(spec,{surfaceIds?,maxPieces?,maxSurfaceArea?})` は原典の指定表面をその頂点のまま分離対象へ変換する。未選択面は静的に残る。建物を全壊させず、元のポリゴンIDを維持する。初期衝突は元の三角形で、分離後のみ安定した動的衝突のため爆風に露出した側へ4cmのゲーム用厚みを持つ凸包に変える。両側に厚みを付ける初期案では薄い原典ベンチ内で破片が拘束され、実データ試験で検出して修正した。凸包作成不能時の外接直方体も `collisionApproximation` に記録する。これは実測の壁厚ではない。特定の窓・庇・設備カテゴリを再現できているかは原典の意味と照合して別に確認する。

建物パネルには原典の残る構造へ押し込まれることを防ぐ外向きの分離インパルスを加える。実剛体へ与えるアーケード調整であり、頂点や車両進行を試験用に移動して合格を作らない。採用WallSurfaceの実行試験では残る構造の頂点・姿勢・衝突を保ったまま塗装部品が0.5秒で0.724646m動いた。

未破壊部品は固定剛体と衝突形状を持つ。爆発で同じ部品の固定剛体・衝突形状を除去し、動的剛体・衝突形状へ交換する。三角形の遮蔽を全候補について判定してから破壊し、反復順序で奥の物体が誤って露出しないようにする。強度・速度・飛散はゲーム調整値で、現実の構造安全性を表さない。

動的破片は最大100個。6秒後または上限超過の小片（同じ大きさなら古い部品）から物理を外して表示と変化の状態を残す。もとの柵の衝突形状を再生しない。

## 塗装とグリップ

塗装は命中三角形上の局所デカールで、表面ローカル座標と面IDを保持する。各飛沫は独立して可視性・命中を判定する。壁全体の単色化には使わない。ペイントは対象部品メッシュの子なので、同じ部品が動的破片へ変わると局所位置を保って移動する。

塗装レコードの観察形式は `{eventId,color,surfaceId,localPoint,worldPoint,vertices}`。`localPoint` と頂点は親部品座標に対応し、`worldPoint` は実際のThree.jsワールド変換後の位置。色レイヤーは描画順を持つ。

グリップ領域は `{center,radius,expiresAt,surfaceId}`。見た目のペイント寿命と別に、ゲーム時間で8秒の効果を持つ。車両は毎ステップ `gripAt(position)` を共通利用する。平面距離・高さだけでなく下向きの命中面IDを照合し、近接する上下の床を混同しない。見た目の模様・効果時間の案内はUIの責務。

`activeGripZones` は現在有効な領域を読み取り用に公開する。ホストは実半径1.6mと残り秒数をラベルへ投影し、遮蔽と失効で表示を制御する。車両の支持床へ実際に効く場合だけ共通グリップ警告を出す。この表示の実ブラウザー上の読みやすさは未検証。

## 観察、保持、リセット

`Environment.getState()` はテスト専用の架空状態ではなく、Three.jsメッシュとRapier剛体・衝突形状から次を出力する。

```ts
{
  id, objectId, surfaceId, surfaces?, chunkId, kind, verification,
  broken, retired, visible, loaded, position, rotation,
  sourceMesh, collisionApproximation,
  bodyHandle, colliderHandle, dynamic, paints
}[]
```

`setChunkVisible(id, visible)` はメッシュ・状態・衝突面をメモリに保持して可視性だけを変える。一方、`unloadChunk(id)` は描画のジオメトリ・マテリアル・塗装資源とRapierの剛体・衝突面を実際に解放し、原典の型付き配列と局所塗装記録、最終変換、速度を保持する。`reloadChunk(id)` は新しい描画資源と衝突形状を再構築して塗装を再投影する。破壊済み部品を未破壊の固定衝突へ戻さず、寿命が切れていた破片は非衝突で復元する。

非表示化と実資源解放は別の試験にする。メモリ内の不変アーカイブからの再構築は実装済みで、ディスク保存・ページ再起動を跨ぐ永続化は提供しない。解放中の区画では物理が停止するため、走行中の全車が存在する衝突区画を保護する必要がある。`removeChunk(id)` は検証専用追加物などの区画と保管状態を完全に除去し、再レースで再出現させない。

ホストは全有効車両とカメラを基準に450mより遠い区画を解放し、380m以内へ近づくと復元するヒステリシスを導入している。近傍の車両がある区画は解放しない。街路設備の表示110m・影90mの距離制限も、都市モデル自体のLODや精度と別の描画方針として扱う。実ステージでの境界走行と性能は統合試験で確認する。

`Environment.reset()` は全ペイントとグリップを除去し、破片の動的物理を破棄して元の固定位置・衝突形状を再構築する。地理の不変モデルを変更せず、車両等の外部所有剛体を削除しない。ホストは同じ新レース遷移の中で `Race.reset(mode)` とアイテム・投擲・タイマー・結果UIの初期化も行う。

## 車両と経路進行

`Race` は6台の動的Rapier車両を所有し、入力・AIとも共通の車両コントローラーを使う。通常走行で座標を直接移動しない。自由走行ではAIを無効化する。入力スナップショットは `{throttle,brake,steer,drift,recover}`。

`Route` はメートル単位の閉じた経路を保持する。`CourseProgress` は `checkpoint,completedLaps,acceptedGates,lastPassed,finished,previous,rejectedTeleports` を持ち、指定の次ゲートを順方向に横切る場合だけ加算する。高さ・横方向許容幅・不自然な移動量も検査する。3周で完走し、順位は有効な進行と完走時刻に従う。

復帰は最後の通過地点より前から、地面・勾配と車両の重なりを検査して選ぶ。復帰時に周回・次ゲートを進めない。安全候補がない場合は拒否する。3秒以内という受入は実コースの指定ケースで別に実測する。

固定更新の呼び出し順は `race.update(1/60,...)` → `world.step()` → `race.afterStep(1/60)` → `environment.update(...)`。ポーズ時はゲーム時間を進めない。HUDは実車両の速度・順位・周回・アイテムと次ゲートから構成する。
