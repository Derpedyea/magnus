import { type Editor, Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { Node, Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { BoldIcon, CodeIcon, ItalicIcon, LinkIcon, ListIcon, ListOrderedIcon, type LucideIcon, QuoteIcon, StrikethroughIcon, UnlinkIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { markdownExtensions, parseMarkdown, serializeMarkdown } from "../markdown";

/**
 * Rich text that's markdown underneath (src/markdown.ts), for mail and signatures. Formatting shows as you write,
 * from markdown itself ("**", "- ", "> "), the usual shortcuts, or the bubble over a selection. `value` and
 * `onChange` carry markdown; `className` styles the editable area.
 */
export function MarkdownEditor({
	value,
	onChange,
	onBlur,
	placeholder,
	autoFocus,
	className,
	"aria-label": label,
	"aria-labelledby": labelledBy,
	"aria-invalid": invalid,
}: {
	value: string;
	onChange: (markdown: string) => void;
	onBlur?: () => void;
	placeholder?: string;
	/** Puts the cursor at the start, above any signature or quote. */
	autoFocus?: boolean;
	className?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	"aria-invalid"?: boolean;
}) {
	// What the editor holds, so our own edit coming back as `value` doesn't reset it.
	const held = useRef(value);
	const [content] = useState(() => parseMarkdown(value));
	// Tiptap applies options again whenever one changes identity, so these only change with what's in them.
	const extensions = useMemo(() => [...markdownExtensions, PlainTextLines, Placeholder.configure({ placeholder })], [placeholder]);
	const editorProps = useMemo(() => {
		const attributes: Record<string, string> = { role: "textbox", "aria-multiline": "true", class: cn("markdown-editor outline-none", className) };
		if (label) attributes["aria-label"] = label;
		if (labelledBy) attributes["aria-labelledby"] = labelledBy;
		if (invalid) attributes["aria-invalid"] = "true";
		return {
			attributes,
			// Pasted text is markdown too, so its line breaks and formatting come in the way they'd be sent.
			clipboardTextParser: (text: string, _at: unknown, _plain: boolean, view: EditorView) =>
				Slice.maxOpen(Node.fromJSON(view.state.schema, parseMarkdown(text)).content),
		};
	}, [className, label, labelledBy, invalid]);
	const editor = useEditor({
		extensions,
		content,
		autofocus: autoFocus ? "start" : false,
		editorProps,
		onUpdate: ({ editor, transaction }) => {
			// Only edits. A plugin tidying the document (the paragraph Tiptap adds after a closing quote) isn't one, and would
			// send back what the editor held before a change from outside had reached it.
			if (!transaction.docChanged) return;
			held.current = serializeMarkdown(editor.getJSON());
			onChange(held.current);
		},
		onBlur: () => onBlur?.(),
	});

	// Changes from outside (From swapping the signature, a save trimming it) replace what's shown.
	useEffect(() => {
		if (value === held.current) return;
		held.current = value;
		editor.commands.setContent(parseMarkdown(value), { emitUpdate: false });
	}, [editor, value]);

	return (
		<>
			<EditorContent editor={editor} />
			<Formatting editor={editor} />
		</>
	);
}

/**
 * Enter starts a new line and a second Enter a new paragraph, as when typing plain-text mail (and in HEY's editor).
 * They're markdown's line breaks and blank lines, so the message keeps the lines it was written with, and a second
 * Enter in a quote leaves it, as a blank line does in markdown. Backspace at the start of a paragraph undoes that
 * second Enter. Lists keep their usual keys.
 */
const PlainTextLines = Extension.create({
	name: "plainTextLines",
	// Ahead of the default Enter, which would start a paragraph every time.
	priority: 1000,
	addKeyboardShortcuts() {
		return {
			Enter: ({ editor }) => {
				const { $from, empty } = editor.state.selection;
				// An empty line keeps the default, which is how a quote or list is left.
				if (!empty || $from.parent.type.name !== "paragraph" || $from.node(-1).type.name === "listItem" || $from.parent.content.size === 0) return false;
				if ($from.nodeBefore?.type.name !== "hardBreak") return editor.commands.setHardBreak();
				const at = $from.pos - 1;
				if ($from.node(-1).type.name !== "blockquote") return editor.chain().deleteRange({ from: at, to: $from.pos }).splitBlock().run();
				// A blank line ends a quote in markdown, so the new paragraph leaves it.
				if ($from.parentOffset === $from.parent.content.size) {
					return editor.chain().deleteRange({ from: at, to: $from.pos }).splitBlock().lift("blockquote").run();
				}
				// Mid-quote, the rest stays quoted below (without the line break it started with), and the empty paragraph
				// between them leaves the quote: how you answer between a reply's quoted lines.
				const to = $from.nodeAfter?.type.name === "hardBreak" ? $from.pos + 1 : $from.pos;
				return editor
					.chain()
					.deleteRange({ from: at, to })
					.splitBlock()
					.splitBlock()
					.setTextSelection(at + 2)
					.lift("blockquote")
					.run();
			},
			Backspace: ({ editor }) => {
				const { $from, empty } = editor.state.selection;
				if (!empty || $from.parentOffset !== 0 || $from.parent.type.name !== "paragraph" || $from.parent.content.size === 0) return false;
				const index = $from.index(-1);
				const before = index > 0 ? $from.node(-1).child(index - 1) : null;
				if (before?.type.name !== "paragraph" || before.content.size === 0) return false;
				return editor.chain().joinBackward().setHardBreak().run();
			},
		};
	},
});

const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";
const SHIFT = MOD === "⌘" ? "⇧" : "Shift+";

interface Tool {
	name: string;
	label: string;
	icon: LucideIcon;
	keys?: string;
	run: (editor: Editor) => void;
}

// Tiptap's own shortcuts, shown in each tooltip.
const MARKS: Tool[] = [
	{ name: "bold", label: "Bold", icon: BoldIcon, keys: `${MOD}B`, run: (e) => e.chain().focus().toggleBold().run() },
	{ name: "italic", label: "Italic", icon: ItalicIcon, keys: `${MOD}I`, run: (e) => e.chain().focus().toggleItalic().run() },
	{ name: "strike", label: "Strikethrough", icon: StrikethroughIcon, keys: `${MOD}${SHIFT}S`, run: (e) => e.chain().focus().toggleStrike().run() },
	{ name: "code", label: "Code", icon: CodeIcon, keys: `${MOD}E`, run: (e) => e.chain().focus().toggleCode().run() },
];
const BLOCKS: Tool[] = [
	{ name: "bulletList", label: "Bulleted list", icon: ListIcon, keys: `${MOD}${SHIFT}8`, run: (e) => e.chain().focus().toggleBulletList().run() },
	{ name: "orderedList", label: "Numbered list", icon: ListOrderedIcon, keys: `${MOD}${SHIFT}7`, run: (e) => e.chain().focus().toggleOrderedList().run() },
	{ name: "blockquote", label: "Quote", icon: QuoteIcon, keys: `${MOD}${SHIFT}B`, run: (e) => e.chain().focus().toggleBlockquote().run() },
];
const LINK = { name: "link", label: "Link", icon: LinkIcon };

// Outside the editor's container, which may clip it (the composer does).
const toBody = () => document.body;

/** The bubble over a selection, like Linear's and Notion's: the formatting markdown has, and links. */
function Formatting({ editor }: { editor: Editor }) {
	const [linking, setLinking] = useState(false);
	// Stable: the bubble dispatches a transaction whenever its options change identity.
	const options = useMemo(() => ({ strategy: "fixed" as const, placement: "top" as const, offset: 8, onHide: () => setLinking(false) }), []);
	const state = useEditorState({
		editor,
		selector: ({ editor }) => {
			const href: unknown = editor.getAttributes("link").href;
			return {
				active: new Set([...MARKS, ...BLOCKS].filter((t) => editor.isActive(t.name)).map((t) => t.name)),
				href: typeof href === "string" ? href : "",
			};
		},
	});
	return (
		<BubbleMenu
			editor={editor}
			appendTo={toBody}
			options={options}
			className="z-50 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
		>
			{linking ? (
				<LinkField editor={editor} href={state.href} onDone={() => setLinking(false)} />
			) : (
				<>
					{MARKS.map((t) => (
						<ToolButton key={t.name} tool={t} pressed={state.active.has(t.name)} onClick={() => t.run(editor)} />
					))}
					<ToolButton tool={LINK} pressed={state.href !== ""} onClick={() => setLinking(true)} />
					<Separator orientation="vertical" className="mx-0.5 my-1.5" />
					{BLOCKS.map((t) => (
						<ToolButton key={t.name} tool={t} pressed={state.active.has(t.name)} onClick={() => t.run(editor)} />
					))}
				</>
			)}
		</BubbleMenu>
	);
}

function ToolButton({ tool, pressed, onClick }: { tool: Omit<Tool, "run">; pressed: boolean; onClick: () => void }) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={tool.label}
						aria-pressed={pressed}
						// Keeps the selection, which clicking would otherwise move out of the editor.
						onMouseDown={(e) => e.preventDefault()}
						onClick={onClick}
						className="aria-pressed:bg-muted aria-pressed:text-foreground"
					>
						<tool.icon />
					</Button>
				}
			/>
			<TooltipContent>
				{tool.label} {tool.keys ? <span className="text-background/60">{tool.keys}</span> : null}
			</TooltipContent>
		</Tooltip>
	);
}

