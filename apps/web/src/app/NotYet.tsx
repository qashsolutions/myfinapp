import { Card } from "@stackd/ui";
import { Link } from "react-router";
import { ScreenHeader } from "./layout/ScreenHeader.tsx";

/** Honest placeholder for a screen that a later chunk delivers. */
export function ComingSoon({
  what,
  chunk,
  children,
}: {
  what: string;
  chunk: string;
  children?: string;
}) {
  return (
    <Card as="section" aria-label={`${what} is coming`}>
      <p className="sk-card__eyebrow">Coming in chunk {chunk}</p>
      <p>{children ?? `${what} is not built yet.`}</p>
    </Card>
  );
}

export function NotFound() {
  return (
    <>
      <ScreenHeader title="That page isn't here" actions={null} />
      <Card>
        <p>
          <Link to="/">Back to Home</Link>
        </p>
      </Card>
    </>
  );
}
