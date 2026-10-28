export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: "Is there a free plan?",
    a: "There's a free trial instead: Private or Connected free for 3 days, no card needed to start. Near the end we ask if you'd like to keep Qash and email you the day before. If you don't choose a plan, the app locks for 7 days so you can subscribe or download your data, with a short note each day; then the account closes and what we kept is deleted. What's on your device stays there until you download or erase it.",
  },
  {
    q: "Do you connect to my bank?",
    a: "Only if you choose Connected. Linking is read-only through Plaid: you sign in on your bank's own page, we never see your password, and nothing can move money. On Private you upload a CSV, OFX or PDF statement or add spending by hand, and that data stays on your device.",
  },
  {
    q: "Where is my money data kept?",
    a: "On your device. Statements, receipts, transactions, budgets and jars live in the app's storage there. Our servers hold only what the service needs, such as your account, plan, challenge percentages, a minimal alert schedule and, if you turn it on, an encrypted backup we cannot read. On Connected, transactions from your bank pass through our server to your device without being stored; we keep only an encrypted access token. The full list is in the privacy policy.",
  },
  {
    q: "What does the encrypted backup actually encrypt?",
    a: "Your accounts, entries, categories, budgets, jars, goals, bills, debts and settings. Statement files, receipt photos and linked card details stay on the device they were added on, and the app works out its figures again on each device. The key is made on your device; we store copies wrapped under your recovery key and, where your browser supports it, your passkey. Lose both and the backup cannot be restored.",
  },
  {
    q: "Is there AI reading my transactions?",
    a: 'No AI service ever sees your data. Every number comes from plain, versioned rules that run on your device. Category suggestions come from a small fixed model we built and ship inside the app, and "Read text from photo" on a receipt uses an open-source text reader; both run on your device and send nothing anywhere. There are no AI services in the app or on our servers.',
  },
  {
    q: "Do jars move my money?",
    a: "No. A jar is a label on money you set aside. Logging a deposit records it in the app; your money stays where it is.",
  },
  {
    q: "What do other people in a savings challenge see?",
    a: "Your display name and your percentage of your own target. Never your amounts, never your email.",
  },
  {
    q: "How do I cancel my plan?",
    a: "In the app: Me → Plan → Cancel plan, then confirm. Your plan stays on until the end of the period you paid for. Then you have 7 days to subscribe again or download your data; after that, the account closes and what we kept is deleted. What's on your device stays there until you download or erase it.",
  },
  {
    q: "Which cards do you accept?",
    a: "A credit or debit card issued by a US bank (Visa, Mastercard, Amex or Discover), entered directly or through Apple Pay, Google Pay or Link, or a US bank account. Cards from other countries are declined. A bank payment takes up to 4 business days to clear, and your plan starts when it does. Payments go through Stripe; we never see your card or bank details.",
  },
  {
    q: "Can I switch plans?",
    a: "Yes, in the app: Me → Plan. Switching up starts at once and you pay only the difference for the time left. Switching down starts at once too, from 30 days after you start or last switch, and the unused part becomes credit for your next bills. Switching down to Private disconnects linked banks, because Private never links.",
  },
  {
    q: "Do I get money back if I delete my account?",
    a: "Yes. Your plan ends at once. On a yearly plan, the months you used, this one included, cost the monthly price, and the rest of what you paid for the year comes back to your card, plus any credit, less Stripe's card fee (2.9% + 30¢), which Stripe keeps on a refund. The app shows the amount before you confirm.",
  },
  {
    q: "How do I delete my account?",
    a: "In the app: Me → Delete account, then confirm. Or use the Delete your account page on this site if you cannot open the app. Deleting in the app erases that device's copy at once; any other device you used erases its copy the next time the app opens there, if that's within 30 days; after that, delete the app or clear its data on that device.",
  },
  {
    q: "Is this financial advice?",
    a: "No. Qash does arithmetic on your own numbers; it doesn't give financial, tax or legal advice.",
  },
];
