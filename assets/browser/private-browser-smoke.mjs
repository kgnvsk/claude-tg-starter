// Actual stdio MCP smoke under the selected agent; no Claude/model or external page.
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import readline from 'node:readline';
import http from 'node:http';

const home = homedir();
const uid = process.getuid();
const c = JSON.parse(await readFile(`/etc/claude-browser-private/${uid}.json`, 'utf8'));
if (c.uid !== uid || c.home !== home) throw new Error('selected browser identity mismatch');
let privateRequests = 0;
const privateProbe = http.createServer((_req, res) => {
  privateRequests++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.end('must-not-be-read');
});
await new Promise(resolve => privateProbe.listen(0, '127.0.0.254', resolve));
const child = spawn(`${home}/bin/browser-mcp`, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let nextId = 0;
const deadline = setTimeout(() => { child.kill('SIGTERM'); process.exitCode = 1; }, 90000);
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const value = JSON.parse(line);
  if (!value.id) return;
  const waiter = pending.get(value.id);
  if (!waiter) return;
  pending.delete(value.id);
  value.error ? waiter.reject(new Error('MCP request failed')) : waiter.resolve(value.result);
});
child.on('exit', () => { for (const waiter of pending.values()) waiter.reject(new Error('MCP transport exited')); });
function request(method, params) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return result;
}
async function tool(name, args) {
  const started = Date.now();
  console.error(JSON.stringify({ smokeTool: name, phase: 'start' }));
  const result = await request('tools/call', { name, arguments: args });
  // This smoke visits only its own blank page/fixture; report bounded text errors,
  // never image blocks, so an actual setup failure is diagnosable without replay.
  if (result?.isError) throw new Error('browser tool failed: ' + name + ': ' +
    (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1200));
  console.error(JSON.stringify({ smokeTool: name, phase: 'done', elapsedMs: Date.now() - started }));
  return result;
}
function privateDenyFacts(result, elapsedMs, requests) {
  const text = (result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const section = text.match(/(?:^|\n)### Result\n([\s\S]*?)(?=\n### |$)/);
  const errorName = section ? JSON.parse(section[1]) : null;
  // Immediate CSP/CORS/permission rejection is not proof of the cgroup deny.
  if (result?.isError || errorName !== 'AbortError' || elapsedMs < 2500 || elapsedMs > 12000 || requests !== 0)
    throw new Error('browser private-network probe inconclusive: ' + JSON.stringify({ errorName, elapsedMs, requests }));
  return { errorName, elapsedMs, privateFixtureRequests: requests };
}
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'private-browser-smoke', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await request('tools/list', {});
  // Opens the default blank tab; no loopback HTTP/DNS exception is needed.
  await tool('browser_navigate', { url: 'about:blank' });
  await tool('browser_snapshot', {});
  const evaluated = await tool('browser_evaluate', { function: '() => { document.body.innerHTML = "<button id=probe>private-browser-ok</button>"; return document.querySelector("#probe").textContent; }' });
  if (!JSON.stringify(evaluated).includes('private-browser-ok')) throw new Error('DOM result missing');
  await tool('browser_take_screenshot', { type: 'png', filename: 'private-mcp-smoke.png' });
  const image = await stat(`${c.state}/output/private-mcp-smoke.png`);
  if (!image.size) throw new Error('empty screenshot');
  // Read with selected agent permissions, never a root test -r substitute.
  if (!(await readFile(`${c.state}/output/private-mcp-smoke.png`)).length) throw new Error('unreadable screenshot');
  const privateUrl = `http://127.0.0.254:${privateProbe.address().port}/`;
  // Positive control: the selected agent can reach its own fixture. Only the
  // browser cgroup must be denied. Never visit another local service.
  await new Promise((resolve, reject) => {
    const req = http.get(privateUrl, res => { res.resume(); res.on('end', resolve); });
    req.setTimeout(3000, () => req.destroy(new Error('own fixture timeout')));
    req.on('error', reject);
  });
  if (privateRequests !== 1) throw new Error('own fixture positive control failed');
  privateRequests = 0;
  // Stay on neutral about:blank. A page-context fetch has its own short abort,
  // so a dropped connection cannot consume the MCP transport's watchdog.
  const started = Date.now();
  const denied = await tool('browser_evaluate', { function: `async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(${JSON.stringify(privateUrl)}, { signal: controller.signal, credentials: 'omit', redirect: 'error', mode: 'cors' });
      return 'resolved';
    } catch (error) { return error.name; }
    finally { clearTimeout(timer); }
  }` });
  const denyFacts = privateDenyFacts(denied, Date.now() - started, privateRequests);
  await tool('browser_close', {});
  await mkdir(`${home}/.cache`, { recursive: true, mode: 0o700 });
  await writeFile(`${home}/.cache/browser-private-smoke.json`, JSON.stringify({ ok: true, uid, version: c.version, at: new Date().toISOString(), transport: 'private-stdio', dom: true, screenshot: true, agentLoopbackAllowed: true, privateNetworkDenied: true, ...denyFacts }) + '\n', { mode: 0o600 });
  console.log('Private stdio browser DOM + screenshot operation passed.');
} finally {
  clearTimeout(deadline);
  privateProbe.close();
  child.stdin.end();
  const kill = setTimeout(() => child.kill('SIGTERM'), 10000);
  kill.unref();
}
