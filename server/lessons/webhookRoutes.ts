import type { Express, Request, Response } from "express";
import { ENV } from "../_core/env";
import { verifyZoomWebhookSignature, zoomWebhookChallengeResponse } from "./providers/zoom";
import { processZoomWebhook, type ZoomWebhookPayload } from "./webhooks";

/**
 * Zoom's inbound webhook endpoint. Plain Express (not tRPC): Zoom calls this directly with its
 * own signed body, there is no Resulio session. Signature verification needs the *exact* raw
 * request bytes, which `express.json()`'s `verify` option stashes on `req.rawBody`
 * (server/_core/index.ts) before parsing it into `req.body`.
 */
export function registerLessonWebhookRoutes(app: Express) {
  app.post("/api/lessons/webhooks/zoom", async (req: Request, res: Response) => {
    const body = req.body as ZoomWebhookPayload;
    const secret = ENV.zoomWebhookSecret;

    // Zoom's one-time endpoint-validation handshake, required before it will deliver real events.
    if (body?.event === "endpoint.url_validation") {
      const plainToken = body.payload?.plainToken;
      if (!secret || !plainToken) return res.status(400).json({ error: "missing secret or plainToken" });
      return res.status(200).json(zoomWebhookChallengeResponse(plainToken, secret));
    }

    if (!secret) {
      console.error("[Lessons] Zoom webhook received but ZOOM_WEBHOOK_SECRET is not configured");
      return res.status(503).send("webhook not configured");
    }

    const signature = req.header("x-zm-signature");
    const timestamp = req.header("x-zm-request-timestamp");
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!signature || !timestamp || !rawBody || !verifyZoomWebhookSignature(rawBody.toString("utf8"), timestamp, signature, secret)) {
      return res.status(401).send("invalid signature");
    }

    // Ack immediately; Zoom retries on timeout/non-2xx, so a slow download must never block the response.
    res.status(200).json({ received: true });
    try {
      await processZoomWebhook(body);
    } catch (error) {
      console.error("[Lessons] Zoom webhook processing failed", error instanceof Error ? error.message : error);
    }
  });
}
