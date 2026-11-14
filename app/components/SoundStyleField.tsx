import { NOISE_STYLE_LABELS, NOISE_STYLES, type NoiseStyle } from "../lib/noiseStyle";
import { FieldLabel, Select } from "../ui";

const AUTO_VALUE = "";

const OPTIONS = [
  { value: AUTO_VALUE, label: "Auto" },
  ...NOISE_STYLES.map((style) => ({ value: style, label: NOISE_STYLE_LABELS[style] })),
];

function isNoiseStyle(value: string): value is NoiseStyle {
  return (NOISE_STYLES as readonly string[]).includes(value);
}

export function SoundStyleField({
  value,
  onChange,
}: {
  value: NoiseStyle | undefined;
  onChange: (style: NoiseStyle | undefined) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <FieldLabel info="How the sound moves on screen. Pop snaps in letter by letter, loud swells and settles, wavy rolls, shake trembles, whisper fades in small. Auto reads it from the text: *BOOM* is loud, *sssk* is wavy, anything else pops.">
        Sound style
      </FieldLabel>
      <Select
        className="w-32"
        ariaLabel="Sound style"
        value={value ?? AUTO_VALUE}
        onValueChange={(style) => onChange(style && isNoiseStyle(style) ? style : undefined)}
        options={OPTIONS}
      />
    </label>
  );
}
