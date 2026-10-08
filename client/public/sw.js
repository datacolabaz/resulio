/*
 * Resulio.co service worker: browser push only. It has no fetch handler and caches nothing, so the
 * SPA, the prerendered SEO pages and HTTP caching behave exactly as without it.
 * Payload format: see buildPushPayload in server/notifications/webPush.ts.
 */

var DEFAULT_TITLE = "Resulio.co";
var DEFAULT_ICON = "/brand/resulio-icon.png";

function clip(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Same-origin path ("/x") or an absolute http(s) URL; anything else opens the home page. */
function safeUrl(value) {
  if (typeof value !== "string" || !value) return "/";
  if (value.charAt(0) === "/") return value.charAt(1) === "/" || value.charAt(1) === "\\" ? "/" : value;
  try {
    var parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "/";
  } catch (error) {
    return "/";
  }
}

/** Pure: turns the raw push text into notification options. Never throws. */
function parsePushPayload(text) {
  var data = {};
  if (typeof text === "string" && text) {
    try {
      var parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") data = parsed;
      else data = { body: text };
    } catch (error) {
      data = { body: text };
    }
  }
  var icon = typeof data.icon === "string" && data.icon.charAt(0) === "/" ? data.icon : DEFAULT_ICON;
  var badge = typeof data.badge === "string" && data.badge.charAt(0) === "/" ? data.badge : icon;
  return {
    title: clip(data.title, 120) || DEFAULT_TITLE,
    options: {
      body: clip(data.body, 300),
      icon: icon,
      badge: badge,
      tag: clip(data.tag, 64) || undefined,
      data: { url: safeUrl(data.url) },
    },
  };
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("push", function (event) {
    var text = "";
    try {
      text = event.data ? event.data.text() : "";
    } catch (error) {
      text = "";
    }
    var parsed = parsePushPayload(text);
    event.waitUntil(self.registration.showNotification(parsed.title, parsed.options));
  });

  self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var raw = (event.notification.data && event.notification.data.url) || "/";
    var target = new URL(raw, self.location.origin);
    var sameOrigin = target.origin === self.location.origin;
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
        if (sameOrigin) {
          var exact = windows.find(function (w) { return w.url === target.href; });
          if (exact) return exact.focus();
          var tab = windows.find(function (w) { return new URL(w.url).origin === target.origin; });
          if (tab) {
            return tab.focus().then(function (focused) {
              return focused && "navigate" in focused ? focused.navigate(target.href).catch(function () { return focused; }) : focused;
            });
          }
        }
        return self.clients.openWindow ? self.clients.openWindow(target.href) : undefined;
      }),
    );
  });
}