/** Enter links the selection to what's typed, or unlinks it when that's cleared; Escape goes back. */
function LinkField({ editor, href, onDone }: { editor: Editor; href: string; onDone: () => void }) {
	const done = (apply: (e: Editor) => void) => {
		apply(editor);
		onDone();
	};
	const unlink = (e: Editor) => e.chain().focus().extendMarkRange("link").unsetLink().run();
	return (
		<div className="flex items-center gap-0.5">
			<Input
				type="url"
				aria-label="Link address"
				defaultValue={href}
				placeholder="Paste a link"
				autoFocus
				className="h-7 w-60 border-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
				onKeyDown={(e) => {
					// Enter would otherwise submit a form the editor sits in (the composer's, sending the message).
					if (e.key === "Enter") {
						e.preventDefault();
						const url = e.currentTarget.value.trim();
						done((ed) => (url ? ed.chain().focus().extendMarkRange("link").setLink({ href: withProtocol(url) }).run() : unlink(ed)));
					} else if (e.key === "Escape") {
						e.preventDefault();
						done((ed) => ed.commands.focus());
					}
				}}
			/>
			{href ? (
				<Button variant="ghost" size="icon-sm" aria-label="Remove link" onMouseDown={(e) => e.preventDefault()} onClick={() => done(unlink)}>
					<UnlinkIcon />
				</Button>
			) : null}
		</div>
	);
}

/** "example.com" means https://example.com, and an address means mailing it. */
const withProtocol = (url: string) => (/^[a-z][\w+.-]*:/i.test(url) ? url : url.includes("@") && !url.includes("/") ? `mailto:${url}` : `https://${url}`);
