import { fromBase64Url, toBase64Url } from "#shared";
import { api } from "./api";

/** Whether this browser can get notifications. iPhones and iPads only notify for a site added to the Home Screen. */
export function pushSupport(): "supported" | "install" | "unsupported" {
	if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) return "supported";
	const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
	return ios && !matchMedia("(display-mode: standalone)").matches ? "install" : "unsupported";
}

/** On while the server sends this session's notifications to this browser's subscription. */
export async function pushState() {
	const registration = await navigator.serviceWorker.getRegistration();
	const [server, subscription] = await Promise.all([api.push(), registration?.pushManager.getSubscription()]);
	return { on: Boolean(subscription && subscription.endpoint === server.endpoint), publicKey: server.publicKey, blocked: Notification.permission === "denied" };
}

/**
 * Subscribes this browser and gives the server its subscription. `permission` is asked for in the click that turns this
 * on, since Safari asks only from inside one.
 */
export async function enablePush(permission: Promise<NotificationPermission>, publicKey: string): Promise<void> {
	const answer = await permission;
	if (answer === "denied") throw new Error("Notifications are blocked for this site. Allow them in your browser's settings.");
	if (answer !== "granted") throw new Error("Allow notifications when your browser asks, to turn them on.");
	const registration = await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	let subscription = await registration.pushManager.getSubscription();
	// Made with another key, which push services won't take pushes for.
	const made = subscription?.options.applicationServerKey;
	if (subscription && (!made || toBase64Url(new Uint8Array(made)) !== publicKey)) {
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) });
	await api.enablePush({ endpoint: subscription.endpoint, keys: { p256dh: key(subscription, "p256dh"), auth: key(subscription, "auth") } });
}

/**
 * Stops this session's notifications here. The browser drops its subscription first, so if it can't, nothing changes
 * and turning them off again retries; once it has, nothing reaches this browser even if telling the server fails.
 */
export async function disablePush(): Promise<void> {
	try {
		await forgetDevice();
	} catch (error) {
		throw new Error("Couldn't turn off notifications in this browser. Try again.", { cause: error });
	}
	await api.disablePush();
}

function key(subscription: PushSubscription, name: PushEncryptionKeyName): string {
	const value = subscription.getKey(name);
	if (!value) throw new Error(`The browser gave no ${name} key`);
	return toBase64Url(new Uint8Array(value));
}

let forgetting: Promise<void> | null = null;

/**
 * For a session that ended here: drops the browser's subscription and closes notifications already showing. The
 * server forgot the browser with the session, but a push the push service already holds (for up to a day, while the
 * device is offline) would still arrive, and show the account's mail to whoever signs in next. Tried 3 times, one
 * run at a time: a call while one runs gets that one.
 */
export function forgetDevice(): Promise<void> {
	forgetting ??= dropSubscription().finally(() => {
		forgetting = null;
	});
	return forgetting;
}

async function dropSubscription(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const registration = await navigator.serviceWorker.getRegistration();
	if (!registration) return;
	// The one there now. A retry never asks again: someone signing in meanwhile may have made their own.
	const subscription = await registration.pushManager.getSubscription();
	try {
		for (let attempt = 1; subscription; attempt++) {
			try {
				if (await subscription.unsubscribe()) break;
				throw new Error("The browser kept its push subscription");
			} catch (error) {
				if (attempt === 3) throw error;
				await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
			}
		}
	} finally {
		for (const notification of await registration.getNotifications()) notification.close();
	}
}

/** The page a clicked notification asks this tab to open (public/sw.js), if the message is one. */
export function notificationTarget(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("type" in data && "url" in data) || data.type !== "open" || typeof data.url !== "string") return null;
	return data.url.startsWith("/") && new URL(data.url, location.origin).origin === location.origin ? data.url : null;
}
