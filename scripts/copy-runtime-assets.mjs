import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Only the manifest's compressed runtime chunks enter a distribution. Conversion
// intermediates can exist locally without inflating a browser download.
const stage=JSON.parse(readFileSync('public/data/stage.json','utf8'));
const assets=new Set(['data/stage.json','data/destructibles.json','data/route-evidence.json','data/road-network.json',...stage.chunks.map(chunk=>chunk.url)]);
for(const asset of assets){
  if(typeof asset!=='string'||!asset.startsWith('data/')||asset.includes('..')||asset.includes('\\'))throw new Error(`Unsafe runtime asset: ${asset}`);
  if(asset.startsWith('data/chunk-')&&!asset.endsWith('.json.gz'))throw new Error(`Uncompressed runtime chunk: ${asset}`);
  const target=resolve('dist',asset);mkdirSync(dirname(target),{recursive:true});copyFileSync(resolve('public',asset),target);
}
console.log(`Copied ${assets.size} verified-path runtime assets; conversion intermediates excluded.`);
copyFileSync('THIRD-PARTY-NOTICES.txt', 'dist/THIRD-PARTY-NOTICES.txt');
