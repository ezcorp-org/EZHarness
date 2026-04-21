import type { Component } from 'svelte';
import SharedFilePicker from './SharedFilePicker.svelte';
import ComboBox from './ComboBox.svelte';
import SearchBox from './SearchBox.svelte';
import TagInput from './TagInput.svelte';
import DatePicker from './DatePicker.svelte';

export const formatComponentMap: Record<string, Component> = {
	'file-path': SharedFilePicker,
	'combo-box': ComboBox,
	'search': SearchBox,
	'tag-input': TagInput,
	'date': DatePicker,
	'datetime': DatePicker,
};

/** Returns the component for a format string, or throws on unrecognized formats. */
export function getFormatComponent(format: string): Component {
	const component = formatComponentMap[format];
	if (!component) {
		throw new Error(
			`Unrecognized input format: "${format}". Valid formats: ${Object.keys(formatComponentMap).join(', ')}`,
		);
	}
	return component;
}
