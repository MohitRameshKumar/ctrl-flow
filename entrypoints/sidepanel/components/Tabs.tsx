export const TAB_NAMES = ['Rituals', 'Spaces', 'Macros', 'Standup'] as const;
export type TabName = (typeof TAB_NAMES)[number];

export interface TabsProps {
  active: TabName;
  onChange: (tab: TabName) => void;
}

export function Tabs({ active, onChange }: TabsProps) {
  return (
    <nav className="tabs">
      {TAB_NAMES.map((name) => (
        <button
          key={name}
          className={name === active ? 'tab active' : 'tab'}
          onClick={() => onChange(name)}
        >
          {name}
        </button>
      ))}
    </nav>
  );
}
