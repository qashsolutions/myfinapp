import { Button } from "@stackd/ui";
import { type ReactNode, useState } from "react";
import { CustomizeCards } from "./CustomizeCards.tsx";
import { type CardSpec, shownCards, useCardLayout } from "./cardLayout.ts";

/**
 * A screen's cards in the person's order, with "Customize" under them (owner decision, October
 * 25, 2026: every screen can be arranged). `render` draws one card by id, or null when it has
 * nothing to show right now; switched-off cards are never drawn.
 */
export function Arranged<Id extends string>({
  screen,
  name,
  cards,
  render,
}: {
  /** Settings key prefix: `<screen>.layout`. */
  screen: string;
  /** What the person calls the screen, as in "Customize Insights". */
  name: string;
  cards: readonly CardSpec<Id>[];
  render: (id: Id) => ReactNode;
}) {
  const layout = useCardLayout(screen, cards);
  const [open, setOpen] = useState(false);
  return (
    <>
      {shownCards(layout).map((id) => (
        <Slot key={id}>{render(id)}</Slot>
      ))}
      {layout.ready ? (
        <Button
          variant="ghost"
          size="sm"
          className="arranged__customize"
          onClick={() => setOpen(true)}
        >
          Customize {name}
        </Button>
      ) : null}
      <CustomizeCards
        screen={screen}
        title={`Customize ${name}`}
        listLabel={`${name} cards, in order`}
        cards={cards}
        open={open}
        onClose={() => setOpen(false)}
        layout={layout}
      />
    </>
  );
}

function Slot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
