import { type AttachmentMeta, formatBytes, type PreviewKind } from "#shared";
import { DownloadIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";

const ON_DARK = "text-white hover:bg-white/10 hover:text-white";

/**
 * Full-screen preview of a file the browser can show (see preview() in shared/files.ts), after Gmail's viewer:
 * name and Download on top, the file on a dark stage. `url` serves it inline; `?download=1` downloads it.
 * The stage ignores the pointer (only the bar and the file take it), so a click around the file lands on the
 * dialog's backdrop and closes it, like any lightbox.
 */
export function FileViewer(props: {
	file: AttachmentMeta;
	kind: PreviewKind;
	url: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { file, url } = props;
	// Focus the viewer itself rather than its first button, so nothing opens looking selected.
	const popup = useRef<HTMLDivElement>(null);
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent
				ref={popup}
				initialFocus={popup}
				showCloseButton={false}
				className="pointer-events-none flex h-dvh w-screen max-w-none flex-col gap-0 rounded-none bg-black/95 p-0 text-white ring-0 sm:max-w-none"
			>
				<div className="pointer-events-auto flex items-center gap-2 py-3 pr-3 pl-5">
					<DialogTitle className="min-w-0 flex-1 truncate font-sans text-base leading-normal">
						{file.filename} <span className="text-white/60">{formatBytes(file.size)}</span>
					</DialogTitle>
					<a href={`${url}?download=1`} className={cn(buttonVariants({ variant: "ghost" }), ON_DARK)}>
						<DownloadIcon />
						Download
					</a>
					<DialogClose render={<Button variant="ghost" size="icon-lg" aria-label="Close" className={ON_DARK} />}>
						<XIcon className="size-5" />
					</DialogClose>
				</div>
				<div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0 *:pointer-events-auto">
					<Preview kind={props.kind} url={url} filename={file.filename} />
				</div>
			</DialogContent>
		</Dialog>
	);
}

function Preview(props: { kind: PreviewKind; url: string; filename: string }) {
	const [failed, setFailed] = useState(false);
	const fail = () => setFailed(true);
	if (failed) return <p className="text-sm text-white/70">Your browser can't show this file. Download it to open it.</p>;
	switch (props.kind) {
		case "image":
			return <img src={props.url} alt={props.filename} onError={fail} className="max-h-full max-w-full rounded-md object-contain" />;
		case "video":
			return <video src={props.url} controls playsInline onError={fail} className="max-h-full max-w-full rounded-md" />;
		case "audio":
			return <audio src={props.url} controls onError={fail} className="w-full max-w-md" />;
		case "pdf":
			// The response is sandboxed by its own CSP (worker/html.ts). Chrome won't show a PDF in an iframe that has
			// a sandbox attribute at all, even with allow-scripts and allow-same-origin.
			// react-doctor-disable-next-line react-doctor/iframe-missing-sandbox
			return <iframe src={props.url} title={props.filename} className="size-full max-w-5xl rounded-md bg-white" />;
	}
}
