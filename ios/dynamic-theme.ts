import { DynamicColorIOS } from "react-native";
import { lightTheme, theme } from "./theme";

// Static StyleSheets and native controls resolve these against iOS appearance.
export const dynamicTheme = {
  background: DynamicColorIOS({
    dark: theme.background,
    light: lightTheme.background,
  }),
  panel: DynamicColorIOS({ dark: theme.panel, light: lightTheme.panel }),
  hover: DynamicColorIOS({ dark: theme.hover, light: lightTheme.hover }),
  border: DynamicColorIOS({ dark: theme.border, light: lightTheme.border }),
  text: DynamicColorIOS({ dark: theme.text, light: lightTheme.text }),
  muted: DynamicColorIOS({ dark: theme.muted, light: lightTheme.muted }),
  accent: DynamicColorIOS({ dark: theme.accent, light: lightTheme.accent }),
};
