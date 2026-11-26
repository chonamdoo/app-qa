import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ChromeOwnerCredentials {
  readonly token: string;
  readonly replyKey: string;
}
export function chromeOwnerReplySignature(key: string, requestId: string, status: number, body: string | Uint8Array): string {
  return createHmac('sha256', key).update(`qautra/chrome-owner-reply/v1\n${requestId}\n${status}\n`).update(body).digest('hex');
}
function equalDigest(actual: string | null | undefined, expected: string): boolean {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
export function authenticChromeOwnerReply(key: string, requestId: string, status: number, body: string | Uint8Array, signature: string | null | undefined): boolean {
  return equalDigest(signature, chromeOwnerReplySignature(key, requestId, status, body));
}
export function chromeOwnerValueSignature(key: string, purpose: 'state' | 'address' | 'execution', value: unknown): string {
  const body = JSON.stringify(value);
  if (body === undefined) throw new TypeError('Native owner material must be serializable');
  return createHmac('sha256', key).update(`qautra/chrome-owner-${purpose}/v1\n`).update(body).digest('hex');
}
export function authenticChromeOwnerValue(key: string, purpose: 'state' | 'address' | 'execution', value: unknown, signature: string): boolean {
  return equalDigest(signature, chromeOwnerValueSignature(key, purpose, value));
}

export async function readChromeOwnerResponse(response: Response, maximum = 16 * 1024 * 1024): Promise<string> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) throw new RangeError('Invalid native response byte bound');
  if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new RangeError('Native owner response exceeds its byte bound'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw new RangeError('Native owner response exceeds its byte bound'); }
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, length));
  } finally { reader.releaseLock(); }
}
