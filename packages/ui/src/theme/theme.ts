import { createTheme } from '@mantine/core';

/** Dark first. Compact controls and spacing so the tree and dialogs fit a small window. */
export const appTheme = createTheme({
  primaryColor: 'blue',
  defaultRadius: 'sm',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  spacing: { xs: '4px', sm: '6px', md: '10px', lg: '14px', xl: '20px' },
  components: {
    ActionIcon: { defaultProps: { size: 'sm', variant: 'subtle' } },
    Button: { defaultProps: { size: 'xs' } },
    ColorInput: { defaultProps: { size: 'xs' } },
    NumberInput: { defaultProps: { size: 'xs' } },
    PasswordInput: { defaultProps: { size: 'xs' } },
    Select: { defaultProps: { size: 'xs' } },
    SegmentedControl: { defaultProps: { size: 'xs' } },
    TextInput: { defaultProps: { size: 'xs' } },
    Textarea: { defaultProps: { size: 'xs' } },
  },
});
