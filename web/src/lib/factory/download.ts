export function downloadFactorySource(factoryId: string, format: "json" | "yaml", source: string): void {
	const url = URL.createObjectURL(new Blob([source], { type: format === "json" ? "application/json" : "application/yaml" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = factoryId + "." + format;
	link.click();
	URL.revokeObjectURL(url);
}
