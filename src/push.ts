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
 * Stops this session's notifications here. The browser keeps its subscription for turning them on again, but nothing
 * sends to it, and whoever signs in here next starts with notifications off.
 */
export const disablePush = () => api.disablePush();

function key(subscription: PushSubscription, name: PushEncryptionKeyName): string {
	const value = subscription.getKey(name);
	if (!value) throw new Error(`The browser gave no ${name} key`);
	return toBase64Url(new Uint8Array(value));
}

/** Closes notifications already showing, so an account's mail doesn't stay on screen once it signs out. */
export async function clearNotifications(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	const registration = await navigator.serviceWorker.getRegistration();
	for (const notification of (await registration?.getNotifications()) ?? []) notification.close();
}

/** The page a clicked notification asks this tab to open (public/sw.js), if the message is one. */
export function notificationTarget(data: unknown): string | null {
	if (typeof data !== "object" || data === null || !("type" in data && "url" in data) || data.type !== "open" || typeof data.url !== "string") return null;
	return data.url.startsWith("/") && new URL(data.url, location.origin).origin === location.origin ? data.url : null;
}
