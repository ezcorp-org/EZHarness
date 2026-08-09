import type { Component } from 'svelte';
import SharedFilePicker from './SharedFilePicker.svelte';
import ComboBox from './ComboBox.svelte';
import SearchBox from './SearchBox.svelte';
import TagInput from './TagInput.svelte';
import DatePicker from './DatePicker.svelte';

// The five widgets accept different, mutually incompatible prop shapes — only
// the bindable `value` is common (SharedFilePicker takes `absolute`, ComboBox
// and friends take `options`, …) — and each call site passes its own superset.
// Any narrower `Props`/`Exports` here would reject every entry in the map AND
// every consumer's `<FormatComp …>` spread, so the two slots stay open and the
// bindable name (`'value'`) carries the only contract that is actually shared.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous widget props; only the bindable `value` is common, so the Props/Exports slots stay open (see the note above).
export const formatComponentMap: Record<string, Component<any, any, 'value'>> = {
	'file-path': SharedFilePicker,
	'combo-box': ComboBox,
	'search': SearchBox,
	'tag-input': TagInput,
	'date': DatePicker,
	'datetime': DatePicker,
};

/** Returns the component for a format string, or throws on unrecognized formats. */
// biome-ignore lint/suspicious/noExplicitAny: same heterogeneous-props reason as formatComponentMap above — this returns one of its values unchanged.
export function getFormatComponent(format: string): Component<any, any, 'value'> {
	const component = formatComponentMap[format];
	if (!component) {
		throw new Error(
			`Unrecognized input format: "${format}". Valid formats: ${Object.keys(formatComponentMap).join(', ')}`,
		);
	}
	return component;
}
