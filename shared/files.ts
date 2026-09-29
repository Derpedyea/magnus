/** Decimal units, like Finder and the Files app: 176 KB, 12.8 MB. */
export function formatBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
	return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`;
}

/**
 * What browsers can show without running anything from the file, by extension, so attachments labelled
 * application/octet-stream (common in mail) still preview. HTML and SVG are left out on purpose: they can script.
 */
const PREVIEWABLE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	mp4: "video/mp4",
	m4v: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	wav: "audio/wav",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	flac: "audio/flac",
	pdf: "application/pdf",
};
const SAFE_TYPES = new Set(Object.values(PREVIEWABLE));

export type PreviewKind = "image" | "video" | "audio" | "pdf";

/**
 * How to show a file inline, or null if it only downloads. `type` is what to serve it as: always one from the
 * list above, never the sender's own label, so a script can't pass as a picture.
 */
export function preview(file: { contentType: string; filename: string }): { type: string; kind: PreviewKind } | null {
	const labelled = file.contentType.toLowerCase().split(";")[0]!.trim();
	const extension = /\.([a-z0-9]+)$/i.exec(file.filename)?.[1]?.toLowerCase() ?? "";
	const type = SAFE_TYPES.has(labelled) ? labelled : PREVIEWABLE[extension];
	if (!type) return null;
	const [major] = type.split("/");
	return { type, kind: major === "image" || major === "video" || major === "audio" ? major : "pdf" };
}
