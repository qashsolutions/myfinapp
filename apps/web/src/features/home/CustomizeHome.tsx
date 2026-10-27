import { CustomizeCards } from "../../app/layout/CustomizeCards.tsx";
import { HOME_CARDS, type HomeLayout } from "./homeLayout.ts";

/**
 * Customize Home (owner decision, October 19, 2026), through the shared sheet every screen uses
 * since October 25, 2026. Low-balance warnings still show when Next move is off.
 */
export function CustomizeHome({
  open,
  onClose,
  layout,
}: {
  open: boolean;
  onClose: () => void;
  layout: HomeLayout;
}) {
  return (
    <CustomizeCards
      screen="home"
      title="Customize Home"
      listLabel="Home cards, in order"
      cards={HOME_CARDS}
      open={open}
      onClose={onClose}
      layout={layout}
      note="Low-balance warnings always show, even with Next move off."
    />
  );
}
