export type ComponentSize = 'sm' | 'md';

export interface SharedComponentProps {
	value: string;
	size?: ComponentSize;
	disabled?: boolean;
	placeholder?: string;
	options?: Record<string, unknown>;
	onchange?: (value: string | string[]) => void;
}
