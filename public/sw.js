// @ts-check
// Shows new-mail notifications the Worker pushes (worker/push.ts), and opens the thread when one is clicked. Registered
// when someone turns notifications on (src/push.ts). There's no fetch handler: nothing is cached or served offline.
// Plain JavaScript so it's served as written; `pnpm typecheck` checks it (tsconfig.sw.json).

const sw = serviceWorker();

// A new version takes over at once rather than waiting for every tab to close.
sw.addEventListener("install", () => void sw.skipWaiting());

sw.addEventListener("push", (event) => {
	// Shown even when it can't be read: browsers expect every push to show something, and Safari stops delivering to
	// a site whose pushes don't.
	const notice = readNotice(event.data) ?? { title: "Magnus Mail", body: "New mail", tag: "mail", url: "/" };
	event.waitUntil(
		sw.registration.showNotification(notice.title, {
			body: notice.body,
			tag: notice.tag,
			icon: "/icon-192.png",
			badge: "/badge.png",
			data: notice.url,
		}),
	);
});

sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data;
	event.waitUntil(open(typeof data === "string" && isAppPath(data) ? data : "/"));
});

/**
 * Brings the app forward on that page. An open window is told where to go (src/main.tsx), so it doesn't reload and lose
 * a draft; otherwise a new one opens there.
 * @param {string} url
 */
async function open(url) {
	// Most recently focused first, and not frames: a message body is a same-origin frame, the last focused if clicked.
	const windows = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
	const client = windows.find((w) => w.frameType === "top-level");
	if (!client) return void (await sw.clients.openWindow(url));
	// Told first, so it still goes there if the browser won't bring it forward.
	client.postMessage({ type: "open", url });
	await client.focus();
}

/**
 * What worker/push.ts sends, or null if that isn't what came.
 * @param {PushMessageData | null} message
 * @returns {{ title: string, body: string, tag: string, url: string } | null}
 */
function readNotice(message) {
	/** @type {unknown} */
	let data;
	try {
		data = message?.json();
	} catch {
		return null;
	}
	if (typeof data !== "object" || data === null) return null;
	if (!("title" in data && "body" in data && "tag" in data && "url" in data)) return null;
	const { title, body, tag, url } = data;
	if (typeof title !== "string" || typeof body !== "string" || typeof tag !== "string" || typeof url !== "string") return null;
	return isAppPath(url) ? { title, body, tag, url } : null;
}

/** @returns {ServiceWorkerGlobalScope} */
function serviceWorker() {
	if (self instanceof ServiceWorkerGlobalScope) return self;
	throw new Error("sw.js runs as a service worker");
}

/**
 * A path on this site, never another origin.
 * @param {string} url
 */
function isAppPath(url) {
	return url.startsWith("/") && new URL(url, sw.location.origin).origin === sw.location.origin;
}
