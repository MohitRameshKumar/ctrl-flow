export const TAB_NAMES = ['Rituals', 'Spaces', 'Macros', 'Standup', 'Settings'] as const;
export type TabName = (typeof TAB_NAMES)[number];

export interface TabsProps {
  active: TabName;
  onChange: (tab: TabName) => void;
}

export function Tabs({ active, onChange }: TabsProps) {
  return (
    <nav className="tabs" role="tablist">
      {TAB_NAMES.map((name) => (
        <button
          key={name}
          role="tab"
          aria-selected={name === active}
          className={name === active ? 'tab active' : 'tab'}
          onClick={() => onChange(name)}
        >
          {name}
        </button>
      ))}
    </nav>
  );
}
