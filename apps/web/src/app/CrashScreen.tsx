import { Button, Card } from "@stackd/ui";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Word } from "./layout/Word.tsx";

/**
 * When a screen throws, show a way out instead of a blank page (October 25, 2026). Nothing is
 * sent anywhere: the error stays on this device (the browser console), and what's stored here is
 * untouched. `AppShell` wraps the screen area, keyed by the path, so the tab bar still works and
 * moving to another screen starts fresh; `main.tsx` wraps the whole app as the last resort.
 */
export class CrashScreen extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Qash: a screen stopped working", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Card as="section" aria-label="Something went wrong" className="crash">
        <Word>Stuck</Word>
        <h1 className="sk-card__hero">Something went wrong</h1>
        <p>This screen stopped working. Your data is safe on this device. Reload to try again.</p>
        <Button onClick={() => window.location.reload()}>Reload</Button>
      </Card>
    );
  }
}
