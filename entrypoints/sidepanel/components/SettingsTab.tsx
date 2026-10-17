import { FocusFlipSection } from './FocusFlipSection';
import { LeaderKeysSection } from './LeaderKeysSection';
import { PrivacySettings } from './PrivacySettings';
import { SettingsPanel, type SettingsPanelProps } from './SettingsPanel';

/** Everything that is configuration rather than content lives here, so the other tabs show only their own. */
export function SettingsTab(props: SettingsPanelProps) {
  return (
    <div className="settings-tab">
      <LeaderKeysSection />
      <FocusFlipSection />
      <PrivacySettings />
      <SettingsPanel {...props} />
    </div>
  );
}
