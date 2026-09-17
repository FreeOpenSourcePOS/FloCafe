'use client';

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${value ? 'bg-brand' : 'bg-gray-300 dark:bg-input'}`}
    >
      <span className={`absolute top-0.5 start-0.5 w-5 h-5 bg-card rounded-full shadow transition-transform ${value ? 'translate-x-5 rtl:-translate-x-5' : 'translate-x-0'}`} />
    </button>
  );
}
