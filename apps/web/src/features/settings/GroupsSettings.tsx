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
          label="Couples & household"
          sublabel="Invite your partner, shared jars, the month together"
          href="/me/household"
          onClick={go("/me/household")}
        />
      </List>
    </>
  );
}
