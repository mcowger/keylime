// Load before AppShell so the sidebar can intercept popstate before deep-link restoration.
import { SIDEBAR_HISTORY_BRIDGE_SCRIPT } from "@/lib/sidebar-history-bridge";

const script = document.createElement("script");
script.textContent = SIDEBAR_HISTORY_BRIDGE_SCRIPT;
document.head.append(script);
