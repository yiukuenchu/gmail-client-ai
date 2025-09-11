"use client";

import { ThreadList } from "../_components/thread-list";

export default function DraftsPage() {
  return (
    <div className="h-full">
      <div className="p-6 border-b">
        <h1 className="text-xl font-semibold text-gray-900">Drafts</h1>
      </div>
      <ThreadList labelId="DRAFT" />
    </div>
  );
}