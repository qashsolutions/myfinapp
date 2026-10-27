import { BrowserRouter } from "react-router";
import { SessionProvider } from "../features/auth/useSession.tsx";
import { AppRoutes } from "./routes.tsx";
import { ThemeProvider } from "./ThemeProvider.tsx";

export function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </SessionProvider>
    </ThemeProvider>
  );
}
