import { List, ListRow, Sheet } from "@stackd/ui";
import { useNavigate } from "react-router";

/** What the global + button offers (docs/spec.md: manual entry, receipt photo, statement import). */
export function AddChooser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const go = (path: string) => {
    onClose();
    navigate(path);
  };
  return (
    <Sheet open={open} onClose={onClose} title="What do you want to add?">
      <List>
        <ListRow
          label="An entry"
          sublabel="Something you spent or earned"
          onClick={() => go("/add")}
          chevron
        />
        <ListRow
          label="A statement"
          sublabel="CSV, OFX, QFX or PDF from your bank, read on this device"
          onClick={() => go("/import")}
          chevron
        />
        <ListRow
          label="A receipt"
          sublabel="A photo, kept on this device"
          onClick={() => go("/add?with=receipt")}
          chevron
        />
      </List>
    </Sheet>
  );
}
