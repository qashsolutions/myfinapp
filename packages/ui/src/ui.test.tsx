import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  Button,
  buttonClass,
  Card,
  Chip,
  List,
  ListRow,
  ProgressBar,
  SentenceBuilder,
  Sheet,
  Toggle,
} from "./index.ts";

describe("Button", () => {
  it("is type=button by default, with variant and size classes", () => {
    render(
      <Button variant="secondary" size="sm">
        Go
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Go" });
    expect(b).toHaveAttribute("type", "button");
    expect(b.className).toContain("sk-btn--secondary");
    expect(b.className).toContain("sk-btn--sm");
  });
  it("buttonClass gives links the same look", () => {
    expect(buttonClass({ variant: "ghost", block: true })).toBe(
      "sk-btn sk-btn--ghost sk-btn--block",
    );
  });
});

describe("Card and Chip", () => {
  it("renders the hero tone and decor marker", () => {
    const { container } = render(
      <Card tone="accent" decor as="section" aria-label="Hero">
        <Chip tone="pending">Pending</Chip>
      </Card>,
    );
    const card = container.querySelector("section");
    expect(card?.className).toContain("sk-card--accent");
    expect(card?.className).toContain("sk-decor");
    expect(screen.getByText("Pending").className).toContain("sk-chip--pending");
  });
});

describe("ListRow", () => {
  it("is plain text by default, a button with onClick, a link with href", () => {
    const onClick = vi.fn();
    render(
      <List>
        <ListRow label="Plain" value="1" />
        <ListRow label="Press" onClick={onClick} />
        <ListRow label="Open" href="/x" sublabel="more" />
      </List>,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Plain 1" })).toBeNull();
    screen.getByRole("button", { name: "Press" }).click();
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: /Open/ })).toHaveAttribute("href", "/x");
  });
});

describe("ProgressBar", () => {
  it("exposes a text equivalent and clamps", () => {
    render(<ProgressBar fraction={0.69} label="Travel jar" valueText="69% of $600" showText />);
    const bar = screen.getByRole("progressbar", { name: "Travel jar" });
    expect(bar).toHaveAttribute("aria-valuenow", "69");
    expect(bar).toHaveAttribute("aria-valuetext", "69% of $600");
    expect(screen.getByText("69% of $600")).toBeInTheDocument();
    render(<ProgressBar fraction={1.7} label="Done" valueText="100%" />);
    const done = screen.getByRole("progressbar", { name: "Done" });
    expect(done).toHaveAttribute("aria-valuenow", "100");
    expect(done.className).toContain("sk-progress__track--success");
  });

  it("draws marks as ticks, names them in the text equivalent, and labels them on request", () => {
    render(
      <ProgressBar
        fraction={0.5}
        label="Dining"
        valueText="$100 of $200"
        marks={[
          { at: 0.9, label: "Tell me at 90%" },
          { at: 1.2, label: "Plan" },
        ]}
        showMarkLabels
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Dining" });
    expect(bar).toHaveAttribute("aria-valuetext", "$100 of $200 · Tell me at 90% · Plan");
    const ticks = bar.parentElement?.querySelectorAll<HTMLElement>(".sk-progress__mark") ?? [];
    // Clamped to the track.
    expect([...ticks].map((t) => t.style.left)).toEqual(["90%", "100%"]);
    expect(screen.getByText("Tell me at 90%")).toHaveClass("sk-progress__mark-label--end");
  });
});

describe("Toggle", () => {
  function Harness() {
    const [on, setOn] = useState(false);
    return (
      <Toggle checked={on} onChange={setOn} label="Simple layout" description="Lists, no tiles" />
    );
  }
  it("is a switch with a label and description, toggled by click and keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Simple layout" });
    expect(sw).toHaveAccessibleDescription("Lists, no tiles");
    expect(sw).not.toBeChecked();
    await user.click(screen.getByText("Simple layout"));
    expect(sw).toBeChecked();
    sw.focus();
    await user.keyboard(" ");
    expect(sw).not.toBeChecked();
  });
});

describe("Sheet", () => {
  it("is a labelled modal dialog that closes on Escape and the scrim", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet open onClose={onClose} title="Confirm it's you">
        <button type="button">Confirm</button>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Confirm it's you" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Sheet open={false} onClose={onClose} title="Confirm it's you">
        <button type="button">Confirm</button>
      </Sheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps focus in an input while typing even when onClose changes every render", async () => {
    const user = userEvent.setup();
    function Host() {
      const [text, setText] = useState("");
      return (
        <Sheet open onClose={() => setText("")} title="Name it">
          <button type="button">First</button>
          <label>
            Name
            <input value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </Sheet>
      );
    }
    render(<Host />);
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    await user.type(screen.getByLabelText("Name"), "Laptop");
    expect(screen.getByLabelText("Name")).toHaveValue("Laptop");
  });
});

describe("SentenceBuilder", () => {
  it("renders words and tappable blanks with accessible names", async () => {
    const user = userEvent.setup();
    const onAmount = vi.fn();
    render(
      <SentenceBuilder
        parts={[
          "Save ",
          { key: "amount", label: "$2,000", change: "Change amount", onClick: onAmount },
          " for ",
          { key: "what", label: "Travel", change: "Change what it's for", onClick: () => {} },
        ]}
      />,
    );
    expect(screen.getByText("Tap a highlighted word to change it")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Change amount" }));
    expect(onAmount).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Change what it's for" })).toHaveTextContent(
      "Travel",
    );
  });
});
