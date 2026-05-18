import { SensitiveInput } from "@cloudflare/kumo";
import { useCallback, useState } from "react";

import type { BlockInteraction, SecretInputElement } from "../types.js";

export function SecretInputElementComponent({
	element,
	onAction,
	onChange,
}: {
	element: SecretInputElement;
	onAction: (interaction: BlockInteraction) => void;
	onChange?: (actionId: string, value: unknown) => void;
}) {
	const isReadOnly = element.initial_value !== undefined || element.readonly === true;
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(!element.has_value && !isReadOnly);

	const handleValueChange = useCallback(
		(v: string) => {
			setValue(v);
			if (onChange) {
				onChange(element.action_id, v);
			}
		},
		[onChange, element.action_id],
	);

	const handleFocus = useCallback(() => {
		if (!editing && !isReadOnly) {
			setEditing(true);
			setValue("");
		}
	}, [editing, isReadOnly]);

	const handleBlur = useCallback(() => {
		if (!onChange && value) {
			onAction({
				type: "block_action",
				action_id: element.action_id,
				value,
			});
		}
		if (!value && element.has_value) {
			setEditing(false);
		}
	}, [onChange, onAction, element.action_id, value, element.has_value]);

	// Read-only display with initial_value: pass real value so eye button reveals it
	if (element.initial_value !== undefined) {
		return (
			<SensitiveInput
				label={element.label}
				value={element.initial_value}
				readOnly
				placeholder={element.placeholder}
			/>
		);
	}

	if (!editing) {
		return (
			<SensitiveInput
				label={element.label}
				value={element.has_value ? "••••••••" : ""}
				readOnly={isReadOnly}
				onFocus={!isReadOnly ? handleFocus : undefined}
				placeholder={element.placeholder}
			/>
		);
	}

	return (
		<SensitiveInput
			label={element.label}
			value={value}
			onValueChange={handleValueChange}
			onFocus={handleFocus}
			onBlur={handleBlur}
			placeholder={element.placeholder}
		/>
	);
}
