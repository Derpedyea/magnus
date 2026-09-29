import { formatBytes, isValidAddress, MAX_UPLOAD_BYTES, planAttachments, type SendAttachmentRef } from "#shared";
import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LinkIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, type Identity, parseAddressList } from "../api";
import { toastUndoSend } from "./UndoToast";

export interface Draft {
	/** Mailbox that uploads, sends, and (for replies) owns the thread. Follows the chosen From identity. */
	mailboxId: string;
	from: string;
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	text: string;
	attachments: SendAttachmentRef[];
	replyToMessageId?: string;
}

const UNDO_SECONDS = 10;

export function Composer(props: {
	/** Every identity the user can send as, across mailboxes. */
	identities: Identity[];
	initial: Draft;
	onClose: () => void;
}) {
	const qc = useQueryClient();
	const send = useMutation({
		mutationFn: (draft: Draft) =>
			api.send(draft.mailboxId, {
				from: draft.from,
				to: parseAddressList(draft.to),
				cc: parseAddressList(draft.cc),
				bcc: parseAddressList(draft.bcc),
				subject: draft.subject,
				text: draft.text,
				replyToMessageId: draft.replyToMessageId,
				attachments: draft.attachments,
				delaySeconds: UNDO_SECONDS,
			}),
		onSuccess: (queued, draft) => {
			// The live socket reports this too, but it may be reconnecting.
			void qc.invalidateQueries({ queryKey: ["mail"] });
			props.onClose();
			toastUndoSend(queued, draft, qc);
		},
	});
	const form = useForm({ defaultValues: props.initial, onSubmit: ({ value }) => send.mutate(value) });
	// Uploads only feed the draft's own attachment list; no cached query reads them.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const upload = useMutation({
		mutationFn: (files: File[]) => {
			const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
			if (tooBig) throw new Error(`Files can be up to ${formatBytes(MAX_UPLOAD_BYTES)}. ${tooBig.name} is ${formatBytes(tooBig.size)}.`);
			return Promise.all(files.map((f) => api.upload(form.getFieldValue("mailboxId"), f)));
		},
		onSuccess: (refs) => form.setFieldValue("attachments", (prev) => [...prev, ...refs]),
	});
	const [showCc, setShowCc] = useState(Boolean(props.initial.cc || props.initial.bcc));
	const filePicker = useRef<HTMLInputElement>(null);
	const mailboxId = useSelector(form.store, (s) => s.values.mailboxId);
	// Replies and uploads belong to one mailbox, so From can't move them to another.
	const pinned = useSelector(form.store, (s) => Boolean(s.values.replyToMessageId) || s.values.attachments.length > 0);
	// Same split the server makes on send: whatever doesn't fit in the message goes as a download link.
	const linked = new Set(
		useSelector(form.store, (s) =>
			planAttachments(s.values.attachments, { text: s.values.text }, `${location.origin}/f/${s.values.mailboxId}/`).linked.map((a) => a.r2Key),
		),
	);
	const fromOptions = pinned ? props.identities.filter((i) => i.mailboxId === mailboxId) : props.identities;
	const key = (mailboxId: string, address: string) => `${mailboxId}/${address}`;
	const error = send.error ?? upload.error;

	const addressField = (name: "to" | "cc" | "bcc", placeholder: string, after?: React.ReactNode) => (
		<form.Field name={name} validators={{ onBlur: ({ value }) => invalidAddresses(value) }}>
			{(f) => (
				<>
					<div className="flex items-center border-b pr-2">
						<Input
							value={f.state.value}
							onChange={(e) => f.handleChange(e.target.value)}
							onBlur={f.handleBlur}
							placeholder={placeholder}
							aria-invalid={!f.state.meta.isValid}
							className={cn(FIELD, "border-b-0")}
						/>
						{after}
					</div>
					{f.state.meta.isValid ? null : <FieldError className="border-b px-3 py-1 text-xs">{f.state.meta.errors.join(", ")}</FieldError>}
				</>
			)}
		</form.Field>
	);

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void form.handleSubmit();
			}}
			className="fixed right-6 bottom-0 z-30 flex w-[36rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-t-xl border bg-popover text-popover-foreground shadow-2xl"
		>
			<div className="flex items-center justify-between border-b bg-muted/50 py-1 pr-1 pl-3">
				<span className="font-medium">{props.initial.replyToMessageId ? "Reply" : "New message"}</span>
				<Button variant="ghost" size="icon-sm" onClick={props.onClose} aria-label="Close">
					<XIcon />
				</Button>
			</div>
			<form.Field name="from">
				{(f) => (
					<Select
						items={fromOptions.map((i) => ({ value: key(i.mailboxId, i.address), label: identityLabel(i) }))}
						value={key(mailboxId, f.state.value)}
						onValueChange={(value) => {
							const picked = fromOptions.find((i) => key(i.mailboxId, i.address) === value);
							if (!picked) return;
							form.setFieldValue("mailboxId", picked.mailboxId);
							f.handleChange(picked.address);
						}}
					>
						<SelectTrigger aria-label="From" className={cn(FIELD, "w-full pr-3 data-[size=default]:h-9")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{fromOptions.map((i) => (
								<SelectItem key={key(i.mailboxId, i.address)} value={key(i.mailboxId, i.address)}>
									{identityLabel(i)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</form.Field>
			{addressField(
				"to",
				"To",
				showCc ? null : (
					<Button variant="ghost" size="xs" onClick={() => setShowCc(true)} className="text-muted-foreground">
						Cc/Bcc
					</Button>
				),
			)}
			{showCc ? (
				<>
					{addressField("cc", "Cc")}
					{addressField("bcc", "Bcc")}
				</>
			) : null}
			<form.Field name="subject">
				{(f) => <Input value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder="Subject" className={FIELD} />}
			</form.Field>
			<form.Field name="text">
				{(f) => (
					<Textarea
						value={f.state.value}
						onChange={(e) => f.handleChange(e.target.value)}
						rows={14}
						aria-label="Message"
						className="resize-none rounded-none border-0 px-3 py-2.5 field-sizing-fixed focus-visible:ring-0 dark:bg-transparent"
						autoFocus={!props.initial.replyToMessageId}
					/>
				)}
			</form.Field>
			<form.Field name="attachments">
				{(f) =>
					f.state.value.length > 0 ? (
						<ul className="flex flex-wrap gap-1.5 px-3 pb-2">
							{f.state.value.map((a) => (
								<li key={a.r2Key}>
									<Badge variant="secondary" className="h-6 pr-0.5">
										{linked.has(a.r2Key) ? <LinkIcon data-icon="inline-start" aria-label="Sent as a link" /> : null}
										{a.filename} <span className="text-muted-foreground">{formatBytes(a.size)}</span>
										<Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={`Remove ${a.filename}`} onClick={() => f.handleChange((prev) => prev.filter((x) => x !== a))}>
											<XIcon />
										</Button>
									</Badge>
								</li>
							))}
						</ul>
					) : null
				}
			</form.Field>
			{error ? <p className="px-3 pb-2 text-destructive">{error.message}</p> : null}
			<div className="flex items-center gap-1 border-t px-3 py-2">
				<form.Subscribe selector={(s) => s.values.to.trim() !== "" && s.values.from !== ""}>
					{(ready) => (
						<Button type="submit" disabled={!ready || send.isPending || upload.isPending} className="mr-1 px-4">
							{send.isPending ? <Spinner data-icon="inline-start" /> : null}
							Send
						</Button>
					)}
				</form.Subscribe>
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="ghost" size="icon" aria-label="Attach files" disabled={upload.isPending} onClick={() => filePicker.current?.click()}>
								{upload.isPending ? <Spinner /> : <PaperclipIcon />}
							</Button>
						}
					/>
					<TooltipContent>Attach files</TooltipContent>
				</Tooltip>
				<input ref={filePicker} type="file" multiple hidden onChange={(e) => e.target.files?.length && upload.mutate([...e.target.files])} />
				{linked.size > 0 ? (
					<span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
						<LinkIcon className="size-3 shrink-0" />
						Too big to attach, so sent as {linked.size === 1 ? "a link" : "links"}
					</span>
				) : null}
			</div>
		</form>
	);
}

const identityLabel = (i: Identity) => (i.displayName ? `${i.displayName} <${i.address}>` : i.address);

/** Borderless rows split by rules, so the header fields read as one sheet. */
const FIELD = "h-9 rounded-none border-0 border-b px-3 focus-visible:border-ring focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent";

/** Field error for a comma-separated address list, or undefined when every entry is an address. */
function invalidAddresses(value: string): string | undefined {
	const bad = parseAddressList(value).filter((a) => !isValidAddress(a.address));
	return bad.length ? `Not an email address: ${bad.map((a) => a.address).join(", ")}` : undefined;
}
