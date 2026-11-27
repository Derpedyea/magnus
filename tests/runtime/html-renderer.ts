import { renderEmailHtml } from "../../worker/html";

export default {
	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("POST only", { status: 405 });
		const source = new Response(await request.text()).body;
		if (!source) return new Response("Missing body", { status: 400 });
		return renderEmailHtml(source, {
			attachments: [],
			attachmentUrl: (id) => `/attachments/${id}`,
			remoteUrl: (url) => `/remote-image?url=${encodeURIComponent(url)}`,
			blockTrackers: true,
			origin: "https://magnus.test",
		});
	},
};
