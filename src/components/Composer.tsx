import {
	type Address,
	type AttachmentMeta,
	formatBytes,
	isValidAddress,
	MAX_UPLOAD_BYTES,
	type MessageDetail,
	makeSnippet,
	planAttachments,
	type SendAttachmentRef,
} from "#shared";
import { noteBody } from "#shared/markdown";
import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { shallow } from "@tanstack/react-store";
import { ForwardIcon, LinkIcon, PaperclipIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast-manager";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, errorMessage, type Identity } from "../api";
import { closeDraft, compose, openDraft, withSignature } from "../compose";
import { normalizeMarkdown } from "../markdown";
import { currentSession } from "../session";
import { MarkdownEditor } from "./MarkdownEditor";
import { RecipientField } from "./RecipientField";
import { toastUndoSend } from "./UndoToast";

export interface Draft {
	/** Mailbox that uploads, sends, and (for replies) owns the thread. Follows the chosen From identity. */
	mailboxId: string;
	from: string;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	/** Markdown (components/MarkdownEditor.tsx). */
	text: string;
	attachments: SendAttachmentRef[];
	replyToMessageId?: string;
	/** The message being forwarded and which of its files go along. The server adds it below the text as it is. */
	forward?: { message: MessageDetail; files: AttachmentMeta[] };
}

const UNDO_SECONDS = 10;

export function Composer(props: {
	/** Every identity the user can send as, across mailboxes. */
	identities: Identity[];
	/** This opening (compose.ts). A send outlives it: the draft can be closed, or another opened, while it goes. */
	id: number;
	initial: Draft;
	/** Came back through Undo or Reopen (compose.ts). */
	restored: boolean;
}) {
	const qc = useQueryClient();
	const close = () => closeDraft(props.id);
	const send = useMutation({
		mutationFn: (draft: Draft) =>
			api.send(draft.mailboxId, {
				from: draft.from,
				to: draft.to,
				cc: draft.cc,
				bcc: draft.bcc,
				subject: draft.subject,
				text: draft.text,
				replyToMessageId: draft.replyToMessageId,
				forward: draft.forward && {
					messageId: draft.forward.message.id,
					attachmentIds: draft.forward.files.map((f) => f.id),
					timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				},
				attachments: draft.attachments,
				delaySeconds: UNDO_SECONDS,
			}),
		onMutate: currentSession,
		onSuccess: (queued, draft, session) => {
			if (session !== currentSession()) return;
			// The live socket reports this too, but it may be reconnecting.
			void qc.invalidateQueries({ queryKey: ["mail"] });
			// Whoever this went to is suggested next time.
			void qc.invalidateQueries({ queryKey: ["contacts"] });
			close();
			toastUndoSend(queued, draft, qc);
		},
		// The form shows it while it's open. Once it isn't, this is all that's left of the draft.
		onError: (error, draft, session) => {
			if (session === currentSession() && compose.state?.id !== props.id) toastReopen(draft, `Couldn't send: ${errorMessage(error)}`);
		},
	});
	const form = useForm({ defaultValues: props.initial, onSubmit: ({ value }) => send.mutate(value) });
	// Set once this draft gives way to another with an upload still going, so the upload finishes it (see below).
	const gaveWay = useRef(false);
	// Uploads only feed the draft's own attachment list; no cached query reads them.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const upload = useMutation({
		mutationFn: (files: File[]) => {
			const tooBig = files.find((f) => f.size > MAX_UPLOAD_BYTES);
			if (tooBig) throw new Error(`Files can be up to ${formatBytes(MAX_UPLOAD_BYTES)}. ${tooBig.name} is ${formatBytes(tooBig.size)}.`);
			return Promise.all(files.map((f) => api.upload(form.getFieldValue("mailboxId"), f)));
		},
		onMutate: currentSession,
		onSuccess: (refs) => form.setFieldValue("attachments", (prev) => [...prev, ...refs]),
		// Outlives the composer: a draft that gave way mid-upload is offered back once its files are in, or failed.
		onSettled: (_refs, error, _files, session) => {
			if (!gaveWay.current || session !== currentSession()) return;
			toastReopen(form.state.values, error ? `Draft closed. Couldn't attach: ${errorMessage(error)}` : undefined);
		},
	});
	// Opening another draft takes this one's place, so what was typed here, or brought back, and not sent stays a
	// click away. Close throws it out, as before.
	const unsent = send.isIdle || send.isError;
	const uploading = upload.isPending;
	useEffect(
		() => () => {
			const open = compose.state;
			if (!unsent || !open || open.id === props.id) return;
			if (uploading) gaveWay.current = true;
			else if (props.restored || form.state.isDirty) toastReopen(form.state.values);
		},
		[unsent, uploading, form, props.id, props.restored],
	);
	const [showCc, setShowCc] = useState(props.initial.cc.length + props.initial.bcc.length > 0);
	const filePicker = useRef<HTMLInputElement>(null);
	const mailboxId = useSelector(form.store, (s) => s.values.mailboxId);
	// Replies, forwards, and uploads belong to one mailbox, so From can't move them to another.
	const pinned = useSelector(form.store, (s) => Boolean(s.values.replyToMessageId || s.values.forward) || s.values.attachments.length > 0);
	// Same split the server makes on send: whatever doesn't fit in the message goes as a download link. A forward's
	// HTML isn't loaded here, so a file right at the limit may still go as a link.
	const linked = new Set(
		useSelector(form.store, (s) => {
			const forward = s.values.forward;
			const files = [...s.values.attachments, ...(forward?.files ?? [])];
			if (files.length === 0) return [];
			const note = noteBody(s.values.text);
			const body = { text: note.text + (forward?.message.text ?? ""), html: note.html };
			const embedded = forward?.message.hasHtml ? forward.message.attachments.reduce((n, a) => n + (a.inline && a.contentId ? a.size : 0), 0) : 0;
			return planAttachments(files, body, `${location.origin}/f/${s.values.mailboxId}/`, embedded).linked.map(fileKey);
		}),
	);
	const fromOptions = pinned ? props.identities.filter((i) => i.mailboxId === mailboxId) : props.identities;
	const key = (mailboxId: string, address: string) => `${mailboxId}/${address}`;
	const error = send.error ?? upload.error;
	// Anyone in To, Cc, or Bcc isn't suggested for another.
	const recipients = useSelector(form.store, (s) => [...s.values.to, ...s.values.cc, ...s.values.bcc], { compare: shallow });
	const taken = new Set(recipients.map((a) => a.address.toLowerCase()));

	const recipientField = (name: "to" | "cc" | "bcc", label: string, after?: ReactNode) => (
		<form.Field
			name={name}
			validators={{
				onChange: ({ value }) => invalidAddresses(value),
				onSubmit: ({ value }) => (name === "to" && value.length === 0 ? "Add a recipient" : invalidAddresses(value)),
			}}
		>
			{(f) => (
				<>
					<RecipientField
						label={label}
						value={f.state.value}
						onChange={f.handleChange}
						onBlur={f.handleBlur}
						taken={taken}
						invalid={!f.state.meta.isValid}
						// A new message starts at To; one reopened by Undo, at its text.
						autoFocus={name === "to" && !props.initial.replyToMessageId && props.initial.to.length === 0}
					>
						{after}
					</RecipientField>
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
				<span className="font-medium">{props.initial.forward ? "Forward" : props.initial.replyToMessageId ? "Reply" : "New message"}</span>
				<Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close">
					<XIcon />
				</Button>
			</div>
			<form.Field name="from">
				{(f) => (
					<div className="flex items-center border-b pl-3 focus-within:border-ring">
						<span className="w-9 shrink-0 text-muted-foreground">From</span>
						<Select
							items={fromOptions.map((i) => ({ value: key(i.mailboxId, i.address), label: identityLabel(i) }))}
							value={key(mailboxId, f.state.value)}
							onValueChange={(value) => {
								const picked = fromOptions.find((i) => key(i.mailboxId, i.address) === value);
								if (!picked) return;
								const current = props.identities.find((i) => i.mailboxId === mailboxId && i.address === f.state.value);
								form.setFieldValue("text", (text) => withSignature(text, current?.signature ?? null, picked.signature, normalizeMarkdown));
								form.setFieldValue("mailboxId", picked.mailboxId);
								f.handleChange(picked.address);
							}}
						>
							<SelectTrigger aria-label="From" className="h-9 flex-1 rounded-none border-0 pr-3 pl-0 focus-visible:ring-0 data-[size=default]:h-9 dark:bg-transparent">
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
					</div>
				)}
			</form.Field>
			{recipientField(
				"to",
				"To",
				showCc ? null : (
					<Button variant="ghost" size="xs" onClick={() => setShowCc(true)} className="mt-1.5 text-muted-foreground">
						Cc/Bcc
					</Button>
				),
			)}
			{showCc ? (
				<>
					{recipientField("cc", "Cc")}
					{recipientField("bcc", "Bcc")}
				</>
			) : null}
			<form.Field name="subject">
				{(f) => <Input value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} placeholder="Subject" className={FIELD} />}
			</form.Field>
			<form.Field name="text">
				{(f) => (
					<MarkdownEditor
						value={f.state.value}
						onChange={f.handleChange}
						aria-label="Message"
						// The height of 14 lines, or 8 above a forward.
						className={cn("overflow-y-auto px-3 py-2.5 text-base md:text-sm", props.initial.forward ? "h-45" : "h-75")}
						autoFocus={!props.initial.replyToMessageId && props.initial.to.length > 0}
					/>
				)}
			</form.Field>
			{props.initial.forward ? <Forwarded message={props.initial.forward.message} /> : null}
			<ul className="flex flex-wrap gap-1.5 px-3 pb-2 empty:hidden">
				<form.Field name="forward">
					{(f) =>
						f.state.value?.files.map((a) => (
							<FileChip
								key={a.id}
								file={a}
								linked={linked.has(a.id)}
								onRemove={() => f.handleChange((prev) => prev && { ...prev, files: prev.files.filter((x) => x !== a) })}
							/>
						))
					}
				</form.Field>
				<form.Field name="attachments">
					{(f) =>
						f.state.value.map((a) => (
							<FileChip key={a.r2Key} file={a} linked={linked.has(a.r2Key)} onRemove={() => f.handleChange((prev) => prev.filter((x) => x !== a))} />
						))
					}
				</form.Field>
			</ul>
			{error ? <p className="px-3 pb-2 text-destructive">{error.message}</p> : null}
			<div className="flex items-center gap-1 border-t px-3 py-2">
				<form.Subscribe selector={(s) => s.values.from !== ""}>
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

/** The forwarded message, which goes below the note untouched: who it's from and how it starts. */
function Forwarded({ message: m }: { message: MessageDetail }) {
	const snippet = makeSnippet(m.text);
	return (
		<blockquote className="mx-3 mb-3 border-l-2 pl-3 text-xs text-muted-foreground">
			<p className="flex items-center gap-1.5">
				<ForwardIcon className="size-3.5 shrink-0" />
				<span className="truncate">
					<span className="font-medium text-foreground">{m.from.name || m.from.address}</span> · {new Date(m.date).toLocaleString()}
				</span>
			</p>
			{snippet ? <p className="mt-1 line-clamp-2">{snippet}</p> : null}
		</blockquote>
	);
}

function FileChip(props: { file: { filename: string; size: number }; linked: boolean; onRemove: () => void }) {
	return (
		<li>
			<Badge variant="secondary" className="h-6 pr-0.5">
				{props.linked ? <LinkIcon data-icon="inline-start" aria-label="Sent as a link" /> : null}
				{props.file.filename} <span className="text-muted-foreground">{formatBytes(props.file.size)}</span>
				<Button variant="ghost" size="icon-xs" className="size-5 rounded-full" aria-label={`Remove ${props.file.filename}`} onClick={props.onRemove}>
					<XIcon />
				</Button>
			</Badge>
		</li>
	);
}

/** Uploads are told apart by storage key, a forward's files by id. */
const fileKey = (f: SendAttachmentRef | AttachmentMeta) => ("r2Key" in f ? f.r2Key : f.id);

const identityLabel = (i: Identity) => (i.displayName ? `${i.displayName} <${i.address}>` : i.address);

/** Borderless rows split by rules, so the header fields read as one sheet. */
const FIELD = "h-9 rounded-none border-0 border-b px-3 focus-visible:border-ring focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent";

/** Field error for a recipient list, or undefined when every entry is an address. */
function invalidAddresses(list: Address[]): string | undefined {
	const bad = list.filter((a) => !isValidAddress(a.address));
	return bad.length ? `Not an email address: ${bad.map((a) => a.address).join(", ")}` : undefined;
}

/**
 * For a draft that's no longer open, and held nowhere else. With an `error`, it stays until dismissed; otherwise as
 * long as an Undo would. Reopening it takes the place of whatever draft is open.
 */
function toastReopen(draft: Draft, error?: string) {
	const id = toast.add({
		title: error ?? "Draft closed",
		type: error ? "error" : undefined,
		timeout: error ? 0 : UNDO_SECONDS * 1000,
		actionProps: {
			children: "Reopen",
			onClick: () => {
				toast.close(id);
				openDraft(draft, true);
			},
		},
	});
}
