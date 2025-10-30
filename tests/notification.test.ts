import { describe, it, expect, vi, afterEach } from 'vitest';
import * as notif from '../src/services/notification';
import https from 'https';

// Helper to mock https.request
function mockHttps(status: number, capture: { payload?: string }) {
  return vi.spyOn(https, 'request').mockImplementation((opts: any, cb: any) => {
    const res = { statusCode: status } as any;
    // Ensure callback is called after next tick to allow .write to be called first
    let reqObj: any = {
      on: () => {},
      write: (data: string) => { capture.payload = data; },
      end: () => { if (typeof cb === 'function') setTimeout(() => cb(res), 0); },
      setTimeout: () => {},
      destroy: () => {},
    };
    return reqObj;
  });
}

describe('notification (Google Chat)', () => {
  afterEach(() => {
    delete process.env.GCHAT_WEBHOOK_URL;
    vi.restoreAllMocks();
    process.env.NODE_ENV = 'test';
  });

  it('skips send when webhook missing', async () => {
    const spy = mockHttps(200, {}); // Should not be used
    await notif.sendGoogleChatMessage('hello world');
    expect(spy).not.toHaveBeenCalled();
  });


  it('sends basic message to webhook', async () => {
    process.env.GCHAT_WEBHOOK_URL = 'https://example.com/webhook';
    process.env.NODE_ENV = 'test';
    const capture: { payload?: string } = {};
    const spy = mockHttps(200, capture);
    await notif.sendGoogleChatMessage('hello google chat');
    await new Promise(res => setTimeout(res, 5));
    expect(spy).toHaveBeenCalled();
    if (typeof capture.payload !== 'string') {
      throw new Error('Payload was not set: ' + JSON.stringify(capture));
    }
    expect(capture.payload).toContain('hello google chat');
  });


  // Immediate notification tests are deprecated; notifications are now sent at the end, grouped per project.

  it('handles non-2xx status with warning (no throw)', async () => {
  process.env.GCHAT_WEBHOOK_URL = 'https://example.com/webhook';
  process.env.NODE_ENV = 'test';
    const spy = mockHttps(500, {});
    await notif.sendGoogleChatMessage('should warn');
    expect(spy).toHaveBeenCalled();
  });


});
