import { SetupView } from '@/components/knowledge/SetupView';

export const metadata = { title: 'Set up · Estimates AI Agent' };

/** First run: upload at least one priced estimate; chat unlocks once one is analysed. */
export default function SetupPage() {
  return <SetupView />;
}
