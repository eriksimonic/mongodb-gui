import { useAppStore } from '../../state/app-store-context';

/** Used before the saved settings load, and while the vault is locked. */
const DEFAULT_EDITOR_FONT_SIZE = 13;

/** The saved editor font size plus an offset, so an editor can sit a few pixels off the base size. */
export function useEditorFontSize(offset = 0): number {
  return (
    useAppStore((state) => state.settings?.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE) + offset
  );
}
