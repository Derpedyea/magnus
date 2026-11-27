function editable(target: EventTarget | null): boolean {
	const closest = (target as { closest?: unknown } | null)?.closest;
	return typeof closest === "function" && closest.call(target, "input,textarea,select,[contenteditable]") !== null;
}

export function forwardKey(frame: HTMLIFrameElement, event: KeyboardEvent) {
	if (editable(event.target)) return;
	if (!frame.dispatchEvent(new KeyboardEvent(event.type, event))) event.preventDefault();
}
