import { ThreadList } from "./_components/thread-list";

export default function DashboardPage() {
  return (
    <div className="h-full">
      <div className="p-6 border-b">
        <h1 className="text-xl font-semibold text-gray-900">Inbox</h1>
      </div>
      <ThreadList labelId="INBOX" />
    </div>
  );
}