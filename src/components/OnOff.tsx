/** A yes/no status: a dot and a word, so it doesn't rely on colour alone. With a label: "Sending off". */
export function OnOff(props: { on: boolean; label?: string }) {
	const word = props.on ? "On" : "Off";
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className={`size-1.5 rounded-full ${props.on ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
			<span className={props.on ? undefined : "text-muted-foreground"}>{props.label ? `${props.label} ${word.toLowerCase()}` : word}</span>
		</span>
	);
}
