/** Fetch exposes an HTTP Content-Encoding-decoded body. Some static servers
 * instead serve .gz as an opaque file, so inspect the delivered stream bytes. */
export async function getJSON<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  if (!response.body) return response.json() as Promise<T>;

  const reader = response.body.getReader();
  const prefix: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  let ended = false;
  while (length < 2) {
    const next = await reader.read();
    if (next.done) { ended = true; break; }
    prefix.push(next.value);
    length += next.value.length;
  }
  const signature: number[] = [];
  for (const chunk of prefix) for (const byte of chunk) {
    signature.push(byte);
    if (signature.length === 2) break;
  }
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      for (const chunk of prefix) controller.enqueue(chunk);
      if (ended) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  const body = signature[0] === 0x1f && signature[1] === 0x8b
    ? stream.pipeThrough(new DecompressionStream('gzip'))
    : stream;
  return new Response(body).json() as Promise<T>;
}
