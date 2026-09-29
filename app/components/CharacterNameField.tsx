import { IconDice } from "@tabler/icons-react";
import { useId } from "react";
import { MAX_CHARACTER_NAME_LENGTH } from "../lib/characterName";
import { randomCharacterName } from "../lib/randomCharacterName";
import { SYSTEM_MONO } from "./door";

export function CharacterNameField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (name: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex w-full flex-col gap-1">
      <label htmlFor={id} className="text-[10px] uppercase tracking-widest text-paper/60">
        Name
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className="min-w-0 flex-1 border-2 border-paper/40 bg-transparent px-3 py-2 text-base text-paper placeholder:text-paper/30 focus:border-paper focus:outline-none disabled:opacity-50"
          style={{ fontFamily: SYSTEM_MONO }}
          autoFocus
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          maxLength={MAX_CHARACTER_NAME_LENGTH}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label="Randomise"
          title="Randomise"
          className="flex w-11 shrink-0 items-center justify-center border-2 border-paper/40 text-paper hover:border-paper hover:bg-paper hover:text-ink disabled:opacity-50"
          disabled={disabled}
          onClick={() => onChange(randomCharacterName())}
        >
          <IconDice size={20} stroke={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
