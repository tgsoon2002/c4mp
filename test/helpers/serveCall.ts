import * as http from 'http';

export interface Answer { status: number; headers: http.IncomingHttpHeaders; text: string }
export interface Call { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean }

/** One request to 127.0.0.1:<port>; Host is ours unless headers.Host says otherwise. No keep-alive. */
export function serveCall(port: number, c: Call = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: `127.0.0.1:${port}`, ...c.headers };
    if (c.body !== undefined && !c.chunked) headers['Content-Length'] = String(Buffer.byteLength(c.body));
    let answered = false;
    const req = http.request({ host: '127.0.0.1', port, method: c.method ?? 'GET', path: c.path ?? '/', headers, agent: false }, (res) => {
      answered = true;
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => { if (!answered) reject(err); });   // a refused body may reset the socket after the answer
    if (c.body !== undefined) req.write(c.body);
    req.end();
  });
}

/** The headers of a page write: token, Origin of the server and a JSON body. */
export const writeHeaders = (port: number, token: string): Record<string, string> => ({
  'X-C4PM-Token': token,
  Origin: `http://127.0.0.1:${port}`,
  'Content-Type': 'application/json',
});
