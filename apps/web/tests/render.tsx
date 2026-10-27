import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "../src/app/routes.tsx";
import { ThemeProvider } from "../src/app/ThemeProvider.tsx";
import { SessionProvider } from "../src/features/auth/useSession.tsx";

/** The app as main.tsx mounts it, minus the browser router. */
export function renderApp(path: string) {
  return render(
    <ThemeProvider>
      <SessionProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </SessionProvider>
    </ThemeProvider>,
  );
}
