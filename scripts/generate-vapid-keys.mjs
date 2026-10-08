#!/usr/bin/env node
/**
 * Prints a fresh VAPID key pair for browser push. Put the three lines into the API service's
 * environment (Railway: resulio-api → Variables). Rotating the keys invalidates every existing
 * subscription; browsers re-subscribe on their next visit.
 *
 * Usage: node scripts/generate-vapid-keys.mjs [mailto:you@example.com]
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const subject = process.argv[2] ?? "mailto:support@resulio.co";
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`WEB_PUSH_SUBJECT=${subject}`);
