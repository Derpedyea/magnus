import { Radio } from "@base-ui/react/radio";
import { createFileRoute } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useId } from "react";
import { RadioGroup } from "@/components/ui/radio-group";
import { SettingsPage } from "../components/SettingsPage";
import { appearance, MODES, setMode, setTheme, THEMES, type Theme } from "../theme";

const MODE_ITEMS = [
	{ value: "system", label: "System", icon: MonitorIcon },
	{ value: "light", label: "Light", icon: SunIcon },
	{ value: "dark", label: "Dark", icon: MoonIcon },
] as const;

export const Route = createFileRoute("/_app/_settings/settings/appearance")({ component: Appearance });

/**
 * The mode, then a theme for each side the mode shows, after Zed, VS Code, and T3 Code. Per device, and applied
 * as it's picked, so arrowing through a theme grid previews each one on the whole app.
 */
function Appearance() {
	const mode = useSelector(appearance, (s) => s.mode);
	const light = useSelector(appearance, (s) => s.light);
	const dark = useSelector(appearance, (s) => s.dark);
	return (
		<SettingsPage title="Appearance">
			<div className="flex max-w-xl flex-col gap-6">
				<RadioGroup
					aria-label="Mode"
					value={mode}
					onValueChange={(value) => setMode(MODES.find((m) => m === value) ?? "system")}
					className="flex w-fit gap-0.5 rounded-lg bg-muted p-0.5"
				>
					{MODE_ITEMS.map((item) => (
						<Radio.Root
							key={item.value}
							value={item.value}
							className="flex h-7 cursor-default items-center gap-1.5 rounded-md px-3 text-muted-foreground outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:bg-background data-checked:text-foreground data-checked:shadow-sm [&_svg]:size-4"
						>
							<item.icon />
							{item.label}
						</Radio.Root>
					))}
				</RadioGroup>
				{mode !== "dark" ? <ThemeGrid label={mode === "system" ? "Light theme" : "Theme"} dark={false} value={light} /> : null}
				{mode !== "light" ? <ThemeGrid label={mode === "system" ? "Dark theme" : "Theme"} dark value={dark} /> : null}
			</div>
		</SettingsPage>
	);
}

function ThemeGrid(props: { label: string; dark: boolean; value: Theme["id"] }) {
	const labelId = useId();
	return (
		<section className="flex flex-col gap-2">
			<h2 id={labelId} className="font-medium">
				{props.label}
			</h2>
			<RadioGroup
				aria-labelledby={labelId}
				value={props.value}
				onValueChange={(value) => {
					const theme = THEMES.find((t) => t.id === value);
					if (theme) setTheme(theme);
				}}
				className="grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3"
			>
				{THEMES.filter((t) => t.dark === props.dark).map((theme) => (
					<Radio.Root key={theme.id} value={theme.id} className="group flex cursor-default flex-col gap-1.5 outline-none select-none">
						<ThemePreview theme={theme} />
						<span className="flex items-center gap-1 text-muted-foreground group-data-checked:font-medium group-data-checked:text-foreground">
							{theme.name}
							<CheckIcon className="hidden size-3.5 group-data-checked:block" />
						</span>
					</Radio.Root>
				))}
			</RadioGroup>
		</section>
	);
}

/**
 * The mail view in miniature, in the theme's own colours: sidebar with Compose, thread rows, and an open message.
 * The frame stays outside data-theme, so its outline and border are the app's.
 */
function ThemePreview({ theme }: { theme: Theme }) {
	return (
		<span
			aria-hidden
			className="flex h-20 overflow-hidden rounded-lg border outline-offset-2 group-hover:outline-1 group-hover:outline-border group-focus-visible:ring-3 group-focus-visible:ring-ring/50 group-data-checked:outline-2 group-data-checked:outline-primary"
		>
			<span data-theme={theme.id} className="flex flex-1 bg-background">
				<span className="flex w-1/3 flex-col gap-1 border-r bg-sidebar p-1.5">
					<span className="h-2.5 rounded-sm bg-primary" />
					<span className="h-2 rounded-sm bg-sidebar-accent" />
					<span className="mx-1 h-1 rounded-full bg-sidebar-foreground/25" />
					<span className="mx-1 h-1 w-2/3 rounded-full bg-sidebar-foreground/25" />
				</span>
				<span className="flex flex-1 flex-col gap-1 p-1.5">
					<span className="flex items-center gap-1">
						<span className="size-1.5 rounded-full bg-sky-500" />
						<span className="h-1 w-1/2 rounded-full bg-foreground/70" />
					</span>
					<span className="h-1 w-3/4 rounded-full bg-muted-foreground/50" />
					<span className="mt-auto flex flex-col gap-1 rounded-sm border bg-card p-1.5">
						<span className="h-1 w-2/3 rounded-full bg-card-foreground/70" />
						<span className="h-1 w-5/6 rounded-full bg-muted-foreground/50" />
					</span>
				</span>
			</span>
		</span>
	);
}
