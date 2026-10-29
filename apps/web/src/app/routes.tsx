import { Navigate, Route, Routes } from "react-router";
import { LinkWithPhone } from "../features/auth/LinkWithPhone.tsx";
import { OtpEntry } from "../features/auth/OtpEntry.tsx";
import { SignIn } from "../features/auth/SignIn.tsx";
import { Welcome } from "../features/auth/Welcome.tsx";
import { ChooseTrial } from "../features/billing/ChooseTrial.tsx";
import { PlanScreen } from "../features/billing/PlanScreen.tsx";
import { BillsScreen } from "../features/bills/BillsScreen.tsx";
import { BudgetScreen } from "../features/budget/BudgetScreen.tsx";
import { CategoriesScreen } from "../features/categories/CategoriesScreen.tsx";
import { CreditHabitsScreen } from "../features/credit/CreditHabits.tsx";
import { EmergencyScreen } from "../features/emergency/EmergencyScreen.tsx";
import { AddEntrySheet } from "../features/entries/AddEntrySheet.tsx";
import { TagDetail, TagsScreen } from "../features/entries/TagScreens.tsx";
import { ForecastScreen } from "../features/forecast/ForecastScreen.tsx";
import { GoalBuilder } from "../features/goals/GoalBuilder.tsx";
import { GoalDetail } from "../features/goals/GoalDetail.tsx";
import { GoalsList } from "../features/goals/GoalsList.tsx";
import { ChallengeDetail } from "../features/groups/ChallengeDetail.tsx";
import { CreateGroup } from "../features/groups/CreateGroup.tsx";
import { JoinGroup } from "../features/groups/JoinGroup.tsx";
import { HomeScreen } from "../features/home/HomeScreen.tsx";
import { HouseholdScreen } from "../features/household/HouseholdScreen.tsx";
import { JoinHousehold } from "../features/household/JoinHousehold.tsx";
import { ImportFlow } from "../features/imports/ImportFlow.tsx";
import { InsightsHub } from "../features/insights/InsightsHub.tsx";
import { SpendingScreen } from "../features/insights/SpendingScreen.tsx";
import { LaterScreen } from "../features/later/LaterScreen.tsx";
import { LinkDone } from "../features/linking/LinkDone.tsx";
import { LinkedAccounts } from "../features/linking/LinkedAccounts.tsx";
import { MoneyScreen } from "../features/money/MoneyScreen.tsx";
import { NetWorthScreen } from "../features/networth/NetWorthScreen.tsx";
import { NotificationSettings } from "../features/notifications/NotificationSettings.tsx";
import { SetupHub } from "../features/onboarding/SetupHub.tsx";
import { InstallScreen } from "../features/pwa/InstallScreen.tsx";
import { WeeklyRecap } from "../features/recap/WeeklyRecap.tsx";
import { ReviewScreen } from "../features/review/ReviewScreen.tsx";
import { LinkDevice, LinkGate } from "../features/security/LinkDevice.tsx";
import { PasskeySetup } from "../features/security/PasskeySetup.tsx";
import { SecurityScreen } from "../features/security/SecurityScreen.tsx";
import { AccountSettings } from "../features/settings/AccountSettings.tsx";
import { AccountsManager } from "../features/settings/AccountsManager.tsx";
import { ChangeEmail } from "../features/settings/ChangeEmail.tsx";
import { DataSettings } from "../features/settings/DataSettings.tsx";
import { DeleteAccount } from "../features/settings/DeleteAccount.tsx";
import { DeletedScreen } from "../features/settings/DeletedScreen.tsx";
import { GroupsSettings } from "../features/settings/GroupsSettings.tsx";
import { HelpSettings } from "../features/settings/HelpSettings.tsx";
import { KeptOnPhone } from "../features/settings/KeptOnPhone.tsx";
import { LookSettings } from "../features/settings/LookSettings.tsx";
import { MeLayout } from "../features/settings/MeLayout.tsx";
import { SettingsScreen } from "../features/settings/SettingsScreen.tsx";
import { SubscriptionsScreen } from "../features/subscriptions/SubscriptionsScreen.tsx";
import { AppShell } from "./layout/AppShell.tsx";
import { NotFound } from "./NotYet.tsx";
import { PublicOnly, RequireAuth } from "./RequireAuth.tsx";

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="welcome" element={<Welcome />} />
        <Route path="signin" element={<SignIn />} />
        <Route path="signin/code" element={<OtpEntry />} />
        <Route path="signin/phone" element={<LinkWithPhone />} />
      </Route>
      <Route path="signup/passkey" element={<PasskeySetup />} />
      {/* No guard: shown right after deletion, when the session is already gone. */}
      <Route path="deleted" element={<DeletedScreen />} />
      {/* A plan that ended: the account closed, the data kept on this device (October 20, 2026). */}
      <Route path="kept" element={<KeptOnPhone />} />
      {/* The website's "Install the app" lands here; no sign-in needed (October 19, 2026). */}
      <Route path="install" element={<InstallScreen />} />
      {/* Link a device (B3): the approval screen signed in, how to reach it signed out. */}
      <Route path="link" element={<LinkGate />}>
        <Route element={<AppShell />}>
          <Route index element={<LinkDevice />} />
        </Route>
      </Route>
      <Route element={<RequireAuth />}>
        <Route path="start" element={<ChooseTrial />} />
        <Route element={<AppShell />}>
          <Route index element={<HomeScreen />} />
          <Route path="budget" element={<BudgetScreen />} />
          <Route path="goals" element={<GoalsList />} />
          <Route path="goals/new" element={<GoalBuilder />} />
          <Route path="goals/:id" element={<GoalDetail />} />
          <Route path="groups/new" element={<CreateGroup />} />
          <Route path="groups/join" element={<JoinGroup />} />
          <Route path="groups/:id" element={<ChallengeDetail />} />
          <Route path="insights" element={<InsightsHub />} />
          <Route path="insights/spending" element={<SpendingScreen />} />
          <Route path="subscriptions" element={<SubscriptionsScreen />} />
          <Route path="credit-habits" element={<CreditHabitsScreen />} />
          <Route path="insights/later" element={<LaterScreen />} />
          <Route path="review" element={<ReviewScreen />} />
          <Route path="net-worth" element={<NetWorthScreen />} />
          <Route path="setup" element={<SetupHub />} />
          <Route path="tags" element={<TagsScreen />} />
          <Route path="tags/:tag" element={<TagDetail />} />
          {/* Learn became Insights (October 18, 2026); old links land there. */}
          <Route path="learn" element={<Navigate to="/insights" replace />} />
          <Route path="learn/:slug" element={<Navigate to="/insights" replace />} />
          <Route path="me" element={<MeLayout />}>
            <Route index element={<SettingsScreen />} />
            <Route path="account" element={<AccountSettings />} />
            <Route path="data" element={<DataSettings />} />
            <Route path="groups" element={<GroupsSettings />} />
            <Route path="look" element={<LookSettings />} />
            <Route path="help" element={<HelpSettings />} />
            <Route path="security" element={<SecurityScreen />} />
            <Route path="accounts" element={<AccountsManager />} />
            <Route path="categories" element={<CategoriesScreen />} />
            <Route path="email" element={<ChangeEmail />} />
            <Route path="delete" element={<DeleteAccount />} />
            <Route path="notifications" element={<NotificationSettings />} />
            <Route path="plan" element={<PlanScreen />} />
            <Route path="household" element={<HouseholdScreen />} />
            <Route path="linking" element={<LinkedAccounts />} />
            <Route path="linking/done" element={<LinkDone />} />
          </Route>
          <Route path="household/join" element={<JoinHousehold />} />
          <Route path="add" element={<AddEntrySheet />} />
          <Route path="entries" element={<Navigate to="/money?view=transactions" replace />} />
          <Route path="money" element={<MoneyScreen />} />
          <Route path="recap" element={<WeeklyRecap />} />
          <Route path="forecast" element={<ForecastScreen />} />
          <Route path="bills" element={<BillsScreen />} />
          <Route path="emergency" element={<EmergencyScreen />} />
          <Route path="import" element={<ImportFlow />} />
          <Route path="entries/:id" element={<AddEntrySheet />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
