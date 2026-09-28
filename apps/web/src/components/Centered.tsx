export function Centered({ children }: { children: React.ReactNode }) {
	return <div className="flex h-full items-center justify-center p-8 text-muted-foreground">{children}</div>;
}
