import type { AppiumClient } from '../appium/client.ts';
import { unexpectedResponse } from '../appium/client.ts';
import { readChromeOwnerResponse } from '../core/chrome-owner-auth.ts';
import type { OwnedChromeEndpoint } from './owned-chrome.ts';

export async function resolveOwnedChromePage(endpoint: Pick<OwnedChromeEndpoint, 'assertHealthy' | 'debuggerAddress'>, client: AppiumClient): Promise<string> {
  endpoint.assertHealthy();
  const handle = await client.cmd('GET', '/window');
  if (typeof handle !== 'string') throw unexpectedResponse('window handle', handle);
  const id = handle.replace(/^CDwindow-/, '');
  const response = await fetch(`http://${endpoint.debuggerAddress}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  const pages: unknown = JSON.parse(await readChromeOwnerResponse(response, 1024 * 1024));
  if (!response.ok || !Array.isArray(pages)) throw new Error('Chrome page identity is unverified');
  const page = pages.find((value: unknown) => typeof value === 'object' && value !== null && 'id' in value && value.id === id) as { webSocketDebuggerUrl?: unknown } | undefined;
  if (typeof page?.webSocketDebuggerUrl !== 'string') throw new Error('Owned active Chrome page stream is missing');
  const url = new URL(page.webSocketDebuggerUrl);
  if (url.protocol !== 'ws:' || url.host !== endpoint.debuggerAddress || url.pathname !== `/devtools/page/${id}` || url.username || url.password || url.search || url.hash) throw new Error('Chrome page stream differs from the original native target');
  endpoint.assertHealthy();
  return url.href;
}
