import { List, ListRow } from "@stackd/ui";
import { useNavigate } from "react-router";
import { ScreenHeader } from "../../app/layout/ScreenHeader.tsx";

/** Me → Groups & household. */
export function GroupsSettings() {
  const navigate = useNavigate();
  const go = (path: string) => (e: { preventDefault: () => void }) => {
    e.preventDefault();
    navigate(path);
  };
  return (
    <>
      <ScreenHeader title="Groups & household" actions={null} back="/me" />
      <List card>
        <ListRow
          label="Challenges & members"
          sublabel="Invite codes, share links, leave"
          href="/goals"
          onClick={go("/goals")}
        />
        <ListRow
          label="Split bills"
          sublabel="Your groups, who owes whom"
          href="/splits"
          onClick={go("/splits")}
        />
        <ListRow
          label="How friends pay me"
          sublabel="Your Venmo, Cash App or PayPal for your groups"
          href="/me/split-pay"
          onClick={go("/me/split-pay")}
        />
        <ListRow
          label="Payments I confirmed"
          sublabel="Each Check first before you paid someone"
          href="/me/split-payments"
          onClick={go("/me/split-payments")}
        />
        <ListRow
          label="Couples & household"
          sublabel="Invite your partner, shared jars, the month together"
          href="/me/household"
          onClick={go("/me/household")}
        />
      </List>
    </>
  );
}
