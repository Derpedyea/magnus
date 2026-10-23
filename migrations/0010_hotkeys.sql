-- Each person's rebound keyboard shortcuts (Settings › Keyboard shortcuts), so they follow them to every device. Only
-- the ones changed from the defaults, as JSON keyed by shortcut id, so everyone still gets new defaults.
CREATE TABLE custom_hotkeys (
	user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
	value TEXT NOT NULL
);
