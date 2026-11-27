/**
 * Spotting tracking pixels in mail, so remote images can show while the ones that report opens don't load.
 * Two signals: an image nobody could see (tiny or hidden), and an address on a known open-tracking service.
 * Best effort: a pixel on an unknown service, sized normally, still loads (through the proxy, so only the time it
 * was opened leaks, not the reader's address).
 */

/** Matched against `host/path`, lowercased. Open-tracking endpoints of mail services, and sales tools' pixels. */
const TRACKER_URLS = [
	/(^|\.)list-manage\.com\/track\/open/, // Mailchimp
	/(^|\.)mandrillapp\.com\/track\/open/, // Mandrill
	/\/wf\/open\b/, // SendGrid, on its own hosts and senders' branded ones
	/(^|\.)awstrack\.me\//, // Amazon SES
	/(^|\.)pstmrk\.it\/open\b/, // Postmark
	/^email\.[^/]+\/o\//, // Mailgun's tracking subdomain
	/(^|\.)(spgo\.io|sparkpostmail\.com)\/q\//, // SparkPost
	/(^|\.)mjt\.lu\/oo?\//, // Mailjet
	/\/tr\/op\//, // Brevo (Sendinblue)
	/\/e\/o\//, // Customer.io
	/(^|\.)via\.intercom\.io\/o\//, // Intercom
	/\/e2t\/to\//, // HubSpot
	/(^|\.)(sidekickopen\d*|signaux\w*|senal\w*)\.(com|net)\//, // HubSpot Sales
	/\/open\.aspx\b/, // Salesforce Marketing Cloud
	/(^|\.)rs6\.net\/on\.jsp/, // Constant Contact
	/(^|\.)emltrk\.com\//, // Litmus
	/(^|\.)mailtrack\.io\/trace/,
	/(^|\.)mailfoogae\.appspot\.com\//, // Streak
	/(^|\.)t\.yesware\.com\//,
	/(^|\.)bananatag\.com\//,
	/(^|\.)getnotify\.com\//,
	/(^|\.)mixmax\.com\/api\/track/,
	/(^|\.)r\.superhuman\.com\//,
	/(^|\.)getmailspring\.com\/open\//,
	/(^|\.)google-analytics\.com\/(g\/)?collect/,
	/(^|\.)facebook\.com\/tr\b/,
	/(^|\.)linkedin\.com\/emimp\//,
	// Anything else named for what it does.
	/\/(track|tracking|trk)\/open/,
	/\/(open|opened|track|tracking|trk|beacon|pixel|1x1|o)\.(gif|png|php|aspx|jsp)$/,
	/\/(open|beacon|pixel)$/,
];

/** Whether a remote image's address is a known open-tracking endpoint. */
export function isTrackerUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const target = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
	return TRACKER_URLS.some((pattern) => pattern.test(target));
}

/** A length in pixels from an attribute or CSS value (`1`, `1px`, `0.5px`), or null for anything else. */
const pixels = (value: string | null | undefined): number | null => {
	const m = value?.trim().match(/^(\d+(?:\.\d+)?)(px)?$/i);
	return m ? Number(m[1]) : null;
};

const cssValue = (style: string, property: string) => style.match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;!]+)`, "i"))?.[1];

/** Whether an <img> is laid out so nobody could see it: a pixel's size, or hidden outright. */
export function isInvisibleImage(attr: (name: string) => string | null): boolean {
	const style = attr("style") ?? "";
	const width = pixels(cssValue(style, "width")) ?? pixels(attr("width"));
	const height = pixels(cssValue(style, "height")) ?? pixels(attr("height"));
	if (width === 0 || height === 0) return true;
	// 1×1 and its kin; a single known side of 1px is no picture either. A 600×1 divider still shows.
	if (width !== null && height !== null ? width <= 2 && height <= 2 : (width ?? height ?? Infinity) <= 1) return true;
	if (/^none\b/i.test(cssValue(style, "display")?.trim() ?? "")) return true;
	if (/^hidden\b/i.test(cssValue(style, "visibility")?.trim() ?? "")) return true;
	if (/^(0+(\.0*)?|\.0+)$/.test(cssValue(style, "opacity")?.trim() ?? "")) return true;
	return pixels(cssValue(style, "max-width")) === 0 || pixels(cssValue(style, "max-height")) === 0;
}
