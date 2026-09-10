/**
 * Fixed desktop search pickers render outside their scroll containers. Keep
 * their option list inside the viewport while preserving the caller's width.
 */
export interface SearchPickerAnchor {
	left: number;
	top: number;
	bottom: number;
	width: number;
}

export interface SearchPickerLayout {
	dropdownStyle: string;
	listStyle: string;
	opensAbove: boolean;
}

const GAP = 2;
const DEFAULT_LIST_MAX_HEIGHT = 256;

export function fixedSearchPickerLayout(
	anchor: SearchPickerAnchor,
	menuHeight: number,
	viewportHeight: number,
	minimumWidth: number,
	listHeight = menuHeight,
): SearchPickerLayout {
	const spaceBelow = Math.max(0, viewportHeight - anchor.bottom - GAP);
	const spaceAbove = Math.max(0, anchor.top - GAP);
	const opensAbove = menuHeight > spaceBelow && (menuHeight <= spaceAbove || spaceAbove > spaceBelow);
	const availableHeight = opensAbove ? spaceAbove : spaceBelow;
	const needsHeightCap = menuHeight > availableHeight;
	const nonListHeight = Math.max(0, menuHeight - listHeight);
	const availableListHeight = Math.max(0, availableHeight - nonListHeight);
	const verticalPosition = opensAbove
		? `bottom:${Math.max(0, viewportHeight - anchor.top + GAP)}px;`
		: `top:${Math.max(0, anchor.bottom + GAP)}px;`;

	return {
		dropdownStyle: `position:fixed;left:${anchor.left}px;${verticalPosition}width:${Math.max(anchor.width, minimumWidth)}px;z-index:9999;`,
		listStyle: needsHeightCap ? `max-height:${Math.min(DEFAULT_LIST_MAX_HEIGHT, availableListHeight)}px;` : "",
		opensAbove,
	};
}
