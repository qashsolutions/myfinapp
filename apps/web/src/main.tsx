import "@fontsource/outfit/400.css";
import "@fontsource/outfit/500.css";
import "@fontsource/outfit/600.css";
import "@fontsource/outfit/700.css";
import "./styles/base.css";

import { registerSW } from "virtual:pwa-register";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { CrashScreen } from "./app/CrashScreen.tsx";
import { recordVisit, watchInstallPrompt } from "./pwa/install.ts";
import { createUpdateStore, setUpdateStore } from "./pwa/updates.ts";

// Updates wait for the user ("A new version is ready. Refresh"); the install guide offers
// itself after the second visit, never inside the installed app.
setUpdateStore(createUpdateStore(registerSW));
watchInstallPrompt();
recordVisit();

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
  </StrictMode>,
);
