import http from 'node:http';
import { stat } from 'node:fs/promises';

const mcpUrl = 'http://localhost:8931/mcp';
const screenshot = '/srv/claude-browser-share/mcp-tool-smoke.png';
let sessionId;
let probeOpened = false;

const pageServer = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(
    '<!doctype html><title>starter-mcp-ok</title>' +
    '<button id="probe" onclick="this.textContent=\'clicked-ok\'">click-me</button>',
  );
});

await new Promise((resolve, reject) => {
  pageServer.once('error', reject);
  pageServer.listen(0, '127.0.0.1', resolve);
});
const address = pageServer.address();
if (!address || typeof address === 'string') throw new Error('local smoke server did not bind');
const probeUrl = `http://127.0.0.1:${address.port}`;

function parseResponse(body) {
  if (!body) return undefined;
  const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : body);
}

async function rpc(method, params, id) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const payload = { jsonrpc: '2.0', method };
  if (params !== undefined) payload.params = params;
  if (id !== undefined) payload.id = id;

  const response = await fetch(mcpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  sessionId ||= response.headers.get('mcp-session-id');
  const body = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}: ${body}`);
  return parseResponse(body);
}

// Closes the probe's own tab and no other: the one at the probe's own address (a page server on a port of its own).
// A plain close would close whatever tab had become current meanwhile. A probe that never reached its page leaves
// a blank tab behind rather than guess which blank tab is its own. MCP names a tab by its place in the list, so a
// tab another session closes between the two calls below could still shift that place; the install runs on a
// service it has just restarted.
async function closeProbeTab(probeUrl) {
  const listed = await rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } }, 8);
  const lines = (listed?.result?.content || []).map((part) => part.text || '').join('\n').split('\n');
  const mine = lines.find((line) => line.includes(probeUrl));
  const index = mine?.match(/^\s*-\s*(\d+):/)?.[1];
  if (index !== undefined) {
    await rpc('tools/call', { name: 'browser_tabs', arguments: { action: 'close', index: Number(index) } }, 9);
  }
}

function assertToolSucceeded(response, toolName) {
  if (!response?.result || response.result.isError) {
    throw new Error(`${toolName} failed: ${JSON.stringify(response)}`);
  }
}

try {
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'claude-tg-starter-smoke', version: '1.0' },
  }, 1);
  await rpc('notifications/initialized', {}, undefined);

  const listed = await rpc('tools/list', {}, 2);
  const toolNames = listed?.result?.tools?.map((tool) => tool.name) || [];
  for (const expected of ['browser_navigate', 'browser_snapshot', 'browser_take_screenshot']) {
    if (!toolNames.includes(expected)) throw new Error(`missing MCP tool: ${expected}`);
  }

  // The browser is shared by every session of the agent: the probe works in a tab of its own and closes it,
  // instead of taking over a page the bot or a scheduled task has open.
  probeOpened = true;
  const navigated = await rpc('tools/call', {
    name: 'browser_tabs',
    arguments: { action: 'new', url: probeUrl },
  }, 3);
  assertToolSucceeded(navigated, 'browser_tabs new');

  const snapshot = await rpc('tools/call', {
    name: 'browser_snapshot',
    arguments: {},
  }, 4);
  assertToolSucceeded(snapshot, 'browser_snapshot');
  const snapshotText = JSON.stringify(snapshot);
  if (!snapshotText.includes('starter-mcp-ok') || !snapshotText.includes('click-me')) {
    throw new Error(`unexpected browser snapshot: ${snapshotText.slice(0, 500)}`);
  }

  const captured = await rpc('tools/call', {
    name: 'browser_take_screenshot',
    arguments: { filename: screenshot, fullPage: true },
  }, 5);
  assertToolSucceeded(captured, 'browser_take_screenshot');
  const screenshotInfo = await stat(screenshot);
  if (screenshotInfo.size === 0) throw new Error('MCP screenshot is empty');

  console.log(JSON.stringify({
    ok: true,
    toolCount: toolNames.length,
    snapshot: true,
    screenshot,
  }));
} finally {
  if (probeOpened) await closeProbeTab(probeUrl).catch(() => {});
  await new Promise((resolve) => pageServer.close(resolve));
  if (sessionId) {
    await fetch(mcpUrl, {
      method: 'DELETE',
      headers: {
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
    }).catch(() => {});
  }
}
