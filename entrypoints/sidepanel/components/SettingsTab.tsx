import { FocusFlipSection } from './FocusFlipSection';
import { LeaderKeysSection } from './LeaderKeysSection';
import { PrivacySettings } from './PrivacySettings';
import { SettingsPanel, type SettingsPanelProps } from './SettingsPanel';
import { Group } from './ui';

/** Everything that is configuration rather than content lives here, grouped so each tab shows only its own. */
export function SettingsTab(props: SettingsPanelProps) {
  return (
    <div className="settings-tab">
      <Group title="Shortcuts">
        <LeaderKeysSection />
      </Group>
      <Group title="Focus Flip">
        <FocusFlipSection />
      </Group>
      <Group title="Privacy">
        <PrivacySettings />
      </Group>
      <Group title="General" defaultOpen={false}>
        <SettingsPanel {...props} />
      </Group>
    </div>
  );
}
