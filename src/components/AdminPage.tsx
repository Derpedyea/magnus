/** An admin page: its title, the one action that adds things, and the list. */
export function AdminPage(props: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
			<div className="flex min-h-8 items-center justify-between gap-4">
				<h1 className="font-heading text-base font-semibold">{props.title}</h1>
				{props.action}
			</div>
			{props.children}
		</div>
	);
}
