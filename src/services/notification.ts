
import https from "https";
import { URL } from "url";


export async function sendGoogleChatMessage(text: string, opts?: { noGchat?: boolean }): Promise<void> {
  if (opts && opts.noGchat) return;
  const webhook = process.env.GCHAT_WEBHOOK_URL;
  if (!webhook) return;
  const timeoutMs = process.env.GCHAT_TIMEOUT_MS ? parseInt(process.env.GCHAT_TIMEOUT_MS, 10) : 4000;
  try {
    const url = new URL(webhook);
    const payload = JSON.stringify({ text });
    await new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      function finish(err?: Error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (err) reject(err); else resolve();
        }
      }
      const req = https.request(
        {
          method: "POST",
          hostname: url.hostname,
          path: url.pathname + url.search,
          protocol: url.protocol,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload).toString(),
          },
          signal: controller.signal as any,
        },
        res => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            finish();
          } else {
            finish(new Error(`Google Chat webhook non-2xx status=${status}`));
          }
        }
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("Request timed out"));
      });
      req.on("error", err => {
        if ((err as any).name === "AbortError" || (err as any).message === "Request timed out") {
          finish(new Error(`Google Chat webhook timed out after ${timeoutMs}ms`));
        } else {
          finish(err);
        }
      });
      req.on("close", () => finish());
      req.write(payload);
      req.end();
    });
  } catch (e: any) {
    console.error(`notification: failed to send Google Chat message: ${e?.message || e}`);
  }
}