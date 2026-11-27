import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture, type Fixture, inbound } from "./runtime/fixture";

const proxied = (url: string) => `/api/remote-image?url=${encodeURIComponent(url)}`;

describe("Remote images in mail", () => {
	let f: Fixture;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });

	async function body(html: string, query = "") {
		const ids = await f.seed();
		const cookie = await f.login("alice");
		const message = inbound(ids.alice);
		await f.env.MAIL.put(message.htmlKey!, html);
		await f.env.MAILBOX.getByName(ids.alice).ingest(message);
		const response = await f.worker.fetch(`https://magnus.test/api/mailboxes/${ids.alice}/messages/${message.id}/body${query}`, { headers: { Cookie: cookie } });
		expect(response.headers.get("Content-Security-Policy")).toContain("img-src https://magnus.test data:;");
		return response.text();
	}

	it("shows pictures through the proxy and blocks tracking pixels", async () => {
		const html = await body(`
			<style>.hero { background: url('https://cdn.shop.test/hero.jpg') } .t { background-image: url(https://x.list-manage.com/track/open.php?u=1) }</style>
			<img src="https://cdn.shop.test/logo.png" srcset="https://cdn.shop.test/logo@2x.png 2x, http://cdn.shop.test/a.png 3x">
			<img src="//cdn.shop.test/relative.png">
			<img src="https://cdn.shop.test/p.gif?id=42" width="1" height="1">
			<img src="https://cdn.shop.test/hidden.png" style="display:none">
			<img src="https://u1.ct.sendgrid.net/wf/open?upn=abc">
			<td background="https://cdn.shop.test/bg.png" style="background-image:url(&quot;https://cdn.shop.test/cell.png&quot;)"></td>
			<img src="https://cdn.shop.test/fake.png" data-blocked-src="x">
			<img src="https://cdn.shop.test/q.png?a=1&amp;b=2" style="font-family: &quot;Arial&quot;; width: 100px">
			<p style='font-family: "Georgia"; background: url(https://cdn.shop.test/p&amp;q.png)'>
			<img width="1" height="1" srcset="https://cdn.shop.test/only-srcset.gif 1x">
			<picture><source srcset="https://cdn.shop.test/wide.jpg 1x,https://cdn.shop.test/wide@2x.jpg 2x"></picture>`);
		expect(html).toContain(`url("${proxied("https://cdn.shop.test/hero.jpg")}")`);
		expect(html).toContain(".t { background-image: none }");
		expect(html).toContain(`src="${proxied("https://cdn.shop.test/logo.png")}"`);
		expect(html).toContain(`srcset="${proxied("https://cdn.shop.test/logo@2x.png")} 2x, ${proxied("http://cdn.shop.test/a.png")} 3x"`);
		expect(html).toContain(`src="${proxied("https://cdn.shop.test/relative.png")}"`);
		expect(html).toContain(`background="${proxied("https://cdn.shop.test/bg.png")}"`);
		expect(html).toContain(proxied("https://cdn.shop.test/cell.png"));
		// The mail's own data-blocked-src is dropped, so only real blocks count.
		expect(html).toContain(`src="${proxied("https://cdn.shop.test/fake.png")}">`);
		expect(html).toContain(`srcset="${proxied("https://cdn.shop.test/wide.jpg")} 1x, ${proxied("https://cdn.shop.test/wide@2x.jpg")} 2x"`);
		// The pixel, the hidden image, SendGrid, the srcset-only pixel, and the tracker in <style>.
		expect(html.match(/data-blocked-src=/g)).toHaveLength(5);
		// Entities in attributes are read as the characters they stand for, and written back escaped.
		expect(html).toContain(`src="${proxied("https://cdn.shop.test/q.png?a=1&b=2")}" style="font-family: &quot;Arial&quot;; width: 100px"`);
		expect(html).toContain(`style="font-family: &quot;Georgia&quot;; background: url(&quot;${proxied("https://cdn.shop.test/p&q.png")}&quot;)"`);
		for (const tracker of ["https://cdn.shop.test/p.gif?id=42", "https://cdn.shop.test/hidden.png", "https://u1.ct.sendgrid.net/wf/open?upn=abc", "https://cdn.shop.test/only-srcset.gif"]) expect(html).not.toContain(proxied(tracker));
		expect(html).not.toMatch(/\ssrc="https?:/);
	});

	it("loads trackers too once the reader asks", async () => {
		const html = await body(`<img src="https://cdn.shop.test/p.gif" width="1" height="1">`, "?images=1");
		expect(html).toContain(`src="${proxied("https://cdn.shop.test/p.gif")}"`);
		expect(html).not.toContain("data-blocked-src");
	});

	it("proxies only for a signed-in reader, and only public http(s) addresses", async () => {
		const image = (url: string, cookie = "") => f.worker.fetch(`https://magnus.test${proxied(url)}`, { headers: { Cookie: cookie } });
		expect((await image("https://cdn.shop.test/logo.png")).status).toBe(401);
		const cookie = await f.login("alice");
		for (const url of ["http://localhost/x.png", "http://127.0.0.1/x.png", "http://[::1]/x.png", "https://cdn.shop.test:8080/x.png", "file:///etc/passwd", "https://printer.local/x.png"]) {
			expect((await image(url, cookie)).status, url).toBe(502);
		}
	});
});
