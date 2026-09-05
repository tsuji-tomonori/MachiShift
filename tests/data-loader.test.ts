import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getJSON } from '../src/data-loader';

const source = { source: '岐阜 CityGML', vertices: [1, 2, 3], objects: [{ id: 'original-surface' }] };
const json = JSON.stringify(source);
const compressed = gzipSync(json);
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/missing.json.gz') { response.writeHead(404); response.end(); return; }
    if (request.url === '/truncated.json.gz') { response.end(compressed.subarray(0, 12)); return; }
    if (request.url === '/http-encoded.json.gz') response.setHeader('Content-Encoding', 'gzip');
    response.setHeader('Content-Type', request.url === '/opaque.json.gz' ? 'application/gzip' : 'application/json');
    response.end(request.url === '/plain.json.gz' ? json : compressed);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test HTTP listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

it.each(['http-encoded.json.gz', 'opaque.json.gz', 'plain.json.gz'])('loads unchanged source JSON from %s', async path => {
  // Real HTTP fetch applies Content-Encoding decoding, reproducing Vite preview.
  expect(await getJSON(`${origin}/${path}`)).toEqual(source);
});
it('reports HTTP errors before parsing', async () => {
  await expect(getJSON(`${origin}/missing.json.gz`)).rejects.toThrow('HTTP 404');
});
it('rejects a truncated gzip instead of returning a partial stage', async () => {
  await expect(getJSON(`${origin}/truncated.json.gz`)).rejects.toThrow();
});
