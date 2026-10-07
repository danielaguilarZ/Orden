"use client";

/** Campo de configuración de una conexión, con su explicación y atajos («Todos mis repos»). */
export function ConnField({
  field,
  value,
  onChange,
}: {
  field: { key: string; label: string; placeholder?: string; hint?: string; presets?: { label: string; value: string }[] };
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="conn-field">
      <span>{field.label}</span>
      <span className="conn-field-row">
        <input value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />
        {field.presets?.map((p) => (
          <button key={p.value} type="button" className={`btn small${value === p.value ? " primary" : ""}`} onClick={() => onChange(p.value)}>
            {p.label}
          </button>
        ))}
      </span>
      {field.hint && <span className="hint">{field.hint}</span>}
    </label>
  );
}
